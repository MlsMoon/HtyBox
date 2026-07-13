// htyenv/dashboard.rs —— 仪表盘全景聚合与分页查询(plan-4 Step 3)。
// 性能纪律:plans 300+ 文件只读头部字节提取「**日期**/**状态**」,单次遍历;
// 数据真实纪律:读取失败如实计入 parseFailures,不吞不编造。
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use super::manifest;

pub const PLANS_DIR: &str = "plans";
pub const BUGS_DIR: &str = "history/bug-records";
pub const DEBTS_DIR: &str = "history/tech-debt";
/// 头部提取最多读取的字节数(plan-create 模板的日期/状态行都在最前几行)
const HEAD_BYTES: u64 = 4096;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocItem {
    /// 绝对路径(双击在文件工作台打开)
    pub path: String,
    /// 文件名(去 .md;分类页主显示)
    pub name: String,
    /// 归属日期:文件名 YYYY-MM-DD 前缀优先,回退头部 **日期**: 行,再回退 mtime 日期
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// plans 头部 **状态**: 行值(bugs/债无此概念)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub modified_utc: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPage {
    /// 过滤后的总条数(分页导航依据)
    pub total: usize,
    pub parse_failures: usize,
    pub items: Vec<DocItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionSummary {
    pub total: usize,
    pub parse_failures: usize,
    pub recent: Vec<DocItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySummary {
    pub present: bool,
    /// memory/ 一级子目录数(索引分组)
    pub groups: usize,
    pub files: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_utc: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastSyncInfo {
    pub modified_utc: String,
    /// last-sync-report.md 的「## 结论:」行(机械同步最近一次结果)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub plans: SectionSummary,
    pub bugs: SectionSummary,
    pub debts: SectionSummary,
    pub memory: MemorySummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<LastSyncInfo>,
}

fn rfc3339(t: SystemTime) -> String {
    OffsetDateTime::from(t)
        .format(&Rfc3339)
        .unwrap_or_default()
}

/// 文件名 YYYY-MM-DD 前缀(手写解析,避免为此引 regex 依赖)。
fn filename_date(name: &str) -> Option<String> {
    let b = name.as_bytes();
    if b.len() < 10 {
        return None;
    }
    let digit = |i: usize| b[i].is_ascii_digit();
    if digit(0) && digit(1) && digit(2) && digit(3) && b[4] == b'-'
        && digit(5) && digit(6) && b[7] == b'-' && digit(8) && digit(9)
    {
        return Some(name[..10].to_string());
    }
    None
}

/// 头部若干字节内提取「**日期**:」「**状态**:」行值(中英冒号皆认;BOM/CRLF 容错)。
fn parse_head(path: &Path) -> Result<(Option<String>, Option<String>), String> {
    let file = fs::File::open(path).map_err(|e| format!("打开 {} 失败: {e}", path.display()))?;
    let mut head = String::new();
    file.take(HEAD_BYTES)
        .read_to_string(&mut head)
        // 截断可能落在多字节字符中间 → 有损兜不住的场景按字节重读转 lossy
        .or_else(|_| -> Result<usize, String> {
            let bytes = fs::read(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
            let end = bytes.len().min(HEAD_BYTES as usize);
            head = String::from_utf8_lossy(&bytes[..end]).into_owned();
            Ok(head.len())
        })?;
    let mut date = None;
    let mut status = None;
    for line in head.lines() {
        let line = line.trim_start_matches('\u{feff}').trim();
        for (key, slot) in [("**日期**", &mut date), ("**状态**", &mut status)] {
            if slot.is_none() {
                if let Some(rest) = line.strip_prefix(key) {
                    let value = rest.trim_start_matches([':', '：', ' ']).trim();
                    if !value.is_empty() {
                        let mut v = value.to_string();
                        if v.chars().count() > 80 {
                            v = v.chars().take(80).collect();
                        }
                        *slot = Some(v);
                    }
                }
            }
        }
        if date.is_some() && status.is_some() {
            break;
        }
    }
    Ok((date, status))
}

/// 单目录扫描:全部 .md(plans 递归含主题群子文件夹;bugs/债一级即可,统一递归不伤正确性)。
/// parse_head 仅对 plans 生效(with_head);排序键=归属日期降序,同日按名称降序。
fn scan_docs(dir: &Path, with_head: bool) -> (Vec<DocItem>, usize) {
    let mut items = Vec::new();
    let mut failures = 0usize;
    if !dir.is_dir() {
        return (items, failures);
    }
    for entry in walkdir::WalkDir::new(dir) {
        let Ok(entry) = entry else {
            failures += 1;
            continue;
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let name_os = entry.file_name().to_string_lossy();
        if !name_os.ends_with(".md") || name_os.starts_with('.') {
            continue;
        }
        let name = name_os.trim_end_matches(".md").to_string();
        let Ok(meta) = entry.metadata() else {
            failures += 1;
            continue;
        };
        let modified = meta.modified().map(rfc3339).unwrap_or_default();
        let (head_date, status) = if with_head {
            match parse_head(entry.path()) {
                Ok(v) => v,
                Err(_) => {
                    failures += 1;
                    (None, None)
                }
            }
        } else {
            (None, None)
        };
        // 归属日期链:文件名前缀 > 父文件夹前缀(主题群 multi-plan 文件夹) > 头部日期行 > mtime
        let parent_date = entry
            .path()
            .parent()
            .filter(|p| *p != dir)
            .and_then(|p| p.file_name())
            .and_then(|n| filename_date(&n.to_string_lossy()));
        let date = filename_date(&name)
            .or(parent_date)
            .or(head_date)
            .or_else(|| (modified.len() >= 10).then(|| modified[..10].to_string()));
        items.push(DocItem {
            path: entry.path().display().to_string(),
            name,
            date,
            status,
            modified_utc: modified,
        });
    }
    items.sort_by(|a, b| (b.date.as_deref(), &b.name).cmp(&(a.date.as_deref(), &a.name)));
    (items, failures)
}

fn doc_dir(workspace: &Path, sub: &str) -> PathBuf {
    manifest::env_root(workspace).join(sub)
}

/// 分页查询(分类页):query=名称包含(不区分大小写);status=状态行包含(仅 plans 有状态)。
pub fn list_docs(
    workspace: &Path,
    sub: &str,
    with_head: bool,
    offset: usize,
    limit: usize,
    query: Option<&str>,
    status: Option<&str>,
) -> Result<DocPage, String> {
    let (all, parse_failures) = scan_docs(&doc_dir(workspace, sub), with_head);
    let query = query.map(str::to_lowercase).filter(|q| !q.is_empty());
    let status = status.map(str::to_string).filter(|s| !s.is_empty());
    let filtered: Vec<&DocItem> = all
        .iter()
        .filter(|d| {
            query.as_deref().is_none_or(|q| d.name.to_lowercase().contains(q))
                && status
                    .as_deref()
                    .is_none_or(|s| d.status.as_deref().is_some_and(|v| v.contains(s)))
        })
        .collect();
    let total = filtered.len();
    let items = filtered
        .into_iter()
        .skip(offset)
        .take(limit.clamp(1, 200))
        .cloned()
        .collect();
    Ok(DocPage {
        total,
        parse_failures,
        items,
    })
}

fn section_summary(dir: &Path, with_head: bool, recent: usize) -> SectionSummary {
    let (mut items, parse_failures) = scan_docs(dir, with_head);
    let total = items.len();
    items.truncate(recent);
    SectionSummary {
        total,
        parse_failures,
        recent: items,
    }
}

fn memory_summary(workspace: &Path) -> MemorySummary {
    let dir = manifest::env_root(workspace).join("memory");
    let mut summary = MemorySummary {
        present: dir.is_dir(),
        groups: 0,
        files: 0,
        latest_utc: None,
    };
    if !summary.present {
        return summary;
    }
    let mut latest: Option<SystemTime> = None;
    for entry in walkdir::WalkDir::new(&dir).into_iter().flatten() {
        if entry.depth() == 1 && entry.file_type().is_dir() {
            summary.groups += 1;
        }
        if entry.file_type().is_file() {
            summary.files += 1;
            if let Ok(m) = entry.metadata() {
                if let Ok(t) = m.modified() {
                    if latest.is_none_or(|prev| t > prev) {
                        latest = Some(t);
                    }
                }
            }
        }
    }
    summary.latest_utc = latest.map(rfc3339);
    summary
}

fn last_sync_info(workspace: &Path) -> Option<LastSyncInfo> {
    let path = manifest::env_root(workspace).join("agentsSynchronizer/last-sync-report.md");
    let meta = fs::metadata(&path).ok()?;
    let headline = fs::read_to_string(&path).ok().and_then(|text| {
        text.lines()
            .find(|line| line.trim_start().starts_with("## 结论"))
            .map(|line| line.trim().to_string())
    });
    Some(LastSyncInfo {
        modified_utc: meta.modified().map(rfc3339).unwrap_or_default(),
        headline,
    })
}

/// Skills 常态行(以 .htyworkflows 真版为扫描权威,用户第三轮反馈;plan-5 SkillPanel canonical 数据源)。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSkillInfo {
    /// 目录名 = 稳定标识(收藏/标签/模板沿用)
    pub id: String,
    /// frontmatter name(调用串 /name 的依据;缺失回退 id)
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// canonical SKILL.md 绝对路径(拖拽注入 payload 用)
    pub path: String,
    /// 启用态(manifest enabled,缺省/未登记=启用;plan-5 决策 1A)
    pub enabled: bool,
    /// 是否在 manifest 登记(未登记=UNREGISTERED,不可启停)
    pub registered: bool,
}

pub fn workspace_skills(workspace: &Path) -> Result<Vec<WorkspaceSkillInfo>, String> {
    let manifest_data = manifest::load(workspace)?;
    let mut out = Vec::new();
    for id in super::list_skill_dirs(workspace)? {
        let entry = manifest::skill_dir(workspace, &id)?.join(manifest::SKILL_ENTRY);
        let (name, description) = manifest::skill_frontmatter_meta(&entry);
        out.push(WorkspaceSkillInfo {
            name: name.unwrap_or_else(|| id.clone()),
            description,
            path: entry.display().to_string(),
            enabled: manifest_data.skill_enabled(&id),
            registered: manifest_data.skills.iter().any(|s| s.id == id),
            id,
        });
    }
    Ok(out)
}

/// 概览聚合(单命令一次取齐;recent 口径=决策 4A,仅概览摘要卡使用)。
pub fn dashboard_data(workspace: &Path, recent: usize) -> Result<DashboardData, String> {
    Ok(DashboardData {
        plans: section_summary(&doc_dir(workspace, PLANS_DIR), true, recent),
        bugs: section_summary(&doc_dir(workspace, BUGS_DIR), false, recent),
        debts: section_summary(&doc_dir(workspace, DEBTS_DIR), false, recent),
        memory: memory_summary(workspace),
        last_sync: last_sync_info(workspace),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &PathBuf, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().to_path_buf();
        let plans = ws.join(".htyworkflows/plans");
        write(
            &plans.join("2026-07-13-alpha.md"),
            "# alpha\n\n**日期**:2026-07-13\n**状态**:执行中\n",
        );
        // 无日期前缀 → 回退头部日期;CRLF+BOM 容错
        write(
            &plans.join("no-date-plan.md"),
            "\u{feff}# t\r\n\r\n**日期**：2025-01-02\r\n**状态**：已完工\r\n",
        );
        // 无任何头部 → 回退 mtime;主题群子文件夹递归
        write(&plans.join("2026-01-01-multi-plan-x/global-plan-manager.md"), "# mgr\n");
        write(&ws.join(".htyworkflows/history/bug-records/BUG-001-崩溃.md"), "b");
        write(&ws.join(".htyworkflows/history/bug-records/BUG-002-卡顿.md"), "b");
        write(&ws.join(".htyworkflows/history/tech-debt/TD-001-旧路径.md"), "t");
        write(&ws.join(".htyworkflows/memory/MEMORY.md"), "# 索引\n");
        write(&ws.join(".htyworkflows/memory/index_0_set/a.md"), "m");
        write(&ws.join(".htyworkflows/memory/index_1_set/b.md"), "m");
        write(
            &ws.join(".htyworkflows/agentsSynchronizer/last-sync-report.md"),
            "# 报告\n\n## 结论: 全绿，零人工项\n",
        );
        (tmp, ws)
    }

    #[test]
    fn dashboard_data_aggregates_truthfully() {
        let (_t, ws) = setup();
        let data = dashboard_data(&ws, 2).unwrap();
        assert_eq!(data.plans.total, 3);
        assert_eq!(data.plans.parse_failures, 0);
        assert_eq!(data.plans.recent.len(), 2);
        assert_eq!(data.plans.recent[0].name, "2026-07-13-alpha", "文件名日期降序优先");
        assert_eq!(data.plans.recent[0].status.as_deref(), Some("执行中"));
        assert_eq!(data.bugs.total, 2);
        assert_eq!(data.debts.total, 1);
        assert!(data.memory.present);
        assert_eq!(data.memory.groups, 2);
        assert_eq!(data.memory.files, 3);
        assert!(data.memory.latest_utc.is_some());
        let sync = data.last_sync.unwrap();
        assert!(sync.headline.unwrap().contains("全绿"));
        // 未初始化工程:全零 + 状态如实
        let empty = tempfile::tempdir().unwrap();
        let none = dashboard_data(empty.path(), 5).unwrap();
        assert_eq!(none.plans.total, 0);
        assert!(!none.memory.present);
        assert!(none.last_sync.is_none());
    }

    #[test]
    fn list_docs_pagination_and_filters() {
        let (_t, ws) = setup();
        // 全量按日期降序:alpha(2026-07-13) > multi-plan(2026-01-01) > no-date(2025-01-02 头部日期)
        let page = list_docs(&ws, PLANS_DIR, true, 0, 10, None, None).unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.items[0].name, "2026-07-13-alpha");
        assert_eq!(page.items[1].name, "global-plan-manager");
        assert_eq!(page.items[2].name, "no-date-plan");
        assert_eq!(page.items[2].date.as_deref(), Some("2025-01-02"), "头部中文冒号日期");
        // 分页
        let p2 = list_docs(&ws, PLANS_DIR, true, 1, 1, None, None).unwrap();
        assert_eq!(p2.total, 3);
        assert_eq!(p2.items.len(), 1);
        assert_eq!(p2.items[0].name, "global-plan-manager");
        // 名称过滤(不区分大小写)
        let q = list_docs(&ws, PLANS_DIR, true, 0, 10, Some("ALPHA"), None).unwrap();
        assert_eq!(q.total, 1);
        // 状态过滤
        let s = list_docs(&ws, PLANS_DIR, true, 0, 10, None, Some("已完工")).unwrap();
        assert_eq!(s.total, 1);
        assert_eq!(s.items[0].name, "no-date-plan");
        // bugs 不解析头部
        let bugs = list_docs(&ws, BUGS_DIR, false, 0, 10, None, None).unwrap();
        assert_eq!(bugs.total, 2);
        assert!(bugs.items[0].status.is_none());
    }

    #[test]
    fn filename_date_edge_cases() {
        assert_eq!(filename_date("2026-07-13-x"), Some("2026-07-13".into()));
        assert_eq!(filename_date("2026-07-13"), Some("2026-07-13".into()));
        assert_eq!(filename_date("206-07-13-x"), None);
        assert_eq!(filename_date("abcd-ef-gh-x"), None);
        assert_eq!(filename_date("短名"), None);
    }
}
