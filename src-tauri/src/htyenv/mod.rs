// htyenv/ —— hty 工作流环境(.htyworkflows)机械层引擎。
// 权威方向恒为 canonical(.htyworkflows) → 各 Agent 薄壳/缓存;语义裁决(CONFLICT/UNCURATED 等)只报告绝不代劳。
// 子模块按子域划分,随计划 Step 逐个落位。
pub mod adapters;
pub mod dashboard;
pub mod init;
pub mod library;
pub mod lineage;
pub mod manifest;
pub mod memory_sync;
pub mod report;
pub mod template;
pub mod verify;

use std::fs;
use std::path::Path;

use serde::Serialize;

/// 环境识别结果:仪表盘状态卡/欢迎页就绪徽标的数据源。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvStatus {
    pub present: bool,
    pub readme_present: bool,
    pub manifest_present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registered_skills: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_skill_dirs: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roster: Option<RosterStatus>,
}

/// 名册三方对账(sync-all ① 同语义):adapters/ 子目录集 = manifest.providers 键集 = rules/<agent>.md 文件集(common.md 除外)。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterStatus {
    pub adapter_dirs: Vec<String>,
    pub providers: Vec<String>,
    pub rule_files: Vec<String>,
    pub consistent: bool,
}

/// 识别工作区 hty 环境:不存在不是错误,是一种状态;manifest 损坏记入 manifest_error 而非失败。
pub fn detect(workspace: &Path) -> Result<EnvStatus, String> {
    let root = manifest::env_root(workspace);
    if !root.is_dir() {
        return Ok(EnvStatus {
            present: false,
            readme_present: false,
            manifest_present: false,
            manifest_error: None,
            schema_version: None,
            registered_skills: None,
            canonical_skill_dirs: None,
            roster: None,
        });
    }
    let readme_present = root.join("README.md").is_file();
    let manifest_present = manifest::manifest_path(workspace).is_file();
    let (loaded, manifest_error) = if manifest_present {
        match manifest::load(workspace) {
            Ok(m) => (Some(m), None),
            Err(e) => (None, Some(e)),
        }
    } else {
        (None, None)
    };
    let roster = match loaded.as_ref() {
        Some(m) => Some(roster_status(workspace, m)?),
        None => None,
    };
    Ok(EnvStatus {
        present: true,
        readme_present,
        manifest_present,
        manifest_error,
        schema_version: loaded.as_ref().map(|m| m.schema_version),
        registered_skills: loaded.as_ref().map(|m| m.skills.len()),
        canonical_skill_dirs: Some(list_skill_dirs(workspace)?.len()),
        roster,
    })
}

/// canonical skills/ 一级目录名集(排除 `.` 开头,升序)——与 sync-adapters/verify 的枚举口径一致。
pub(crate) fn list_skill_dirs(workspace: &Path) -> Result<Vec<String>, String> {
    let dir = manifest::env_root(workspace).join(manifest::SKILLS_DIR);
    sorted_child_names(&dir, true, |name| !name.starts_with('.'))
}

pub(crate) fn roster_status(
    workspace: &Path,
    m: &manifest::WorkflowManifest,
) -> Result<RosterStatus, String> {
    let root = manifest::env_root(workspace);
    let adapter_dirs = sorted_child_names(&root.join("adapters"), true, |_| true)?;
    let mut providers: Vec<String> = m.providers.keys().cloned().collect();
    providers.sort();
    let rule_files: Vec<String> =
        sorted_child_names(&root.join("rules"), false, |name| {
            name != "common.md" && name.ends_with(".md")
        })?
        .into_iter()
        .map(|name| name[..name.len() - 3].to_string())
        .collect();
    let consistent = adapter_dirs == providers && providers == rule_files;
    Ok(RosterStatus {
        adapter_dirs,
        providers,
        rule_files,
        consistent,
    })
}

/// 同目录临时文件 + persist 原子替换(Windows 语义为 MOVEFILE_REPLACE_EXISTING)。
pub(crate) fn write_atomic(dst: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let dir = dst
        .parent()
        .ok_or_else(|| format!("{} 无父目录", dst.display()))?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".htybox-htyenv-")
        .tempfile_in(dir)
        .map_err(|e| format!("创建临时文件失败({}): {e}", dir.display()))?;
    tmp.write_all(bytes)
        .map_err(|e| format!("写临时文件失败({}): {e}", dst.display()))?;
    tmp.persist(dst)
        .map_err(|e| format!("写入 {} 失败: {}", dst.display(), e.error))?;
    Ok(())
}

/// 列 dir 直接子项名(dirs_only 选目录/文件);目录不存在按空集返回(缺目录本身由 verify 报告)。
fn sorted_child_names(
    dir: &Path,
    dirs_only: bool,
    keep: impl Fn(&str) -> bool,
) -> Result<Vec<String>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let read_err = |e: std::io::Error| format!("读取 {} 失败: {e}", dir.display());
    let mut names = Vec::new();
    for entry in fs::read_dir(dir).map_err(read_err)? {
        let entry = entry.map_err(read_err)?;
        if entry.file_type().map_err(read_err)?.is_dir() != dirs_only {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if keep(&name) {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn write(path: &PathBuf, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    const MIN_MANIFEST: &str = r#"{
  "schemaVersion": 1,
  "providers": {
    "claude": { "adapterDir": ".claude/skills" },
    "codex": { "adapterDir": ".agents/skills" }
  },
  "skills": []
}"#;

    #[test]
    fn detect_absent_env() {
        let tmp = tempfile::tempdir().unwrap();
        let status = detect(tmp.path()).unwrap();
        assert!(!status.present);
        assert!(status.roster.is_none());
        assert!(status.canonical_skill_dirs.is_none());
    }

    #[test]
    fn roster_consistent_then_breaks_on_missing_rule() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        let root = ws.join(manifest::ENV_DIR);
        write(&root.join(manifest::MANIFEST_FILE), MIN_MANIFEST);
        write(&root.join("README.md"), "readme");
        fs::create_dir_all(root.join("adapters").join("claude")).unwrap();
        fs::create_dir_all(root.join("adapters").join("codex")).unwrap();
        write(&root.join("rules").join("common.md"), "c");
        write(&root.join("rules").join("claude.md"), "c");
        write(&root.join("rules").join("codex.md"), "c");
        fs::create_dir_all(root.join("skills").join("alpha")).unwrap();
        fs::create_dir_all(root.join("skills").join(".hidden")).unwrap();

        let status = detect(ws).unwrap();
        assert!(status.present && status.readme_present && status.manifest_present);
        assert_eq!(status.schema_version, Some(1));
        assert_eq!(status.canonical_skill_dirs, Some(1), ". 开头目录应排除");
        let roster = status.roster.unwrap();
        assert!(roster.consistent);
        assert_eq!(roster.providers, vec!["claude", "codex"]);
        assert_eq!(roster.rule_files, vec!["claude", "codex"]);

        fs::remove_file(root.join("rules").join("codex.md")).unwrap();
        let broken = detect(ws).unwrap();
        assert!(!broken.roster.unwrap().consistent, "缺 rules/codex.md 应报不一致");
    }

    #[test]
    fn manifest_error_reported_not_fatal() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        let root = ws.join(manifest::ENV_DIR);
        write(&root.join(manifest::MANIFEST_FILE), "{ not json");
        let status = detect(ws).unwrap();
        assert!(status.present && status.manifest_present);
        assert!(status.manifest_error.unwrap().contains("解析失败"));
        assert!(status.roster.is_none());
    }
}
