// htyenv/report.rs —— 同步/对账汇总(sync-all.ps1 ①-④ 等价编排)。
// 一份 SyncReport 渲染两种产物(决策 2 双轨):结构化 JSON 返回前端;markdown 覆盖写
// agentsSynchronizer/last-sync-report.md(保持"喂 AI"降级链路的既有输入)。check 模式全程零写入。
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::adapters::{self, AdapterState};
use super::manifest;
use super::memory_sync::{self, MemoryMdStatus};
use super::verify;
use super::RosterStatus;

const REPORT_DIR: &str = "agentsSynchronizer";
const REPORT_FILE: &str = "last-sync-report.md";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub generated_at: String,
    /// "check"(只读) | "sync"(执行收敛)
    pub mode: String,
    pub roster: RosterStatus,
    /// canonical 有而 manifest 未登记
    pub unregistered: Vec<String>,
    /// manifest 登记而 canonical 无目录
    pub ghosts: Vec<String>,
    /// 登记跟随刷新的 skill id(仅 sync 模式非空)
    pub manifest_refreshed: Vec<String>,
    /// 薄壳对账(sync 模式为重生成后的复核结果)
    pub adapters: adapters::AdapterCheckReport,
    /// 重生成执行结果(仅 sync 模式)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_outcome: Option<adapters::SyncOutcome>,
    pub memory: memory_sync::MemorySyncReport,
    pub verify: verify::VerifyReport,
    /// 需人工处理项计数(sync-all 口径:机械层绝不代劳的语义项与失败项)
    pub manual_items: usize,
}

/// 主编排:check(write=false,零写入) / sync(write=true:manifest 跟随刷新落盘 + 薄壳全量重生成 + 记忆补齐)。
/// cache_memory_dir 由命令层经 catalog::resolve_claude_project 解析(可以尚不存在,补齐时创建)。
pub fn run(
    workspace: &Path,
    cache_memory_dir: &Path,
    write: bool,
) -> Result<SyncReport, String> {
    let mut manifest_data = manifest::load(workspace)?;

    // ① 名册零遗漏对账
    let roster = super::roster_status(workspace, &manifest_data)?;

    // ② skill 对账 + 登记跟随刷新 + 薄壳
    let ids: BTreeSet<String> = super::list_skill_dirs(workspace)?.into_iter().collect();
    let registered: BTreeSet<String> = manifest_data.skills.iter().map(|s| s.id.clone()).collect();
    let unregistered: Vec<String> = ids.difference(&registered).cloned().collect();
    let ghosts: Vec<String> = registered.difference(&ids).cloned().collect();
    let mut manifest_refreshed = Vec::new();
    let mut sync_outcome = None;
    if write {
        manifest_refreshed = manifest::refresh_from_canonical(workspace, &mut manifest_data)?;
        if !manifest_refreshed.is_empty() {
            manifest::save(workspace, &manifest_data)?;
        }
        sync_outcome = Some(adapters::sync_adapters(workspace, &manifest_data)?);
    }
    let adapter_report = adapters::check_adapters(workspace, &manifest_data)?;

    // ③ 记忆单向收敛(sync 模式执行补齐)
    let memory = memory_sync::converge_memory(workspace, cache_memory_dir, write)?;

    // ④ 全套校验(含 path-audit;哈希组用刷新后的 manifest)
    let verify_report = verify::verify(workspace, &manifest_data, Some(cache_memory_dir))?;

    let mut manual_items = 0usize;
    if !roster.consistent {
        manual_items += 1;
    }
    manual_items += unregistered.len() + ghosts.len();
    let adapters_clean = adapter_report
        .skills
        .iter()
        .all(|s| s.states.values().all(|st| *st == AdapterState::Consistent))
        && adapter_report.canonical_missing_entry.is_empty()
        && adapter_report.metadata_missing.is_empty()
        && adapter_report.metadata_out_of_sync.is_empty();
    if !adapters_clean {
        manual_items += 1;
    }
    manual_items += adapter_report.orphan_shells.len();
    manual_items += memory.conflicts.len() + memory.uncurated.len();
    if memory.memory_md == MemoryMdStatus::Conflict {
        manual_items += 1;
    }
    if !verify_report.all_passed {
        manual_items += 1;
    }

    Ok(SyncReport {
        generated_at: manifest::now_utc_rfc3339()?,
        mode: if write { "sync" } else { "check" }.to_string(),
        roster,
        unregistered,
        ghosts,
        manifest_refreshed,
        adapters: adapter_report,
        sync_outcome,
        memory,
        verify: verify_report,
        manual_items,
    })
}

/// 渲染 last-sync-report.md(sync-all 报告同构:①②③④ + 结论;人工项标 ⚠)。
pub fn render_markdown(report: &SyncReport) -> String {
    let mut out = Vec::new();
    out.push(format!(
        "# 全 Agent 同步与对齐报告（{} · {}）\n",
        report.generated_at, report.mode
    ));
    out.push("## ① 名册零遗漏对账".to_string());
    out.push(format!("- adapters/ 名册: {}", report.roster.adapter_dirs.join(", ")));
    out.push(format!("- manifest providers: {}", report.roster.providers.join(", ")));
    out.push(format!("- rules 差异条款: {}", report.roster.rule_files.join(", ")));
    out.push(if report.roster.consistent {
        "- 三处一致，零遗漏 ✓".to_string()
    } else {
        "- **不一致！存在遗漏或未接入完整的 Agent（按 adapters/README.md 五步接入补齐）** ⚠".to_string()
    });
    out.push("\n## ② Skill 全量同步（全部在册 Agent）".to_string());
    for id in &report.unregistered {
        out.push(format!("- UNREGISTERED: canonical 有 `{id}` 但 manifest 未登记 → 补登后重跑 ⚠"));
    }
    for id in &report.ghosts {
        out.push(format!("- GHOST: manifest 登记 `{id}` 但 canonical 无此目录 → 决议后清账 ⚠"));
    }
    if !report.manifest_refreshed.is_empty() {
        out.push(format!(
            "- manifest 登记刷新（canonical 有合法更新）: {}",
            report.manifest_refreshed.join(", ")
        ));
    }
    out.push(render_adapter_lines(report));
    out.push("\n## ③ 记忆同步".to_string());
    for rel in &report.memory.conflicts {
        out.push(format!("- CONFLICT: `{rel}` 两侧内容不同 → 人工确认后双写收敛 ⚠"));
    }
    for rel in &report.memory.uncurated {
        out.push(format!("- UNCURATED: 缓存多出 `{rel}`（canonical 无）→ 按策展纪律收编或清理 ⚠"));
    }
    out.push(match report.memory.memory_md {
        MemoryMdStatus::Conflict => "- CONFLICT: MEMORY.md 索引正文两侧不一致 → 人工确认 ⚠".to_string(),
        status => format!(
            "- Claude 缓存: 补齐 {} / 一致 {} / MEMORY.md {:?} {}",
            report.memory.filled.len(),
            report.memory.same,
            status,
            if status == MemoryMdStatus::Consistent { "✓" } else { "" }
        ),
    });
    out.push("- Codex: 直读 canonical,无需下发".to_string());
    out.push("\n## ④ 全套校验".to_string());
    for c in &report.verify.checks {
        let tag = if c.skipped { "SKIP" } else if c.passed { "PASS" } else { "FAIL ⚠" };
        if c.details.is_empty() {
            out.push(format!("- [{tag}] {}", c.name));
        } else {
            out.push(format!("- [{tag}] {} :: {}", c.name, c.details.join(" ; ")));
        }
    }
    out.push(format!(
        "\n## 结论: {}",
        if report.manual_items == 0 {
            "全绿，零人工项".to_string()
        } else {
            format!("需人工处理 {} 项（标 ⚠）", report.manual_items)
        }
    ));
    out.join("\n") + "\n"
}

fn render_adapter_lines(report: &SyncReport) -> String {
    let mut lines = Vec::new();
    if let Some(outcome) = &report.sync_outcome {
        lines.push(format!(
            "- 薄壳全量重生成: 适配器 {} 个 + metadata {} 个{}",
            outcome.written_adapters,
            outcome.written_metadata,
            if outcome.removed_adapters > 0 {
                format!(" + 下架清除 {} 个", outcome.removed_adapters)
            } else {
                String::new()
            }
        ));
        for item in &outcome.overwrote_hand_edited {
            lines.push(format!("- 已覆盖手改薄壳(以 canonical 为准): {item}"));
        }
    }
    let mut issues = Vec::new();
    for skill in &report.adapters.skills {
        for (provider, state) in &skill.states {
            let label = match state {
                AdapterState::Consistent => continue,
                AdapterState::Stale => "陈旧",
                AdapterState::HandEdited => "手改",
                AdapterState::Missing => "缺失",
            };
            issues.push(format!("{label}: {provider}/{}", skill.id));
        }
    }
    for id in &report.adapters.canonical_missing_entry {
        issues.push(format!("canonical 缺入口: {id}"));
    }
    for o in &report.adapters.orphan_shells {
        issues.push(format!("缺真版(孤儿薄壳): {}/{}", o.provider, o.id));
    }
    for rel in &report.adapters.metadata_missing {
        issues.push(format!("metadata 缺失: {rel}"));
    }
    for rel in &report.adapters.metadata_out_of_sync {
        issues.push(format!("metadata 不同步: {rel}"));
    }
    if issues.is_empty() {
        lines.push(format!(
            "- canonical {} 个 Skill → 全部在册 Agent 薄壳 check 零漂移 ✓",
            report.adapters.skills.len()
        ));
    } else {
        for issue in issues {
            lines.push(format!("- 薄壳问题: {issue} ⚠"));
        }
    }
    lines.join("\n")
}

/// sync 模式产物落盘:覆盖写 agentsSynchronizer/last-sync-report.md,返回绝对路径。
pub fn write_last_report(workspace: &Path, report: &SyncReport) -> Result<PathBuf, String> {
    let dir = manifest::env_root(workspace).join(REPORT_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 {} 失败: {e}", dir.display()))?;
    let path = dir.join(REPORT_FILE);
    super::write_atomic(&path, render_markdown(report).as_bytes())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn write(path: &PathBuf, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// 最小环境:manifest 登记 sha 故意过期(等 sync 跟随刷新),缓存缺一个文件(等补齐),另有一处记忆 CONFLICT。
    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().to_path_buf();
        let root = ws.join(manifest::ENV_DIR);
        write(&root.join("skills/alpha/SKILL.md"), "---\nname: alpha\n---\nA\n");
        write(&root.join("rules/common.md"), "c");
        write(&root.join("rules/claude.md"), "c");
        write(&root.join("rules/codex.md"), "c");
        fs::create_dir_all(root.join("adapters/claude")).unwrap();
        fs::create_dir_all(root.join("adapters/codex")).unwrap();
        for dir in ["plans","plans_waitChoose","changeLog","changeLogHistory","chatContinue","handoff","docking","svg","testKPI","userTeach","runtime/logs","history/bug-records","history/tech-debt","user-real-design"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        write(&root.join("memory/MEMORY.md"), "# 契约\n# 索引\n");
        write(&root.join("memory/index_0/x.md"), "same");
        write(&root.join("memory/index_0/y.md"), "canonical-y");
        write(&root.join("memory/index_0/z.md"), "fill-me");
        write(
            &root.join(manifest::MANIFEST_FILE),
            r#"{
  "schemaVersion": 1,
  "providers": {
    "claude": { "adapterDir": ".claude/skills" },
    "codex": { "adapterDir": ".agents/skills" }
  },
  "skills": [ { "id": "alpha", "entrySha256": "STALE", "fileCount": 1 } ]
}"#,
        );
        let cache = ws.join("cache-memory");
        write(&cache.join("MEMORY.md"), "# 索引\n");
        write(&cache.join("index_0/x.md"), "same");
        write(&cache.join("index_0/y.md"), "cache-y");
        (tmp, ws, cache)
    }

    #[test]
    fn check_mode_reports_without_writing() {
        let (_tmp, ws, cache) = setup();
        let report = run(&ws, &cache, false).unwrap();
        assert_eq!(report.mode, "check");
        assert!(report.sync_outcome.is_none());
        assert!(report.manifest_refreshed.is_empty());
        // 零写入:薄壳未生成、缓存未补齐、manifest 未刷新
        assert!(!ws.join(".claude/skills/alpha/SKILL.md").exists());
        assert!(!cache.join("index_0/z.md").exists());
        assert!(manifest::load(&ws).unwrap().skills[0].entry_sha256 == "STALE");
        assert_eq!(report.memory.conflicts, vec!["index_0/y.md".to_string()]);
        assert!(report.manual_items >= 2, "薄壳缺失+CONFLICT 至少两类人工/失败项");
    }

    #[test]
    fn sync_mode_heals_and_second_run_converges() {
        let (_tmp, ws, cache) = setup();
        let first = run(&ws, &cache, true).unwrap();
        assert_eq!(first.mode, "sync");
        assert_eq!(first.manifest_refreshed, vec!["alpha".to_string()]);
        assert_eq!(first.sync_outcome.as_ref().unwrap().written_adapters, 2);
        assert_eq!(first.memory.filled, vec!["index_0/z.md".to_string()]);
        // manifest 已跟随刷新落盘;薄壳复核零漂移
        assert_ne!(manifest::load(&ws).unwrap().skills[0].entry_sha256, "STALE");
        assert!(first
            .adapters
            .skills[0]
            .states
            .values()
            .all(|s| *s == AdapterState::Consistent));
        // 二跑:零刷新、零补齐,CONFLICT 恒在(绝不代劳)
        let second = run(&ws, &cache, true).unwrap();
        assert!(second.manifest_refreshed.is_empty());
        assert!(second.memory.filled.is_empty());
        assert_eq!(second.memory.conflicts, vec!["index_0/y.md".to_string()]);
        assert_eq!(second.memory.same, 2);
        // 报告落盘 + 渲染要点
        let path = write_last_report(&ws, &second).unwrap();
        let text = fs::read_to_string(path).unwrap();
        assert!(text.contains("## ① 名册零遗漏对账"));
        assert!(text.contains("三处一致，零遗漏 ✓"));
        assert!(text.contains("CONFLICT: `index_0/y.md`"));
        assert!(text.contains("## 结论: 需人工处理"));
    }

    #[test]
    fn markdown_green_conclusion() {
        let (_tmp, ws, cache) = setup();
        run(&ws, &cache, true).unwrap();
        // 消除 CONFLICT 后应全绿
        fs::write(ws.join(".htyworkflows/memory/index_0/y.md"), "cache-y").unwrap();
        let report = run(&ws, &cache, true).unwrap();
        assert_eq!(report.manual_items, 0, "verify: {:?}", report.verify);
        assert!(render_markdown(&report).contains("全绿，零人工项"));
    }
}
