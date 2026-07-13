// htyenv/adapters.rs —— 薄壳适配器生成/对账(契约 v1,与 tools/sync-adapters.ps1 及
// HtyHubApp buildAdapterContent 字节一致):
//   适配器 = canonical SKILL.md 的 frontmatter 原字节块(含可选 BOM 与结尾换行) + "\n" + LF 模板;
//   无 frontmatter 时 = 纯模板。codex 发现层 metadata(canonical <id>/agents/*)逐字节同步。
// check 三态:缺失 / 陈旧(含生成标记但字节不符) / 手改(无标记);另报孤儿薄壳(缺真版,PS 版无此检测)。
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use super::manifest::{self, WorkflowManifest, SKILL_ENTRY};
use super::write_atomic;

pub(crate) const ADAPTER_MARK: &str = "AUTO-GENERATED ADAPTER (hty-sync-adapters v1)";
/// 发现层 metadata 仅 Codex 链路需要(adapters/README 名册);按 provider 键定位其 adapterDir。
const METADATA_PROVIDER: &str = "codex";
const METADATA_SUBDIR: &str = "agents";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AdapterState {
    /// 与 canonical 期望字节全等
    Consistent,
    /// 含生成标记但字节不符(canonical 已变,需重生成)
    Stale,
    /// 无生成标记(被手改/旧正文),sync 时按约定覆盖并留痕
    HandEdited,
    /// 薄壳文件缺失
    Missing,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAdapterCheck {
    pub id: String,
    /// provider → 薄壳状态(供仪表盘 Skills 页入口图标与检查态)
    pub states: BTreeMap<String, AdapterState>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanShell {
    pub provider: String,
    pub id: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCheckReport {
    pub skills: Vec<SkillAdapterCheck>,
    /// canonical 目录存在但缺 SKILL.md 入口
    pub canonical_missing_entry: Vec<String>,
    /// 薄壳孤儿(缺真版):adapterDir 下存在、canonical 无对应目录
    pub orphan_shells: Vec<OrphanShell>,
    /// codex 发现层 metadata 缺失(provider 相对路径)
    pub metadata_missing: Vec<String>,
    /// codex 发现层 metadata 与 canonical 字节不同步
    pub metadata_out_of_sync: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub written_adapters: usize,
    pub written_metadata: usize,
    /// 下架 skill 被清除的薄壳目录数(plan-5 决策 1A)
    pub removed_adapters: usize,
    /// 被覆盖的手改薄壳("provider/id",决策 3 留痕)
    pub overwrote_hand_edited: Vec<String>,
    pub canonical_missing_entry: Vec<String>,
}

impl SyncOutcome {
    fn empty() -> Self {
        Self {
            written_adapters: 0,
            written_metadata: 0,
            removed_adapters: 0,
            overwrote_hand_edited: Vec::new(),
            canonical_missing_entry: Vec::new(),
        }
    }
}

/// 契约 v1 frontmatter 原字节切取:与 PS 正则 `(?s)^﻿?---\r?\n.*?\r?\n---(\r?\n|$)` 逐语义一致
/// (按 .NET 语义 lossy 解码后切取再编码;开头行后至少隔一个换行才可闭合,零行体不匹配)。
pub(crate) fn slice_frontmatter_bytes(raw: &[u8]) -> Option<Vec<u8>> {
    let text = String::from_utf8_lossy(raw);
    let s: &str = &text;
    let mut pos = 0usize;
    if let Some(rest) = s.strip_prefix('\u{feff}') {
        pos = s.len() - rest.len();
    }
    if !s[pos..].starts_with("---") {
        return None;
    }
    let mut cursor = pos + 3;
    cursor += eat_newline(&s[cursor..])?;
    loop {
        // 先无条件推进一行(闭合行不可能是开头行的紧邻同一行界),再看新行首是否恰为 "---"
        let next = s[cursor..].find('\n')?;
        cursor += next + 1;
        if s[cursor..].starts_with("---") {
            let after = cursor + 3;
            if let Some(n) = eat_newline(&s[after..]) {
                return Some(s[..after + n].as_bytes().to_vec());
            }
            if after == s.len() {
                return Some(s[..after].as_bytes().to_vec());
            }
            // "---xxx" 非闭合行,继续走行
        }
    }
}

fn eat_newline(s: &str) -> Option<usize> {
    if s.starts_with("\r\n") {
        Some(2)
    } else if s.starts_with('\n') {
        Some(1)
    } else {
        None
    }
}

/// 按契约 v1 构造薄壳完整字节(模板恒 LF;entrySha256 = canonical 整文件 SHA-256 大写)。
pub fn build_adapter_bytes(skill_id: &str, canonical_raw: &[u8]) -> Vec<u8> {
    let hash = manifest::sha256_hex_upper(canonical_raw);
    let template = [
        format!("<!-- {ADAPTER_MARK} - DO NOT EDIT -->"),
        format!("<!-- canonical: .htyworkflows/skills/{skill_id}/SKILL.md -->"),
        format!("<!-- entrySha256: {hash} -->"),
        String::new(),
        "本文件是自动生成的薄适配器,正文唯一权威源位于 canonical 目录:".to_string(),
        String::new(),
        format!("**请读取并完整遵循 `.htyworkflows/skills/{skill_id}/SKILL.md`**(其 references/、scripts/、assets/ 等相对资源一律以该 canonical 目录为基准解析;本适配器目录不存放业务内容,禁止手改——修改请编辑 canonical 后运行 .htyworkflows/tools/sync-adapters.ps1)。"),
        String::new(),
    ]
    .join("\n");
    match slice_frontmatter_bytes(canonical_raw) {
        Some(mut bytes) => {
            bytes.push(b'\n');
            bytes.extend_from_slice(template.as_bytes());
            bytes
        }
        None => template.into_bytes(),
    }
}

/// provider adapterDir 解析:workspace 相对路径,拒绝绝对/盘符/UNC/越界成分(manifest 属工作区输入,不可信任)。
fn resolve_adapter_root(
    workspace: &Path,
    provider: &str,
    adapter_dir: &str,
) -> Result<PathBuf, String> {
    let path = Path::new(adapter_dir);
    let plain = !adapter_dir.is_empty()
        && !adapter_dir.contains(':')
        && !path.is_absolute()
        && path.components().all(|c| matches!(c, Component::Normal(_)));
    if !plain {
        return Err(format!("provider {provider} 的 adapterDir 非法: {adapter_dir:?}"));
    }
    Ok(workspace.join(path))
}

fn adapter_roots(
    workspace: &Path,
    manifest: &WorkflowManifest,
) -> Result<Vec<(String, PathBuf)>, String> {
    manifest
        .providers
        .iter()
        .map(|(name, cfg)| Ok((name.clone(), resolve_adapter_root(workspace, name, &cfg.adapter_dir)?)))
        .collect()
}

fn read_err(path: &Path) -> impl Fn(std::io::Error) -> String + '_ {
    move |e| format!("读取 {} 失败: {e}", path.display())
}

/// 只读对账:canonical 全集 × 全部在册 provider 的薄壳三态 + 孤儿薄壳 + codex metadata 同步性。
pub fn check_adapters(
    workspace: &Path,
    manifest: &WorkflowManifest,
) -> Result<AdapterCheckReport, String> {
    let roots = adapter_roots(workspace, manifest)?;
    let ids = super::list_skill_dirs(workspace)?;
    let id_set: BTreeSet<&str> = ids.iter().map(String::as_str).collect();
    let mut report = AdapterCheckReport::default();

    for id in &ids {
        let canonical_entry = manifest::skill_dir(workspace, id)?.join(SKILL_ENTRY);
        if !canonical_entry.is_file() {
            report.canonical_missing_entry.push(id.clone());
            continue;
        }
        // 下架 skill(决策 1A):预期=各端无薄壳;残留薄壳报陈旧(sync 时清除并留痕)
        if !manifest.skill_enabled(id) {
            let mut states = BTreeMap::new();
            for (provider, root) in &roots {
                let state = if root.join(id).join(SKILL_ENTRY).is_file() {
                    AdapterState::Stale
                } else {
                    AdapterState::Consistent
                };
                states.insert(provider.clone(), state);
            }
            report.skills.push(SkillAdapterCheck { id: id.clone(), states });
            continue;
        }
        let raw = fs::read(&canonical_entry).map_err(read_err(&canonical_entry))?;
        let expect = build_adapter_bytes(id, &raw);
        let mut states = BTreeMap::new();
        for (provider, root) in &roots {
            let dst = root.join(id).join(SKILL_ENTRY);
            let state = if !dst.is_file() {
                AdapterState::Missing
            } else {
                let current = fs::read(&dst).map_err(read_err(&dst))?;
                if current == expect {
                    AdapterState::Consistent
                } else if String::from_utf8_lossy(&current).contains(ADAPTER_MARK) {
                    AdapterState::Stale
                } else {
                    AdapterState::HandEdited
                }
            };
            states.insert(provider.clone(), state);
        }
        check_metadata(workspace, manifest, id, &mut report)?;
        report.skills.push(SkillAdapterCheck { id: id.clone(), states });
    }

    for (provider, root) in &roots {
        for name in super::sorted_child_names(root, true, |n| !n.starts_with('.'))? {
            if !id_set.contains(name.as_str()) {
                report.orphan_shells.push(OrphanShell {
                    provider: provider.clone(),
                    id: name,
                });
            }
        }
    }
    Ok(report)
}

/// codex 发现层 metadata 对账:canonical <id>/agents/* 与 .agents 侧字节一致性。
fn check_metadata(
    workspace: &Path,
    manifest_data: &WorkflowManifest,
    id: &str,
    report: &mut AdapterCheckReport,
) -> Result<(), String> {
    let Some(cfg) = manifest_data.providers.get(METADATA_PROVIDER) else {
        return Ok(());
    };
    let src_dir = manifest::skill_dir(workspace, id)?.join(METADATA_SUBDIR);
    if !src_dir.is_dir() {
        return Ok(());
    }
    let root = resolve_adapter_root(workspace, METADATA_PROVIDER, &cfg.adapter_dir)?;
    for name in super::sorted_child_names(&src_dir, false, |_| true)? {
        let src = src_dir.join(&name);
        let dst = root.join(id).join(METADATA_SUBDIR).join(&name);
        let rel = format!("{id}/{METADATA_SUBDIR}/{name}");
        if !dst.is_file() {
            report.metadata_missing.push(rel);
            continue;
        }
        let src_bytes = fs::read(&src).map_err(read_err(&src))?;
        let dst_bytes = fs::read(&dst).map_err(read_err(&dst))?;
        if src_bytes != dst_bytes {
            report.metadata_out_of_sync.push(rel);
        }
    }
    Ok(())
}

/// 全量重生成(sync 模式,决策 3):canonical 全集 × 全部在册 provider 无条件写期望字节;
/// 覆盖前发现无标记内容则记入 overwrote_hand_edited 留痕;孤儿薄壳不动(只报告,处理属人工)。
pub fn sync_adapters(
    workspace: &Path,
    manifest: &WorkflowManifest,
) -> Result<SyncOutcome, String> {
    let roots = adapter_roots(workspace, manifest)?;
    let ids = super::list_skill_dirs(workspace)?;
    let mut outcome = SyncOutcome::empty();
    for id in &ids {
        sync_one(workspace, manifest, &roots, id, &mut outcome)?;
    }
    Ok(outcome)
}

/// 单 skill 重生成(取件/新建后的定点同步,与全量 sync 同一实现)。
pub fn sync_skill(
    workspace: &Path,
    manifest: &WorkflowManifest,
    id: &str,
) -> Result<SyncOutcome, String> {
    manifest::validate_skill_id(id)?;
    let roots = adapter_roots(workspace, manifest)?;
    let mut outcome = SyncOutcome::empty();
    sync_one(workspace, manifest, &roots, id, &mut outcome)?;
    Ok(outcome)
}

/// 上下架(plan-5 决策 1A=G3):启用态=manifest 元数据;下架删各端薄壳,上架重生成;canonical 目录不动。
/// UNREGISTERED 拒绝——启用态挂在登记项上,先机械同步补登。
pub fn set_skill_enabled(
    workspace: &Path,
    id: &str,
    enabled: bool,
) -> Result<SyncOutcome, String> {
    manifest::validate_skill_id(id)?;
    let mut m = manifest::load(workspace)?;
    let Some(entry) = m.skills.iter_mut().find(|s| s.id == id) else {
        return Err(format!("{id} 未登记(UNREGISTERED)——先跑机械同步补登再启停"));
    };
    entry.enabled = if enabled { None } else { Some(false) };
    manifest::save(workspace, &m)?;
    sync_skill(workspace, &m, id)
}

/// 模板应用(canonical 语义):清单内=启用、其余登记项=停用;未登记 id 记 warnings;一次全量同步落实。
pub fn apply_enabled_set(
    workspace: &Path,
    enabled_ids: &[String],
) -> Result<(SyncOutcome, Vec<String>), String> {
    let mut m = manifest::load(workspace)?;
    let known: BTreeSet<&str> = m.skills.iter().map(|s| s.id.as_str()).collect();
    let mut warnings = Vec::new();
    for id in enabled_ids {
        if !known.contains(id.as_str()) {
            warnings.push(format!("{id} 未登记(UNREGISTERED),未纳入启停"));
        }
    }
    let target: BTreeSet<&str> = enabled_ids.iter().map(String::as_str).collect();
    for entry in &mut m.skills {
        entry.enabled = if target.contains(entry.id.as_str()) {
            None
        } else {
            Some(false)
        };
    }
    manifest::save(workspace, &m)?;
    let outcome = sync_adapters(workspace, &m)?;
    Ok((outcome, warnings))
}

fn sync_one(
    workspace: &Path,
    manifest_data: &WorkflowManifest,
    roots: &[(String, PathBuf)],
    id: &str,
    outcome: &mut SyncOutcome,
) -> Result<(), String> {
    let canonical_entry = manifest::skill_dir(workspace, id)?.join(SKILL_ENTRY);
    if !canonical_entry.is_file() {
        outcome.canonical_missing_entry.push(id.to_string());
        return Ok(());
    }
    // 下架 skill:各端薄壳目录清除(含 codex metadata 随目录一并移除)
    if !manifest_data.skill_enabled(id) {
        for (_, root) in roots {
            let dir = root.join(id);
            if dir.is_dir() {
                fs::remove_dir_all(&dir).map_err(|e| format!("清除 {} 失败: {e}", dir.display()))?;
                outcome.removed_adapters += 1;
            }
        }
        return Ok(());
    }
    let raw = fs::read(&canonical_entry).map_err(read_err(&canonical_entry))?;
    let expect = build_adapter_bytes(id, &raw);
    for (provider, root) in roots {
        let dir = root.join(id);
        fs::create_dir_all(&dir).map_err(|e| format!("创建 {} 失败: {e}", dir.display()))?;
        remove_wrong_case_entry(&dir)?;
        let dst = dir.join(SKILL_ENTRY);
        if dst.is_file() {
            let current = fs::read(&dst).map_err(read_err(&dst))?;
            if current != expect && !String::from_utf8_lossy(&current).contains(ADAPTER_MARK) {
                outcome.overwrote_hand_edited.push(format!("{provider}/{id}"));
            }
        }
        write_atomic(&dst, &expect)?;
        outcome.written_adapters += 1;
    }
    outcome.written_metadata += sync_metadata(workspace, manifest_data, id)?;
    Ok(())
}

/// codex 发现层 metadata 同步:canonical <id>/agents/* 逐字节拷到 codex adapterDir 侧。
fn sync_metadata(
    workspace: &Path,
    manifest_data: &WorkflowManifest,
    id: &str,
) -> Result<usize, String> {
    let Some(cfg) = manifest_data.providers.get(METADATA_PROVIDER) else {
        return Ok(0);
    };
    let src_dir = manifest::skill_dir(workspace, id)?.join(METADATA_SUBDIR);
    if !src_dir.is_dir() {
        return Ok(0);
    }
    let root = resolve_adapter_root(workspace, METADATA_PROVIDER, &cfg.adapter_dir)?;
    let dst_dir = root.join(id).join(METADATA_SUBDIR);
    fs::create_dir_all(&dst_dir).map_err(|e| format!("创建 {} 失败: {e}", dst_dir.display()))?;
    let mut written = 0usize;
    for name in super::sorted_child_names(&src_dir, false, |_| true)? {
        let src = src_dir.join(&name);
        let bytes = fs::read(&src).map_err(read_err(&src))?;
        write_atomic(&dst_dir.join(&name), &bytes)?;
        written += 1;
    }
    Ok(written)
}

/// Windows 大小写防御:同名不同大小写的入口文件先删后写(覆盖写不改既有文件名,BGE 踩坑先例)。
fn remove_wrong_case_entry(dir: &Path) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| format!("读取 {} 失败: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("读取 {} 失败: {e}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.eq_ignore_ascii_case(SKILL_ENTRY) && name != SKILL_ENTRY {
            fs::remove_file(entry.path())
                .map_err(|e| format!("移除大小写异常入口 {} 失败: {e}", entry.path().display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_slicing_matches_ps_regex_semantics() {
        // LF 常规:含结尾换行
        assert_eq!(
            slice_frontmatter_bytes(b"---\nname: a\n---\nbody").unwrap(),
            b"---\nname: a\n---\n".to_vec()
        );
        // CRLF 保留原字节
        assert_eq!(
            slice_frontmatter_bytes(b"---\r\nname: a\r\n---\r\nbody").unwrap(),
            b"---\r\nname: a\r\n---\r\n".to_vec()
        );
        // BOM 计入切片
        let bom = b"\xEF\xBB\xBF---\nx\n---\n";
        assert_eq!(slice_frontmatter_bytes(bom).unwrap(), bom.to_vec());
        // 闭合行在 EOF(无结尾换行)
        assert_eq!(
            slice_frontmatter_bytes(b"---\nx\n---").unwrap(),
            b"---\nx\n---".to_vec()
        );
        // 空行体可闭合
        assert_eq!(
            slice_frontmatter_bytes(b"---\n\n---\n").unwrap(),
            b"---\n\n---\n".to_vec()
        );
        // 零行体不匹配(.NET 正则需 .*?\r?\n 在闭合前)
        assert!(slice_frontmatter_bytes(b"---\n---\n").is_none());
        // 开头行未紧跟换行不匹配
        assert!(slice_frontmatter_bytes(b"---x\ny\n---\n").is_none());
        // 无 frontmatter
        assert!(slice_frontmatter_bytes(b"# title\n").is_none());
        // "----" 非闭合行,闭合取更后面的 "---"
        assert_eq!(
            slice_frontmatter_bytes(b"---\n----\n---\nbody").unwrap(),
            b"---\n----\n---\n".to_vec()
        );
    }

    #[test]
    fn build_adapter_bytes_exact_contract() {
        let canonical = b"---\nname: demo\n---\nbody\n";
        let hash = manifest::sha256_hex_upper(canonical);
        let expect = format!(
            "---\nname: demo\n---\n\n<!-- AUTO-GENERATED ADAPTER (hty-sync-adapters v1) - DO NOT EDIT -->\n<!-- canonical: .htyworkflows/skills/demo/SKILL.md -->\n<!-- entrySha256: {hash} -->\n\n本文件是自动生成的薄适配器,正文唯一权威源位于 canonical 目录:\n\n**请读取并完整遵循 `.htyworkflows/skills/demo/SKILL.md`**(其 references/、scripts/、assets/ 等相对资源一律以该 canonical 目录为基准解析;本适配器目录不存放业务内容,禁止手改——修改请编辑 canonical 后运行 .htyworkflows/tools/sync-adapters.ps1)。\n"
        );
        assert_eq!(build_adapter_bytes("demo", canonical), expect.into_bytes());
        // 无 frontmatter:纯模板,无前置空行
        let plain = build_adapter_bytes("demo", b"no frontmatter\n");
        assert!(plain.starts_with(b"<!-- AUTO-GENERATED"));
    }

    fn setup_env() -> (tempfile::TempDir, WorkflowManifest) {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        let manifest_text = r#"{
  "schemaVersion": 1,
  "providers": {
    "claude": { "adapterDir": ".claude/skills" },
    "codex": { "adapterDir": ".agents/skills" }
  },
  "skills": []
}"#;
        let root = ws.join(manifest::ENV_DIR);
        fs::create_dir_all(root.join("skills/alpha/agents")).unwrap();
        fs::write(root.join(manifest::MANIFEST_FILE), manifest_text).unwrap();
        fs::write(root.join("skills/alpha/SKILL.md"), b"---\nname: alpha\n---\nA\n").unwrap();
        fs::write(root.join("skills/alpha/agents/openai.yaml"), b"meta: 1\n").unwrap();
        let m = manifest::load(ws).unwrap();
        (tmp, m)
    }

    #[test]
    fn sync_then_check_full_cycle_and_three_states() {
        let (tmp, m) = setup_env();
        let ws = tmp.path();
        let out = sync_adapters(ws, &m).unwrap();
        assert_eq!(out.written_adapters, 2);
        assert_eq!(out.written_metadata, 1);
        assert!(out.overwrote_hand_edited.is_empty());

        let report = check_adapters(ws, &m).unwrap();
        assert_eq!(report.skills.len(), 1);
        assert!(report.skills[0].states.values().all(|s| *s == AdapterState::Consistent));
        assert!(report.orphan_shells.is_empty());
        assert!(report.metadata_missing.is_empty() && report.metadata_out_of_sync.is_empty());

        // 陈旧:canonical 变化后旧薄壳含标记但字节不符
        fs::write(ws.join(manifest::ENV_DIR).join("skills/alpha/SKILL.md"), b"---\nname: alpha2\n---\nB\n").unwrap();
        let stale = check_adapters(ws, &m).unwrap();
        assert!(stale.skills[0].states.values().all(|s| *s == AdapterState::Stale));

        // 手改:无标记内容;缺失:删除
        fs::write(ws.join(".claude/skills/alpha/SKILL.md"), b"hacked").unwrap();
        fs::remove_file(ws.join(".agents/skills/alpha/SKILL.md")).unwrap();
        let mixed = check_adapters(ws, &m).unwrap();
        assert_eq!(mixed.skills[0].states["claude"], AdapterState::HandEdited);
        assert_eq!(mixed.skills[0].states["codex"], AdapterState::Missing);

        // sync 恢复:覆盖手改留痕
        let resync = sync_adapters(ws, &m).unwrap();
        assert_eq!(resync.overwrote_hand_edited, vec!["claude/alpha".to_string()]);
        let green = check_adapters(ws, &m).unwrap();
        assert!(green.skills[0].states.values().all(|s| *s == AdapterState::Consistent));
    }

    #[test]
    fn enabled_toggle_full_cycle() {
        let (tmp, m) = setup_env();
        let ws = tmp.path();
        let mut m2 = m;
        m2.skills.push(manifest::SkillEntry {
            id: "alpha".into(),
            source_id: None,
            entry_sha256: "00".into(),
            file_count: 2,
            status: None,
            enabled: None,
            library_sha: None,
            extra: serde_json::Map::new(),
        });
        manifest::save(ws, &m2).unwrap();
        sync_adapters(ws, &m2).unwrap();
        assert!(ws.join(".claude/skills/alpha/SKILL.md").is_file());

        // 未登记启停拒绝(启用态挂在登记项)
        assert!(set_skill_enabled(ws, "nope", false).unwrap_err().contains("UNREGISTERED"));

        // 下架:各端薄壳目录清除;check 预期无壳=一致
        let off = set_skill_enabled(ws, "alpha", false).unwrap();
        assert_eq!(off.removed_adapters, 2);
        assert!(!ws.join(".claude/skills/alpha").exists());
        assert!(!ws.join(".agents/skills/alpha").exists());
        let m3 = manifest::load(ws).unwrap();
        assert_eq!(m3.skills[0].enabled, Some(false));
        let rep = check_adapters(ws, &m3).unwrap();
        assert!(
            rep.skills[0].states.values().all(|s| *s == AdapterState::Consistent),
            "下架且无壳应为一致"
        );
        // 下架残壳报陈旧,sync 清残
        fs::create_dir_all(ws.join(".claude/skills/alpha")).unwrap();
        fs::write(ws.join(".claude/skills/alpha/SKILL.md"), b"leftover").unwrap();
        assert_eq!(check_adapters(ws, &m3).unwrap().skills[0].states["claude"], AdapterState::Stale);
        assert_eq!(sync_adapters(ws, &m3).unwrap().removed_adapters, 1);

        // 上架:重生成;enabled 恢复缺省(字段省略)
        let on = set_skill_enabled(ws, "alpha", true).unwrap();
        assert_eq!(on.written_adapters, 2);
        let m4 = manifest::load(ws).unwrap();
        assert_eq!(m4.skills[0].enabled, None, "启用=缺省字段不落盘");
        assert!(check_adapters(ws, &m4).unwrap().skills[0]
            .states
            .values()
            .all(|s| *s == AdapterState::Consistent));

        // 模板语义:清单外全下架;未登记 id 记 warning
        let (out, warns) = apply_enabled_set(ws, &["ghost-x".to_string()]).unwrap();
        assert_eq!(out.removed_adapters, 2);
        assert_eq!(warns.len(), 1);
        assert_eq!(manifest::load(ws).unwrap().skills[0].enabled, Some(false));
    }

    #[test]
    fn orphan_metadata_and_case_defense() {
        let (tmp, m) = setup_env();
        let ws = tmp.path();
        // 大小写异常入口:先放小写 skill.md,sync 后目录内应只剩精确大写
        let dir = ws.join(".claude/skills/alpha");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("skill.md"), b"old lower").unwrap();
        sync_adapters(ws, &m).unwrap();
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![SKILL_ENTRY.to_string()], "应只剩精确大写入口: {names:?}");

        // 孤儿薄壳(缺真版)
        fs::create_dir_all(ws.join(".agents/skills/ghost")).unwrap();
        // metadata 篡改 → 不同步
        fs::write(ws.join(".agents/skills/alpha/agents/openai.yaml"), b"meta: 2\n").unwrap();
        let report = check_adapters(ws, &m).unwrap();
        assert_eq!(report.orphan_shells.len(), 1);
        assert_eq!(report.orphan_shells[0].provider, "codex");
        assert_eq!(report.orphan_shells[0].id, "ghost");
        assert_eq!(report.metadata_out_of_sync, vec!["alpha/agents/openai.yaml".to_string()]);

        // canonical 目录缺入口
        fs::create_dir_all(ws.join(manifest::ENV_DIR).join("skills/noentry")).unwrap();
        let r2 = check_adapters(ws, &m).unwrap();
        assert_eq!(r2.canonical_missing_entry, vec!["noentry".to_string()]);
    }

    #[test]
    fn adapter_dir_traversal_rejected() {
        let (tmp, mut m) = setup_env();
        m.providers.get_mut("claude").unwrap().adapter_dir = "../outside".into();
        assert!(check_adapters(tmp.path(), &m).is_err());
        m.providers.get_mut("claude").unwrap().adapter_dir = "C:/abs".into();
        assert!(check_adapters(tmp.path(), &m).is_err());
    }
}
