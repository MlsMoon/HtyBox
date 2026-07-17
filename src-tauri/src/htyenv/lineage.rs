// htyenv/lineage.rs —— 工作区 canonical ↔ 全局权威库的 skill 级谱系引擎(plan-3)。
// 五态判定以 SKILL.md 三值(工程现值 w / 谱系基线 b=librarySha / 库现值 l)为主判据,
// 目录树指纹辅助防"正文没变资源变"漏判(设计原则 2);机械/语义分离:diverged 绝不自动合并,
// 裁决结论经 adjudicated=true 显式落地(决策 5);所有换树 staging+rename,失败回滚不留半成品。
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Map;

use super::library::{self, LibraryManifest, LibrarySkillEntry, LibraryVersion};
use super::manifest::{self, WorkflowManifest};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineageState {
    /// 无谱系关联(无基线且未与库建立对应;库有同 id 时须显式关联,不自动配对)
    Untracked,
    UpToDate,
    /// 仅库前进 → 可 fast-forward 更新
    LibraryAhead,
    /// 仅工程前进 → 回流候选
    WorkspaceAhead,
    /// 双侧各自演进/存在性不对称 → 只报告,裁决注入终端
    Diverged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    WsOnly,
    LibOnly,
    Differs,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// skill 目录内相对路径('/' 分隔)
    pub path: String,
    pub kind: ChangeKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLineage {
    pub id: String,
    pub state: LineageState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ws_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lib_sha: Option<String>,
    /// 双方目录都在时的树指纹一致性(None=有一侧不可枚举)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tree_match: Option<bool>,
    /// 双侧内容一致但基线陈旧(执行更新/回流任一即对齐)
    pub baseline_stale: bool,
    /// 库侧为内置种子(SEED_SKILLS 经 ensure_library 标记):供「环境补全」聚合"官方 skill 有更新"入口筛选
    pub bundled: bool,
    pub changed_files: Vec<ChangedFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineageReport {
    pub library: library::LibraryStatus,
    pub skills: Vec<SkillLineage>,
    /// 库有而工程无(可经取件引入,plan-2 fetch)
    pub library_only: Vec<String>,
    /// 库登记 sha ≠ 库实文件(外部修改):compare 只报告,update/backflow 前跟随刷新
    pub library_drift: Vec<String>,
}

/// 更新/回流的逐项结果(决策 2A:一项失败不阻塞其余)。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOpResult {
    pub id: String,
    /// updated / backflowed / realigned / alreadyUpToDate(error 时缺省)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// 操作后的对齐 sha(工程/库/基线三值一致)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_sha: Option<String>,
    pub written_adapters: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SyncOpResult {
    fn ok(id: &str, status: &str, to_sha: String, written_adapters: usize) -> Self {
        Self {
            id: id.to_string(),
            status: Some(status.to_string()),
            to_sha: Some(to_sha),
            written_adapters,
            error: None,
        }
    }

    fn err(id: &str, error: String) -> Self {
        Self {
            id: id.to_string(),
            status: None,
            to_sha: None,
            written_adapters: 0,
            error: Some(error),
        }
    }
}

/// 单 skill 判态素材(全部取实文件现值,不信任登记快照)。
struct SkillFacts {
    ws_sha: Option<String>,
    base: Option<String>,
    lib_registered: bool,
    lib_sha: Option<String>,
    /// 基线 sha 是否出现在库版本链或库登记 current 中。
    /// 用于识破「librarySha 被抬成工程现值、但库从未收过该版」的失效基线,
    /// 避免误判 LibraryAhead(UI 显示「更新」而实为工程领先)。
    base_known_by_library: bool,
    tree_match: Option<bool>,
    changed_files: Vec<ChangedFile>,
}

fn collect_facts(
    workspace: &Path,
    ws_manifest: &WorkflowManifest,
    library_dir: &Path,
    library: &LibraryManifest,
    id: &str,
) -> Result<SkillFacts, String> {
    let ws_dir = manifest::skill_dir(workspace, id)?;
    let ws_entry = ws_dir.join(manifest::SKILL_ENTRY);
    let ws_sha = if ws_entry.is_file() {
        Some(manifest::sha256_file_upper(&ws_entry)?)
    } else {
        None
    };
    let base = ws_manifest
        .skills
        .iter()
        .find(|s| s.id == id)
        .and_then(|s| s.library_sha.clone());
    let lib_entry = library.skills.iter().find(|s| s.id == id);
    let lib_registered = lib_entry.is_some();
    let lib_dir = library_dir.join(library::LIBRARY_SKILLS_DIR).join(id);
    let lib_file = lib_dir.join(manifest::SKILL_ENTRY);
    let lib_sha = if lib_registered && lib_file.is_file() {
        Some(manifest::sha256_file_upper(&lib_file)?)
    } else {
        None
    };
    let base_known_by_library = match (base.as_deref(), lib_entry) {
        (Some(b), Some(entry)) => library_knows_sha(entry, b),
        _ => false,
    };
    let (tree_match, changed_files) = if ws_sha.is_some() && lib_sha.is_some() {
        let (matched, changed) = diff_trees(&tree_digests(&ws_dir)?, &tree_digests(&lib_dir)?);
        (Some(matched), changed)
    } else {
        (None, Vec::new())
    };
    Ok(SkillFacts {
        ws_sha,
        base,
        lib_registered,
        lib_sha,
        base_known_by_library,
        tree_match,
        changed_files,
    })
}

/// 库是否曾以该 sha 为登记 current 或版本链节点(不含仅实文件漂移、尚未 refresh 的现值)。
fn library_knows_sha(entry: &library::LibrarySkillEntry, sha: &str) -> bool {
    entry.current_sha256 == sha || entry.versions.iter().any(|v| v.sha256 == sha)
}

/// 目录树内容指纹:相对路径('/' 分隔) → 文件 SHA-256 大写(含隐藏文件,不跟符号链接)。
fn tree_digests(dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut map = BTreeMap::new();
    for item in walkdir::WalkDir::new(dir) {
        let item = item.map_err(|e| format!("遍历 {} 失败: {e}", dir.display()))?;
        if !item.file_type().is_file() {
            continue;
        }
        let rel = item
            .path()
            .strip_prefix(dir)
            .map_err(|e| format!("相对化失败: {e}"))?
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        map.insert(rel, manifest::sha256_file_upper(item.path())?);
    }
    Ok(map)
}

fn diff_trees(
    ws: &BTreeMap<String, String>,
    lib: &BTreeMap<String, String>,
) -> (bool, Vec<ChangedFile>) {
    let mut changed = Vec::new();
    for (path, sha) in ws {
        match lib.get(path) {
            None => changed.push(ChangedFile {
                path: path.clone(),
                kind: ChangeKind::WsOnly,
            }),
            Some(other) if other != sha => changed.push(ChangedFile {
                path: path.clone(),
                kind: ChangeKind::Differs,
            }),
            _ => {}
        }
    }
    for path in lib.keys() {
        if !ws.contains_key(path) {
            changed.push(ChangedFile {
                path: path.clone(),
                kind: ChangeKind::LibOnly,
            });
        }
    }
    (changed.is_empty(), changed)
}

/// 五态判定真值表。返回(状态, 基线陈旧, 说明);机械上仅 LibraryAhead/WorkspaceAhead/基线对齐允许自动写。
fn judge(f: &SkillFacts) -> (LineageState, bool, Option<String>) {
    let d = |s: &str| Some(s.to_string());
    match (f.ws_sha.as_deref(), f.base.as_deref(), f.lib_registered, f.lib_sha.as_deref()) {
        // 库 manifest 无此 id
        (_, None, false, _) => (LineageState::Untracked, false, None),
        (_, Some(_), false, _) => (
            LineageState::Diverged,
            false,
            d("库内已无此 skill(谱系基线断链,库侧可能被外部删除)——注入终端裁决"),
        ),
        // 库登记在而实体缺 SKILL.md(库侧损坏/外部删除)
        (_, None, true, None) => (
            LineageState::Untracked,
            false,
            d("库内同 id 登记存在但实体缺 SKILL.md(库侧待修复),未建立关联"),
        ),
        (_, Some(_), true, None) => (
            LineageState::Diverged,
            false,
            d("库侧实体缺 SKILL.md(外部删除/损坏)——先修复库再判"),
        ),
        // 工程 canonical 缺 SKILL.md(GHOST)
        (None, None, true, Some(_)) => (
            LineageState::Untracked,
            false,
            d("工程 canonical 缺 SKILL.md(GHOST)而库内有同 id,未建立关联"),
        ),
        (None, Some(_), true, Some(_)) => (
            LineageState::Diverged,
            false,
            d("工程 canonical 缺失(GHOST)而库内仍在——恢复或除名需人工裁决"),
        ),
        // 双侧实体齐备:三值判态 + 树指纹辅助
        (Some(w), base, true, Some(l)) => {
            if w == l {
                if f.tree_match == Some(false) {
                    return (
                        LineageState::Diverged,
                        false,
                        d("SKILL.md 一致但目录资源不一致(基线无从判方向)——注入终端裁决"),
                    );
                }
                match base {
                    None => (
                        LineageState::Untracked,
                        false,
                        d("库内已有同 id 且内容一致——收编即建立关联"),
                    ),
                    Some(b) if b == w => (LineageState::UpToDate, false, None),
                    Some(_) => (
                        LineageState::UpToDate,
                        true,
                        d("双侧内容一致但基线陈旧——执行更新或回流任一即对齐"),
                    ),
                }
            } else {
                match base {
                    None => (
                        LineageState::Untracked,
                        false,
                        d("库内已有同 id 但内容不同(可能同名非同源)——建立关联需注入终端裁决"),
                    ),
                    // b==w 本义=「工程未动、库前进」→ LibraryAhead;但若库版本史从未有过 b,
                    // 则基线是失效的(常为工程 librarySha 被抬成现值却未回流),绝不能提示「更新」盖掉工程。
                    Some(b) if b == w && f.base_known_by_library => {
                        (LineageState::LibraryAhead, false, None)
                    }
                    Some(b) if b == w => (
                        LineageState::Diverged,
                        false,
                        d("谱系基线 librarySha 不在库版本史上(基线失效,常见于未回流却抬基线)——勿点更新;确认后以工程为准回流或以库为准覆盖"),
                    ),
                    Some(b) if b == l => (LineageState::WorkspaceAhead, false, None),
                    Some(_) => (LineageState::Diverged, false, d("双侧各自演进——注入终端裁决")),
                }
            }
        }
    }
}

fn state_name(state: LineageState) -> &'static str {
    match state {
        LineageState::Untracked => "untracked",
        LineageState::UpToDate => "upToDate",
        LineageState::LibraryAhead => "libraryAhead",
        LineageState::WorkspaceAhead => "workspaceAhead",
        LineageState::Diverged => "diverged",
    }
}

/// 只读谱系对账(零写入):库侧现值取实文件、登记漂移仅记入 libraryDrift 报告(决策 4A:独立于 SyncReport)。
/// 库登记损坏 → 空清单 + 状态自述(五态无从判定);**库尚未建立 = 空库**——工作区 skill 全部按
/// untracked 参与对比(收编首用即建库,该语义是收编入口的前提,否则"收编即建库"成死循环)。
pub fn compare(workspace: &Path, library_dir: &Path) -> Result<LineageReport, String> {
    let status = library::library_status(library_dir);
    if status.manifest_error.is_some() {
        return Ok(LineageReport {
            library: status,
            skills: Vec::new(),
            library_only: Vec::new(),
            library_drift: Vec::new(),
        });
    }
    let library_manifest = if status.present {
        library::load_library(library_dir)?
    } else {
        LibraryManifest {
            schema_version: 1,
            library_id: String::new(),
            template_version: 0,
            created_utc: String::new(),
            skills: Vec::new(),
            extra: Map::new(),
        }
    };
    let ws_manifest = manifest::load(workspace)?;
    let mut ids: BTreeSet<String> = super::list_skill_dirs(workspace)?.into_iter().collect();
    ids.extend(ws_manifest.skills.iter().map(|s| s.id.clone()));

    let mut library_drift = Vec::new();
    for entry in &library_manifest.skills {
        manifest::validate_skill_id(&entry.id)?;
        let file = library_dir
            .join(library::LIBRARY_SKILLS_DIR)
            .join(&entry.id)
            .join(manifest::SKILL_ENTRY);
        if file.is_file() && manifest::sha256_file_upper(&file)? != entry.current_sha256 {
            library_drift.push(entry.id.clone());
        }
    }

    let mut skills = Vec::new();
    for id in &ids {
        let f = collect_facts(workspace, &ws_manifest, library_dir, &library_manifest, id)?;
        let (state, baseline_stale, detail) = judge(&f);
        let bundled = library_manifest
            .skills
            .iter()
            .find(|s| &s.id == id)
            .map(library::is_bundled_entry)
            .unwrap_or(false);
        skills.push(SkillLineage {
            id: id.clone(),
            state,
            ws_sha: f.ws_sha,
            base_sha: f.base,
            lib_sha: f.lib_sha,
            tree_match: f.tree_match,
            baseline_stale,
            bundled,
            changed_files: f.changed_files,
            detail,
        });
    }
    let library_only = library_manifest
        .skills
        .iter()
        .map(|s| s.id.clone())
        .filter(|id| !ids.contains(id))
        .collect();
    Ok(LineageReport {
        library: status,
        skills,
        library_only,
        library_drift,
    })
}

/// 换树:staging 全量组装 → 双 rename 交换 → 失败回滚;目标不存在时退化为直拷。返回文件计数。
fn replace_skill_tree(src: &Path, dst: &Path) -> Result<u64, String> {
    if !dst.exists() {
        return library::copy_skill_tree(src, dst);
    }
    let parent = dst
        .parent()
        .ok_or_else(|| format!("{} 无父目录", dst.display()))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staged = parent.join(format!(".htybox-lineage-new-{nanos}"));
    let retired = parent.join(format!(".htybox-lineage-old-{nanos}"));
    let count = library::copy_skill_tree(src, &staged)?;
    fs::rename(dst, &retired).map_err(|e| {
        let _ = fs::remove_dir_all(&staged);
        format!("退位 {} 失败: {e}", dst.display())
    })?;
    if let Err(e) = fs::rename(&staged, dst) {
        let _ = fs::rename(&retired, dst);
        let _ = fs::remove_dir_all(&staged);
        return Err(format!("入位 {} 失败(已回滚): {e}", dst.display()));
    }
    let _ = fs::remove_dir_all(&retired);
    Ok(count)
}

/// 工程 manifest 登记对齐(存在则刷,不存在则登;工程/库/基线三值在操作后必然一致)。
fn upsert_ws_entry(m: &mut WorkflowManifest, id: &str, sha: &str, file_count: u64) {
    match m.skills.iter_mut().find(|s| s.id == id) {
        Some(entry) => {
            entry.entry_sha256 = sha.to_string();
            entry.file_count = file_count;
            entry.library_sha = Some(sha.to_string());
        }
        None => {
            m.skills.push(manifest::SkillEntry {
                id: id.to_string(),
                source_id: None,
                entry_sha256: sha.to_string(),
                file_count,
                status: None,
                enabled: None,
                library_sha: Some(sha.to_string()),
                extra: Map::new(),
            });
            m.skills.sort_by(|a, b| a.id.cmp(&b.id));
        }
    }
}

/// 更新(库→工程):默认仅 LibraryAhead fast-forward 与 UpToDate 基线对齐;
/// adjudicated=true = 裁决结论"以库为准"的显式落地(可越过 workspaceAhead/diverged/untracked 门禁)。
pub fn update_from_library(
    workspace: &Path,
    library_dir: &Path,
    ids: &[String],
    adjudicated: bool,
) -> Result<Vec<SyncOpResult>, String> {
    let mut library_manifest = library::load_library(library_dir)?;
    if !library::refresh_library(library_dir, &mut library_manifest)?.is_empty() {
        library::save_library(library_dir, &library_manifest)?;
    }
    let mut results = Vec::new();
    for id in ids {
        results.push(
            update_one(workspace, library_dir, &library_manifest, id, adjudicated)
                .unwrap_or_else(|e| SyncOpResult::err(id, e)),
        );
    }
    Ok(results)
}

fn update_one(
    workspace: &Path,
    library_dir: &Path,
    library_manifest: &LibraryManifest,
    id: &str,
    adjudicated: bool,
) -> Result<SyncOpResult, String> {
    let mut ws_manifest = manifest::load(workspace)?;
    let facts = collect_facts(workspace, &ws_manifest, library_dir, library_manifest, id)?;
    let (state, stale, _) = judge(&facts);
    let lib_sha = facts
        .lib_sha
        .clone()
        .ok_or_else(|| "库内无此 skill 实体,无从更新".to_string())?;
    let ws_dir = manifest::skill_dir(workspace, id)?;
    match state {
        LineageState::UpToDate if !stale => {
            return Ok(SyncOpResult::ok(id, "alreadyUpToDate", lib_sha, 0));
        }
        LineageState::UpToDate => {
            let count = tree_digests(&ws_dir)?.len() as u64;
            upsert_ws_entry(&mut ws_manifest, id, &lib_sha, count);
            ws_manifest.generated_utc = Some(manifest::now_utc_rfc3339()?);
            manifest::save(workspace, &ws_manifest)?;
            return Ok(SyncOpResult::ok(id, "realigned", lib_sha, 0));
        }
        LineageState::LibraryAhead => {}
        LineageState::WorkspaceAhead if !adjudicated => {
            return Err("工程侧领先(workspaceAhead),应回流而非更新;裁决后确需以库为准再走 adjudicated".into());
        }
        LineageState::Diverged if !adjudicated => {
            return Err("已分叉(diverged):先注入终端裁决,结论为以库为准时再以 adjudicated 落地".into());
        }
        LineageState::Untracked if !adjudicated => {
            return Err("未建立谱系关联(untracked):同内容走收编即关联;异内容先裁决再 adjudicated 落地".into());
        }
        _ => {}
    }
    let lib_dir = library_dir.join(library::LIBRARY_SKILLS_DIR).join(id);
    let count = replace_skill_tree(&lib_dir, &ws_dir)?;
    upsert_ws_entry(&mut ws_manifest, id, &lib_sha, count);
    ws_manifest.generated_utc = Some(manifest::now_utc_rfc3339()?);
    manifest::save(workspace, &ws_manifest)?;
    let sync = super::adapters::sync_skill(workspace, &ws_manifest, id)?;
    Ok(SyncOpResult::ok(id, "updated", lib_sha, sync.written_adapters))
}

/// 回流(工程→库):默认仅 WorkspaceAhead 与 UpToDate 基线对齐;库现值 ≠ 基线一律 diverged 拒绝(设计原则 4);
/// adjudicated=true = 裁决结论"以工程为准"的显式落地(含 untracked 撞名关联)。逐项独立事务。
pub fn backflow_to_library(
    workspace: &Path,
    library_dir: &Path,
    ids: &[String],
    adjudicated: bool,
) -> Result<Vec<SyncOpResult>, String> {
    let mut results = Vec::new();
    for id in ids {
        results.push(
            backflow_one(workspace, library_dir, id, adjudicated)
                .unwrap_or_else(|e| SyncOpResult::err(id, e)),
        );
    }
    Ok(results)
}

fn backflow_one(
    workspace: &Path,
    library_dir: &Path,
    id: &str,
    adjudicated: bool,
) -> Result<SyncOpResult, String> {
    let mut library_manifest = library::load_library(library_dir)?;
    let drifted = library::refresh_library(library_dir, &mut library_manifest)?;
    if !drifted.is_empty() {
        library::save_library(library_dir, &library_manifest)?;
    }
    let mut ws_manifest = manifest::load(workspace)?;
    let facts = collect_facts(workspace, &ws_manifest, library_dir, &library_manifest, id)?;
    let (state, stale, _) = judge(&facts);
    let ws_sha = facts
        .ws_sha
        .clone()
        .ok_or_else(|| "工程 canonical 缺 SKILL.md,无从回流".to_string())?;
    let ws_dir = manifest::skill_dir(workspace, id)?;
    match state {
        LineageState::UpToDate if !stale => {
            return Ok(SyncOpResult::ok(id, "alreadyUpToDate", ws_sha, 0));
        }
        LineageState::UpToDate => {
            let count = tree_digests(&ws_dir)?.len() as u64;
            upsert_ws_entry(&mut ws_manifest, id, &ws_sha, count);
            ws_manifest.generated_utc = Some(manifest::now_utc_rfc3339()?);
            manifest::save(workspace, &ws_manifest)?;
            return Ok(SyncOpResult::ok(id, "realigned", ws_sha, 0));
        }
        LineageState::WorkspaceAhead => {}
        LineageState::LibraryAhead if !adjudicated => {
            return Err("库侧领先(libraryAhead),应更新而非回流;裁决后确需以工程为准再走 adjudicated".into());
        }
        LineageState::Diverged if !adjudicated => {
            return Err("已分叉(diverged):先注入终端裁决,结论为以工程为准时再以 adjudicated 落地".into());
        }
        LineageState::Untracked if !adjudicated => {
            return Err("未建立谱系关联(untracked):首次入库走收编;库有同名且内容不同时先裁决再 adjudicated 落地".into());
        }
        _ => {}
    }
    let lib_dir = library_dir.join(library::LIBRARY_SKILLS_DIR).join(id);
    let count = replace_skill_tree(&ws_dir, &lib_dir)?;
    let version = LibraryVersion {
        sha256: ws_sha.clone(),
        collected_utc: manifest::now_utc_rfc3339()?,
        source_workspace: Some(workspace.display().to_string()),
        extra: Map::new(),
    };
    match library_manifest.skills.iter_mut().find(|s| s.id == id) {
        Some(entry) => {
            entry.current_sha256 = ws_sha.clone();
            entry.file_count = count;
            entry.versions.push(version);
        }
        None => {
            library_manifest.skills.push(LibrarySkillEntry {
                id: id.to_string(),
                current_sha256: ws_sha.clone(),
                file_count: count,
                versions: vec![version],
                extra: Map::new(),
            });
            library_manifest.skills.sort_by(|a, b| a.id.cmp(&b.id));
        }
    }
    library::save_library(library_dir, &library_manifest)?;
    upsert_ws_entry(&mut ws_manifest, id, &ws_sha, count);
    ws_manifest.generated_utc = Some(manifest::now_utc_rfc3339()?);
    manifest::save(workspace, &ws_manifest)?;
    Ok(SyncOpResult::ok(id, "backflowed", ws_sha, 0))
}

/// 裁决指令文本(diverged/untracked 撞名等语义决断现场;plan-4 注入所选 agent 终端,主题群决策 3)。
pub fn conflict_brief(workspace: &Path, library_dir: &Path, id: &str) -> Result<String, String> {
    manifest::validate_skill_id(id)?;
    let library_manifest = library::load_library(library_dir)?;
    let ws_manifest = manifest::load(workspace)?;
    let facts = collect_facts(workspace, &ws_manifest, library_dir, &library_manifest, id)?;
    let (state, _, detail) = judge(&facts);
    let short = |sha: &Option<String>| match sha.as_deref() {
        Some(v) => v[..8.min(v.len())].to_string(),
        None => "无".to_string(),
    };
    let mut lines = vec![
        format!("skill「{id}」在工程与全局权威库之间需要语义裁决(机械层不代劳合并),请按现场与规程处置:"),
        format!(
            "- 状态: {}{}",
            state_name(state),
            detail.map(|d| format!(" —— {d}")).unwrap_or_default()
        ),
        format!(
            "- 工程侧: {} (SKILL.md sha {} / 谱系基线 {})",
            manifest::skill_dir(workspace, id)?.display(),
            short(&facts.ws_sha),
            short(&facts.base)
        ),
        format!(
            "- 库侧: {} (SKILL.md sha {})",
            library_dir.join(library::LIBRARY_SKILLS_DIR).join(id).display(),
            short(&facts.lib_sha)
        ),
    ];
    if facts.changed_files.is_empty() {
        lines.push("- 差异文件: (无逐文件差异,或有一侧目录不可枚举——见上方状态)".to_string());
    } else {
        lines.push("- 差异文件:".to_string());
        for c in &facts.changed_files {
            let tag = match c.kind {
                ChangeKind::WsOnly => "工程独有",
                ChangeKind::LibOnly => "库独有",
                ChangeKind::Differs => "内容不同",
            };
            lines.push(format!("  - {tag}: {}", c.path));
        }
    }
    lines.push("- 处置规程(三选一;合并只在工程 canonical 侧动文件,绝不直接改库内文件与工程薄壳):".to_string());
    lines.push("  1. 以工程为准: 审阅库侧差异确认可弃 → 在 HtyBox 执行「回流到库(裁决落地)」".to_string());
    lines.push("  2. 以库为准: 审阅工程侧差异确认可弃 → 在 HtyBox 执行「从库更新(裁决落地)」".to_string());
    lines.push("  3. 语义合并: 把两侧价值合并进工程 canonical 文件 → 在 HtyBox 执行「回流到库(裁决落地)」".to_string());
    lines.push("- 完成后重跑谱系对比,确认该 skill 为 upToDate。".to_string());
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn write(path: &PathBuf, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// 最小已初始化工程(双 provider 空登记)。
    fn setup_ws() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().to_path_buf();
        write(
            &ws.join(manifest::ENV_DIR).join(manifest::MANIFEST_FILE),
            r#"{
  "schemaVersion": 1,
  "providers": {
    "claude": { "adapterDir": ".claude/skills" },
    "codex": { "adapterDir": ".agents/skills" }
  },
  "skills": []
}"#,
        );
        (tmp, ws)
    }

    /// 添加 canonical skill(SKILL.md + 1 资源文件)并登记;返回 SKILL.md sha。
    fn add_skill(ws: &Path, id: &str, body: &str) -> String {
        let dir = ws.join(manifest::ENV_DIR).join(manifest::SKILLS_DIR).join(id);
        write(&dir.join(manifest::SKILL_ENTRY), body);
        write(&dir.join("references").join("r.md"), "res-v1");
        let mut m = manifest::load(ws).unwrap();
        m.skills.retain(|s| s.id != id);
        m.skills.push(manifest::SkillEntry {
            id: id.to_string(),
            source_id: None,
            entry_sha256: manifest::sha256_hex_upper(body.as_bytes()),
            file_count: 2,
            status: None,
            enabled: None,
            library_sha: None,
            extra: Map::new(),
        });
        m.skills.sort_by(|a, b| a.id.cmp(&b.id));
        manifest::save(ws, &m).unwrap();
        manifest::sha256_hex_upper(body.as_bytes())
    }

    fn fm(id: &str, ver: &str) -> String {
        format!("---\nname: {id}\n---\n{ver}\n")
    }

    #[test]
    fn five_state_matrix_with_existence_edges() {
        let (_w, ws) = setup_ws();
        let ltmp = tempfile::tempdir().unwrap();
        let lib = ltmp.path().join("global-env");
        // untracked(纯本地,库无同 id)
        add_skill(&ws, "local-only", &fm("local-only", "L1"));
        // upToDate
        add_skill(&ws, "even", &fm("even", "E1"));
        library::collect_skill(&ws, &lib, "even").unwrap();
        // libraryAhead: 收编后库侧外部演进(同时应报 libraryDrift)
        add_skill(&ws, "lib-moves", &fm("lib-moves", "M1"));
        library::collect_skill(&ws, &lib, "lib-moves").unwrap();
        fs::write(lib.join("skills/lib-moves/SKILL.md"), fm("lib-moves", "M2")).unwrap();
        // workspaceAhead: 收编后工程前进
        add_skill(&ws, "ws-moves", &fm("ws-moves", "W1"));
        library::collect_skill(&ws, &lib, "ws-moves").unwrap();
        fs::write(ws.join(".htyworkflows/skills/ws-moves/SKILL.md"), fm("ws-moves", "W2")).unwrap();
        // diverged: 双侧各自演进
        add_skill(&ws, "both-move", &fm("both-move", "B1"));
        library::collect_skill(&ws, &lib, "both-move").unwrap();
        fs::write(ws.join(".htyworkflows/skills/both-move/SKILL.md"), fm("both-move", "B2")).unwrap();
        fs::write(lib.join("skills/both-move/SKILL.md"), fm("both-move", "B3")).unwrap();
        // 资源级分叉: SKILL.md 一致而库侧资源变(设计原则 2 防漏判)
        add_skill(&ws, "res-drift", &fm("res-drift", "R1"));
        library::collect_skill(&ws, &lib, "res-drift").unwrap();
        fs::write(lib.join("skills/res-drift/references/r.md"), "res-v2").unwrap();
        // 库删除: 登记+实体被外部清除(基线断链)
        add_skill(&ws, "lib-gone", &fm("lib-gone", "G1"));
        library::collect_skill(&ws, &lib, "lib-gone").unwrap();
        let mut lm = library::load_library(&lib).unwrap();
        lm.skills.retain(|s| s.id != "lib-gone");
        library::save_library(&lib, &lm).unwrap();
        fs::remove_dir_all(lib.join("skills/lib-gone")).unwrap();
        // 工程删除(GHOST): canonical 目录被删而登记仍在
        add_skill(&ws, "ws-gone", &fm("ws-gone", "X1"));
        library::collect_skill(&ws, &lib, "ws-gone").unwrap();
        fs::remove_dir_all(ws.join(".htyworkflows/skills/ws-gone")).unwrap();
        // 基线陈旧: 双侧一致但 librarySha 被改旧
        add_skill(&ws, "stale-base", &fm("stale-base", "S1"));
        library::collect_skill(&ws, &lib, "stale-base").unwrap();
        let mut m = manifest::load(&ws).unwrap();
        m.skills.iter_mut().find(|s| s.id == "stale-base").unwrap().library_sha =
            Some("00OLD".into());
        manifest::save(&ws, &m).unwrap();
        // 第二工程贡献: libraryOnly + 撞名两态
        let (_w2, ws2) = setup_ws();
        add_skill(&ws2, "lib-extra", &fm("lib-extra", "T1"));
        library::collect_skill(&ws2, &lib, "lib-extra").unwrap();
        add_skill(&ws2, "collide", &fm("collide", "C1"));
        library::collect_skill(&ws2, &lib, "collide").unwrap();
        add_skill(&ws, "collide", &fm("collide", "C1")); // 同 id 同内容,无关联
        add_skill(&ws2, "collide2", &fm("collide2", "D1"));
        library::collect_skill(&ws2, &lib, "collide2").unwrap();
        add_skill(&ws, "collide2", &fm("collide2", "D2")); // 同 id 异内容,无关联

        let report = compare(&ws, &lib).unwrap();
        let get = |id: &str| report.skills.iter().find(|s| s.id == id).unwrap();
        assert_eq!(get("local-only").state, LineageState::Untracked);
        assert!(get("local-only").detail.is_none());
        assert_eq!(get("even").state, LineageState::UpToDate);
        assert!(!get("even").baseline_stale);
        assert_eq!(get("lib-moves").state, LineageState::LibraryAhead);
        assert!(report.library_drift.contains(&"lib-moves".to_string()));
        assert_eq!(get("ws-moves").state, LineageState::WorkspaceAhead);
        assert_eq!(get("both-move").state, LineageState::Diverged);
        let rd = get("res-drift");
        assert_eq!(rd.state, LineageState::Diverged, "正文没变资源变必须按变化处理");
        assert_eq!(rd.tree_match, Some(false));
        assert!(rd
            .changed_files
            .iter()
            .any(|c| c.path == "references/r.md" && c.kind == ChangeKind::Differs));
        assert_eq!(get("lib-gone").state, LineageState::Diverged);
        assert!(get("lib-gone").detail.as_deref().unwrap().contains("断链"));
        assert_eq!(get("ws-gone").state, LineageState::Diverged);
        assert!(get("ws-gone").detail.as_deref().unwrap().contains("GHOST"));
        let sb = get("stale-base");
        assert_eq!(sb.state, LineageState::UpToDate);
        assert!(sb.baseline_stale);
        assert_eq!(get("collide").state, LineageState::Untracked);
        assert!(get("collide").detail.as_deref().unwrap().contains("一致"));
        assert_eq!(get("collide2").state, LineageState::Untracked);
        assert!(get("collide2").detail.as_deref().unwrap().contains("不同"));
        // 库含出厂种子 htyenv-native-migrate（ensure_library 必装且工程无）→ 它也属 library_only，故用 contains 断言意图
        assert!(
            report.library_only.contains(&"lib-extra".to_string()),
            "lib-extra 应属 library_only: {:?}",
            report.library_only
        );
    }

    /// 失效基线:librarySha 被抬成工程现值,但该 sha 从未进入库版本史 → 不得误判 LibraryAhead。
    #[test]
    fn corrupt_baseline_not_in_library_history_is_diverged_not_library_ahead() {
        let (_w, ws) = setup_ws();
        let ltmp = tempfile::tempdir().unwrap();
        let lib = ltmp.path().join("global-env");
        add_skill(&ws, "svg-x", &fm("svg-x", "OLD"));
        library::collect_skill(&ws, &lib, "svg-x").unwrap();
        // 工程前进到 NEW,并把 librarySha 伪造成 NEW(模拟未回流却抬基线)
        let new_body = fm("svg-x", "NEW");
        let new_sha = manifest::sha256_hex_upper(new_body.as_bytes());
        fs::write(ws.join(".htyworkflows/skills/svg-x/SKILL.md"), &new_body).unwrap();
        let mut m = manifest::load(&ws).unwrap();
        let e = m.skills.iter_mut().find(|s| s.id == "svg-x").unwrap();
        e.entry_sha256 = new_sha.clone();
        e.library_sha = Some(new_sha);
        manifest::save(&ws, &m).unwrap();

        let report = compare(&ws, &lib).unwrap();
        let row = report.skills.iter().find(|s| s.id == "svg-x").unwrap();
        assert_eq!(
            row.state,
            LineageState::Diverged,
            "失效基线不得显示为可更新: {:?}",
            row.detail
        );
        assert!(
            row.detail.as_deref().unwrap_or("").contains("基线失效"),
            "detail={:?}",
            row.detail
        );

        // 对照:真 LibraryAhead(库文件外部演进、基线仍在版本史)仍应成立
        add_skill(&ws, "lib-ok", &fm("lib-ok", "A1"));
        library::collect_skill(&ws, &lib, "lib-ok").unwrap();
        fs::write(lib.join("skills/lib-ok/SKILL.md"), fm("lib-ok", "A2")).unwrap();
        let report2 = compare(&ws, &lib).unwrap();
        assert_eq!(
            report2.skills.iter().find(|s| s.id == "lib-ok").unwrap().state,
            LineageState::LibraryAhead
        );
    }

    #[test]
    fn update_fast_forward_realign_refusals_and_batch() {
        let (_w, ws) = setup_ws();
        let ltmp = tempfile::tempdir().unwrap();
        let lib = ltmp.path().join("global-env");
        add_skill(&ws, "ff", &fm("ff", "V1"));
        library::collect_skill(&ws, &lib, "ff").unwrap();
        fs::write(lib.join("skills/ff/SKILL.md"), fm("ff", "V2")).unwrap();
        fs::write(lib.join("skills/ff/references/r.md"), "res-v2").unwrap();
        add_skill(&ws, "wa", &fm("wa", "A1"));
        library::collect_skill(&ws, &lib, "wa").unwrap();
        fs::write(ws.join(".htyworkflows/skills/wa/SKILL.md"), fm("wa", "A2")).unwrap();

        let ids = ["ff".to_string(), "wa".to_string(), "nope".to_string()];
        let results = update_from_library(&ws, &lib, &ids, false).unwrap();
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].status.as_deref(), Some("updated"));
        assert_eq!(results[0].written_adapters, 2);
        assert_eq!(
            fs::read_to_string(ws.join(".htyworkflows/skills/ff/SKILL.md")).unwrap(),
            fm("ff", "V2")
        );
        assert_eq!(
            fs::read_to_string(ws.join(".htyworkflows/skills/ff/references/r.md")).unwrap(),
            "res-v2"
        );
        assert!(ws.join(".claude/skills/ff/SKILL.md").is_file(), "更新后薄壳应重生成");
        let m = manifest::load(&ws).unwrap();
        let e = m.skills.iter().find(|s| s.id == "ff").unwrap();
        assert_eq!(e.entry_sha256, manifest::sha256_hex_upper(fm("ff", "V2").as_bytes()));
        assert_eq!(e.library_sha.as_deref(), Some(e.entry_sha256.as_str()));
        assert!(results[1].error.as_deref().unwrap().contains("workspaceAhead"));
        assert!(results[2].error.is_some(), "未知 id 应逐项报错不连坐");
        let again = update_from_library(&ws, &lib, &ids[..1], false).unwrap();
        assert_eq!(again[0].status.as_deref(), Some("alreadyUpToDate"));
        let report = compare(&ws, &lib).unwrap();
        assert_eq!(
            report.skills.iter().find(|s| s.id == "ff").unwrap().state,
            LineageState::UpToDate
        );
        // diverged: 非裁决拒绝 → 裁决落地(以库为准)
        add_skill(&ws, "dv", &fm("dv", "D1"));
        library::collect_skill(&ws, &lib, "dv").unwrap();
        fs::write(ws.join(".htyworkflows/skills/dv/SKILL.md"), fm("dv", "D2")).unwrap();
        fs::write(lib.join("skills/dv/SKILL.md"), fm("dv", "D3")).unwrap();
        let dv = ["dv".to_string()];
        let denied = update_from_library(&ws, &lib, &dv, false).unwrap();
        assert!(denied[0].error.as_deref().unwrap().contains("diverged"));
        let forced = update_from_library(&ws, &lib, &dv, true).unwrap();
        assert_eq!(forced[0].status.as_deref(), Some("updated"));
        // 基线陈旧 → realign(零树写)
        add_skill(&ws, "st", &fm("st", "S1"));
        library::collect_skill(&ws, &lib, "st").unwrap();
        let mut m2 = manifest::load(&ws).unwrap();
        m2.skills.iter_mut().find(|s| s.id == "st").unwrap().library_sha = Some("00OLD".into());
        manifest::save(&ws, &m2).unwrap();
        let st = ["st".to_string()];
        let re = update_from_library(&ws, &lib, &st, false).unwrap();
        assert_eq!(re[0].status.as_deref(), Some("realigned"));
        let rep = compare(&ws, &lib).unwrap();
        assert!(!rep.skills.iter().find(|s| s.id == "st").unwrap().baseline_stale);
    }

    #[test]
    fn backflow_versions_cross_workspace_and_refusals() {
        let (_w, ws) = setup_ws();
        let ltmp = tempfile::tempdir().unwrap();
        let lib = ltmp.path().join("global-env");
        add_skill(&ws, "flow", &fm("flow", "F1"));
        library::collect_skill(&ws, &lib, "flow").unwrap();
        let (_w2, ws2) = setup_ws();
        library::fetch_skill(&lib, &ws2, "flow").unwrap();
        // 工程1 前进 → 回流:版本链追加+来源留痕+基线对齐
        fs::write(ws.join(".htyworkflows/skills/flow/SKILL.md"), fm("flow", "F2")).unwrap();
        let flow = ["flow".to_string()];
        let r = backflow_to_library(&ws, &lib, &flow, false).unwrap();
        assert_eq!(r[0].status.as_deref(), Some("backflowed"));
        let lm = library::load_library(&lib).unwrap();
        let le = lm.skills.iter().find(|s| s.id == "flow").unwrap();
        assert_eq!(le.versions.len(), 2);
        assert_eq!(le.current_sha256, manifest::sha256_hex_upper(fm("flow", "F2").as_bytes()));
        assert_eq!(
            le.versions[1].source_workspace.as_deref(),
            Some(ws.display().to_string().as_str())
        );
        let m = manifest::load(&ws).unwrap();
        assert_eq!(
            m.skills.iter().find(|s| s.id == "flow").unwrap().library_sha.as_deref(),
            Some(le.current_sha256.as_str())
        );
        // 另一工程视角: libraryAhead → 更新闭环 upToDate(Step 4 验证)
        let rep2 = compare(&ws2, &lib).unwrap();
        assert_eq!(rep2.skills.iter().find(|s| s.id == "flow").unwrap().state, LineageState::LibraryAhead);
        let up2 = update_from_library(&ws2, &lib, &flow, false).unwrap();
        assert_eq!(up2[0].status.as_deref(), Some("updated"));
        let rep2b = compare(&ws2, &lib).unwrap();
        assert_eq!(rep2b.skills.iter().find(|s| s.id == "flow").unwrap().state, LineageState::UpToDate);
        // 回流幂等
        let again = backflow_to_library(&ws, &lib, &flow, false).unwrap();
        assert_eq!(again[0].status.as_deref(), Some("alreadyUpToDate"));
        // 落后侧回流拒绝(libraryAhead)
        fs::write(ws.join(".htyworkflows/skills/flow/SKILL.md"), fm("flow", "F3")).unwrap();
        backflow_to_library(&ws, &lib, &flow, false).unwrap();
        let deny = backflow_to_library(&ws2, &lib, &flow, false).unwrap();
        assert!(deny[0].error.as_deref().unwrap().contains("libraryAhead"));
        // untracked 拒绝指向收编;撞名异内容 → 裁决落地(以工程为准建立关联)
        add_skill(&ws2, "orphan", &fm("orphan", "O1"));
        let orphan = ["orphan".to_string()];
        let d2 = backflow_to_library(&ws2, &lib, &orphan, false).unwrap();
        assert!(d2[0].error.as_deref().unwrap().contains("收编"));
        add_skill(&ws2, "clash", &fm("clash", "C-ws2"));
        library::collect_skill(&ws2, &lib, "clash").unwrap();
        add_skill(&ws, "clash", &fm("clash", "C-ws1"));
        let clash = ["clash".to_string()];
        assert!(backflow_to_library(&ws, &lib, &clash, false).unwrap()[0].error.is_some());
        let adj = backflow_to_library(&ws, &lib, &clash, true).unwrap();
        assert_eq!(adj[0].status.as_deref(), Some("backflowed"));
        let lm2 = library::load_library(&lib).unwrap();
        let ce = lm2.skills.iter().find(|s| s.id == "clash").unwrap();
        assert_eq!(ce.versions.len(), 2);
        assert_eq!(ce.current_sha256, manifest::sha256_hex_upper(fm("clash", "C-ws1").as_bytes()));
    }

    #[test]
    fn compare_with_absent_library_lists_all_as_untracked() {
        // 库尚未建立 = 空库:全部 canonical skill 应为 untracked(收编入口的数据前提;真实 BGE 首用即踩)
        let (_w, ws) = setup_ws();
        add_skill(&ws, "solo", &fm("solo", "S1"));
        let ltmp = tempfile::tempdir().unwrap();
        let lib = ltmp.path().join("never-created");
        let rep = compare(&ws, &lib).unwrap();
        assert!(!rep.library.present);
        assert_eq!(rep.skills.len(), 1);
        assert_eq!(rep.skills[0].state, LineageState::Untracked);
        assert!(rep.skills[0].ws_sha.is_some());
        assert!(rep.library_only.is_empty() && rep.library_drift.is_empty());
    }

    #[test]
    fn replace_tree_rollback_and_library_refresh() {
        // 源不可枚举 → 失败且目标原样、零 staging 残留
        let tmp = tempfile::tempdir().unwrap();
        let dst = tmp.path().join("skill-x");
        fs::create_dir_all(&dst).unwrap();
        fs::write(dst.join("SKILL.md"), "keep").unwrap();
        replace_skill_tree(&tmp.path().join("missing-src"), &dst).unwrap_err();
        assert_eq!(fs::read_to_string(dst.join("SKILL.md")).unwrap(), "keep");
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1, "不得留 staging/退位残留");
        // 库侧外部演进 → refresh 入版本链(来源未知),幂等
        let (_w, ws) = setup_ws();
        let ltmp = tempfile::tempdir().unwrap();
        let lib = ltmp.path().join("global-env");
        add_skill(&ws, "drift", &fm("drift", "D1"));
        library::collect_skill(&ws, &lib, "drift").unwrap();
        fs::write(lib.join("skills/drift/SKILL.md"), fm("drift", "D2")).unwrap();
        let mut lm = library::load_library(&lib).unwrap();
        let refreshed = library::refresh_library(&lib, &mut lm).unwrap();
        assert_eq!(refreshed, vec!["drift".to_string()]);
        let e = lm.skills.iter().find(|s| s.id == "drift").unwrap();
        assert_eq!(e.versions.len(), 2);
        assert!(e.versions[1].source_workspace.is_none(), "外部演进来源未知");
        assert!(library::refresh_library(&lib, &mut lm).unwrap().is_empty(), "二跑零刷新");
    }

    #[test]
    fn conflict_brief_contains_scene_and_rules() {
        let (_w, ws) = setup_ws();
        let ltmp = tempfile::tempdir().unwrap();
        let lib = ltmp.path().join("global-env");
        add_skill(&ws, "cb", &fm("cb", "B1"));
        library::collect_skill(&ws, &lib, "cb").unwrap();
        fs::write(ws.join(".htyworkflows/skills/cb/SKILL.md"), fm("cb", "B2")).unwrap();
        fs::write(lib.join("skills/cb/SKILL.md"), fm("cb", "B3")).unwrap();
        let brief = conflict_brief(&ws, &lib, "cb").unwrap();
        assert!(brief.contains("skill「cb」"));
        assert!(brief.contains("diverged"));
        let ws_dir = manifest::skill_dir(&ws, "cb").unwrap().display().to_string();
        assert!(brief.contains(&ws_dir), "必须给出工程侧绝对路径");
        let lib_dir = lib.join("skills").join("cb").display().to_string();
        assert!(brief.contains(&lib_dir), "必须给出库侧绝对路径");
        assert!(brief.contains("内容不同: SKILL.md"));
        assert!(brief.contains("回流到库(裁决落地)"));
        assert!(brief.contains("从库更新(裁决落地)"));
        assert!(brief.contains("语义合并"));
    }
}
