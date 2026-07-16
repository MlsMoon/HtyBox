// htyenv/managed.rs —— 官方受管模板文件的更新检测(谱系式基线三态,决策 1/2)。
// 只比对 template::managed_files()(Managed 策略);SeedOnce 永不入此判(仅由 init 补缺)。
// native 入口不在此列(受 protected_native_config 管控,永久排除)。
use std::collections::HashSet;
use std::path::Path;

use super::manifest::{self, WorkflowManifest};
use super::template;

/// 单个受管官方文件相对内置版本的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedState {
    /// 工作区缺失 → 由 init 的 will_write_files 补全(不在本模块列表)。
    Missing,
    /// 与内置一致 → 无操作。
    UpToDate,
    /// 已针对当前官方版裁决(合并/确认),保留本地变体(ws≠builtin 但 base==builtin)→ 无动作;官方再升级才重新提示。
    Reconciled,
    /// 与已装基线一致但内置已更新 → 安全一键更新。
    CleanOutdated,
    /// 与内置不同且无从证明是旧官方版(用户改过 / 首装无基线且异)→ 需逐项确认覆盖或注入裁决合并。
    Diverged,
}

/// 三态判定(纯函数,便于单测)。`ws==builtin` 优先,内容一致即最新。
pub fn judge(ws_sha: Option<&str>, base: Option<&str>, builtin_sha: &str) -> ManagedState {
    match ws_sha {
        None => ManagedState::Missing,
        Some(w) if w == builtin_sha => ManagedState::UpToDate,
        Some(w) => match base {
            // base==builtin(且 ws≠builtin)= 已针对当前官方版裁决、保留本地变体 → 无动作
            Some(b) if b == builtin_sha => ManagedState::Reconciled,
            // base==ws(且 ws≠builtin)= ws 仍是所记旧官方版、官方已更新 → 安全更新
            Some(b) if b == w => ManagedState::CleanOutdated,
            _ => ManagedState::Diverged,
        },
    }
}

/// 受管文件扫描结果(env 根相对路径分组)。
#[derive(Debug, Default)]
pub struct ManagedScan {
    /// 与已装基线一致但内置已更新 → 可安全一键更新。
    pub clean_outdated: Vec<String>,
    /// 本地已改动 / 首装无基线且内容异 → 需逐项确认覆盖或注入裁决合并。
    pub diverged: Vec<String>,
    /// 已裁决:ws≠builtin 但 base==builtin(保留本地变体)→ 无动作,单列供回溯。
    pub reconciled: Vec<String>,
    /// ws==builtin 但基线缺失/陈旧 → execute 时静默回填(内部用,不面向 UI)。
    pub backfill_baseline: Vec<String>,
}

impl ManagedScan {
    /// 会被专门归类的已存在 Managed 文件集(clean_outdated ∪ diverged ∪ reconciled),供 preview 从 skipped_existing 剔除避免双计。
    pub fn surfaced(&self) -> HashSet<String> {
        self.clean_outdated
            .iter()
            .chain(self.diverged.iter())
            .chain(self.reconciled.iter())
            .cloned()
            .collect()
    }
}

/// 扫描全部 Managed 官方文件(仅比对已存在者;缺失者归 init 补全)。
/// 读已存在文件失败即向上抛(不吞:避免把不可读文件误判 Missing 而覆盖)。
pub fn scan(workspace: &Path, manifest: &WorkflowManifest) -> Result<ManagedScan, String> {
    let root = manifest::env_root(workspace);
    let mut out = ManagedScan::default();
    for (rel, content) in template::managed_files() {
        let path = root.join(rel);
        let ws_sha = if path.is_file() {
            Some(manifest::sha256_file_upper(&path)?)
        } else {
            None
        };
        let builtin_sha = manifest::sha256_hex_upper(content.as_bytes());
        let base = manifest.managed_baseline(rel);
        match judge(ws_sha.as_deref(), base, &builtin_sha) {
            ManagedState::Missing => {}
            ManagedState::UpToDate => {
                if base != Some(builtin_sha.as_str()) {
                    out.backfill_baseline.push(rel.to_string());
                }
            }
            ManagedState::Reconciled => out.reconciled.push(rel.to_string()),
            ManagedState::CleanOutdated => out.clean_outdated.push(rel.to_string()),
            ManagedState::Diverged => out.diverged.push(rel.to_string()),
        }
    }
    Ok(out)
}

/// Managed 文件的内置内容查找(非受管返回 Err)。
fn builtin_content(rel: &str) -> Result<&'static str, String> {
    template::managed_files()
        .find(|(r, _)| *r == rel)
        .map(|(_, c)| c)
        .ok_or_else(|| format!("非受管官方文件(不支持裁决): {rel}"))
}

/// diverged 官方文件的注入裁决指令(收列表,单个传 [rel]、批量传全部):把每个官方内置版导出到
/// runtime/tmp 供 AI 读,生成一份语义合并指令文本(机械层不代劳合并,只给指令 + 官方内容;对齐 conflict_brief 契约)。
pub fn merge_brief(workspace: &Path, rels: &[String]) -> Result<String, String> {
    if rels.is_empty() {
        return Err("未指定要裁决的文件".into());
    }
    let root = manifest::env_root(workspace);
    let tmp_dir = root.join("runtime/tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建 {} 失败: {e}", tmp_dir.display()))?;
    let short = |s: &str| s[..8.min(s.len())].to_string();

    let mut lines = vec![format!(
        "以下 {} 个官方文件你本地改动过,需与官方内置版**语义合并**(保留你的改动 + 纳入官方更新),机械层不代劳,请在此终端逐个处置:",
        rels.len()
    )];
    for rel in rels {
        let builtin = builtin_content(rel)?;
        let ws_path = root.join(rel);
        if !ws_path.is_file() {
            return Err(format!("工程侧文件不存在: {}", ws_path.display()));
        }
        // 官方内置版内嵌于 HtyBox,AI 读不到 → 导出到 runtime/tmp 供其读文件对比合并
        let tmp_path = tmp_dir.join(format!("official-{}", rel.replace(['/', '\\'], "-")));
        super::write_atomic(&tmp_path, builtin.as_bytes())?;
        let ws_sha = manifest::sha256_file_upper(&ws_path)?;
        let builtin_sha = manifest::sha256_hex_upper(builtin.as_bytes());
        lines.push(String::new());
        lines.push(format!("● {rel}"));
        lines.push(format!("  - 你的本地版: {} (sha {})", ws_path.display(), short(&ws_sha)));
        lines.push(format!("  - 官方内置版(已导出): {} (sha {})", tmp_path.display(), short(&builtin_sha)));
    }
    lines.push(String::new());
    lines.push("- 合并规程: 对每个文件,读本地版与官方版 → 把官方更新合并进本地版、同时保留本地定制 → 把合并结果写回**本地版路径**(勿改官方临时文件)。".to_string());
    lines.push("- 全部完成后回 HtyBox「官方文件更新」卡点「全部标记已裁决」(或逐个「标记已裁决」),它们将不再提示(直到官方再次升级)。".to_string());
    Ok(lines.join("\n"))
}

/// 标记已裁决:对给定 Managed 文件设 base=当前内置 sha(不改内容),使之转 Reconciled、不再报 diverged。
pub fn reconcile(workspace: &Path, rels: &[String]) -> Result<usize, String> {
    let mut m = manifest::load(workspace)?;
    let mut n = 0;
    for rel in rels {
        let builtin = builtin_content(rel)?;
        m.upsert_managed_baseline(rel, &manifest::sha256_hex_upper(builtin.as_bytes()));
        n += 1;
    }
    if n > 0 {
        m.generated_utc = Some(manifest::now_utc_rfc3339()?);
        manifest::save(workspace, &m)?;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{manifest, template};

    #[test]
    fn judge_covers_five_states() {
        assert_eq!(judge(None, None, "B"), ManagedState::Missing);
        assert_eq!(judge(None, Some("X"), "B"), ManagedState::Missing);
        assert_eq!(judge(Some("B"), None, "B"), ManagedState::UpToDate, "内容==内置即最新");
        assert_eq!(judge(Some("B"), Some("A"), "B"), ManagedState::UpToDate, "ws==builtin 优先于基线");
        assert_eq!(judge(Some("A"), Some("B"), "B"), ManagedState::Reconciled, "ws≠内置但 base==内置=已裁决");
        assert_eq!(judge(Some("A"), Some("A"), "B"), ManagedState::CleanOutdated, "ws==base 且内置领先");
        assert_eq!(judge(Some("A"), None, "B"), ManagedState::Diverged, "首装无基线且内容异");
        assert_eq!(judge(Some("A"), Some("C"), "B"), ManagedState::Diverged, "ws 既非 base 又非 builtin");
    }

    #[test]
    fn scan_classifies_present_managed_file() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        let root = manifest::env_root(ws);
        let (rel, builtin) = template::managed_files().next().unwrap(); // 取一真实 Managed 文件
        std::fs::create_dir_all(root.join(rel).parent().unwrap()).unwrap();

        // 1) ws==builtin,无基线 → UpToDate 且列入 backfill
        std::fs::write(root.join(rel), builtin).unwrap();
        let mut m = template::factory_manifest();
        let s = scan(ws, &m).unwrap();
        assert!(!s.clean_outdated.contains(&rel.to_string()) && !s.diverged.contains(&rel.to_string()));
        assert!(s.backfill_baseline.contains(&rel.to_string()), "首装一致应回填基线");

        // 2) ws=旧官方,base=旧官方 → CleanOutdated
        std::fs::write(root.join(rel), b"OLD OFFICIAL").unwrap();
        m.upsert_managed_baseline(rel, &manifest::sha256_hex_upper(b"OLD OFFICIAL"));
        assert!(scan(ws, &m).unwrap().clean_outdated.contains(&rel.to_string()));

        // 3) ws=用户改,base=旧官方(≠ws)→ Diverged
        std::fs::write(root.join(rel), b"USER EDIT").unwrap();
        assert!(scan(ws, &m).unwrap().diverged.contains(&rel.to_string()));

        // 4) ws=用户改,无基线 → Diverged
        assert!(scan(ws, &template::factory_manifest()).unwrap().diverged.contains(&rel.to_string()));
    }

    #[test]
    fn merge_brief_exports_official_and_reconcile_marks_resolved() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        let root = manifest::env_root(ws);
        std::fs::create_dir_all(&root).unwrap();
        manifest::save(ws, &template::factory_manifest()).unwrap();
        let (rel, builtin) = template::managed_files().next().unwrap();
        std::fs::create_dir_all(root.join(rel).parent().unwrap()).unwrap();
        std::fs::write(root.join(rel), b"MY LOCAL EDIT").unwrap();

        // merge_brief:官方版导出到 runtime/tmp + 文本含两侧路径与规程
        let brief = merge_brief(ws, &[rel.to_string()]).unwrap();
        let tmp_off = root
            .join("runtime/tmp")
            .join(format!("official-{}", rel.replace(['/', '\\'], "-")));
        assert!(tmp_off.is_file(), "官方版应导出到 runtime/tmp");
        assert_eq!(std::fs::read(&tmp_off).unwrap(), builtin.as_bytes(), "导出内容==内置");
        assert!(brief.contains(rel) && brief.contains("语义合并") && brief.contains("标记已裁决"));

        // reconcile:设 base=builtin,不改内容,转 Reconciled、不再 diverged
        assert_eq!(reconcile(ws, &[rel.to_string()]).unwrap(), 1);
        assert_eq!(std::fs::read(root.join(rel)).unwrap(), b"MY LOCAL EDIT", "reconcile 不改内容");
        let s = scan(ws, &manifest::load(ws).unwrap()).unwrap();
        assert!(!s.diverged.contains(&rel.to_string()), "reconcile 后不再 diverged");
        assert!(s.reconciled.contains(&rel.to_string()), "reconcile 后为 Reconciled");
    }
}
