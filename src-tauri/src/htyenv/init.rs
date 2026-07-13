// htyenv/init.rs —— 任意工程一键初始化:dry-run 先行,execute 只做预览过的事;全程幂等只增不覆。
// native 薄引导(决策 3A):缺失才生成并纳保护基线;已存在且不在基线内 → 报"需人工接线"(主题群决策 5)。
use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::{json, Map};

use super::adapters;
use super::library;
use super::manifest::{self, ProtectedFile};
use super::template::{NATIVE_BOOTSTRAP_FILES, TEMPLATE_DIRS, TEMPLATE_FILES};
use super::write_atomic;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitPreview {
    /// workflow-manifest.json 已存在(接管态:结构只补不改)
    pub already_initialized: bool,
    pub will_create_dirs: Vec<String>,
    /// env 根相对(模板文件 + workflow-manifest.json)
    pub will_write_files: Vec<String>,
    /// 工程根相对(native 薄引导,缺失才写)
    pub will_write_native: Vec<String>,
    /// native 已存在且不在保护基线内 → 需人工接线
    pub native_manual: Vec<String>,
    pub skipped_existing: Vec<String>,
    pub library: library::LibraryStatus,
    /// 库有而工程 canonical 无 → 初始化时取件
    pub will_fetch_skills: Vec<String>,
}

/// 只读预览(不建库、零写入)。
pub fn init_preview(workspace: &Path, library_dir: &Path) -> Result<InitPreview, String> {
    let root = manifest::env_root(workspace);
    let already_initialized = manifest::manifest_path(workspace).is_file();
    let loaded = if already_initialized {
        Some(manifest::load(workspace)?)
    } else {
        None
    };

    let mut preview = InitPreview {
        already_initialized,
        will_create_dirs: Vec::new(),
        will_write_files: Vec::new(),
        will_write_native: Vec::new(),
        native_manual: Vec::new(),
        skipped_existing: Vec::new(),
        library: library::library_status(library_dir),
        will_fetch_skills: Vec::new(),
    };
    for dir in TEMPLATE_DIRS {
        if !root.join(dir).is_dir() {
            preview.will_create_dirs.push((*dir).to_string());
        }
    }
    for (rel, _) in TEMPLATE_FILES {
        if root.join(rel).is_file() {
            preview.skipped_existing.push((*rel).to_string());
        } else {
            preview.will_write_files.push((*rel).to_string());
        }
    }
    if !already_initialized {
        preview.will_write_files.push(manifest::MANIFEST_FILE.to_string());
    }
    for (rel, _, _) in NATIVE_BOOTSTRAP_FILES {
        if workspace.join(rel).is_file() {
            if !in_protected_baseline(loaded.as_ref(), rel) {
                preview.native_manual.push((*rel).to_string());
            }
        } else {
            preview.will_write_native.push((*rel).to_string());
        }
    }
    if preview.library.present && preview.library.manifest_error.is_none() {
        for entry in library::load_library(library_dir)?.skills {
            let dst = manifest::skill_dir(workspace, &entry.id)?;
            if !dst.join(manifest::SKILL_ENTRY).is_file() {
                preview.will_fetch_skills.push(entry.id);
            }
        }
    }
    Ok(preview)
}

fn in_protected_baseline(m: Option<&manifest::WorkflowManifest>, rel: &str) -> bool {
    m.and_then(|m| m.protected_native_config.as_ref())
        .map(|list| list.iter().any(|p| p.path == rel))
        .unwrap_or(false)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitOutcome {
    pub already_initialized: bool,
    pub created_dirs: usize,
    pub written_files: Vec<String>,
    pub written_native: Vec<String>,
    pub native_manual: Vec<String>,
    pub fetched_skills: Vec<String>,
    pub written_adapters: usize,
}

/// 执行初始化(幂等,只做 preview 展示过的事):骨架 + 治理文件 + native 薄引导入基线 +
/// 建库/取件 + 首轮薄壳。任何已存在文件一律不覆盖。
pub fn init_execute(workspace: &Path, library_dir: &Path) -> Result<InitOutcome, String> {
    let root = manifest::env_root(workspace);
    let already_initialized = manifest::manifest_path(workspace).is_file();
    let mut outcome = InitOutcome {
        already_initialized,
        created_dirs: 0,
        written_files: Vec::new(),
        written_native: Vec::new(),
        native_manual: Vec::new(),
        fetched_skills: Vec::new(),
        written_adapters: 0,
    };

    for dir in TEMPLATE_DIRS {
        let path = root.join(dir);
        if !path.is_dir() {
            fs::create_dir_all(&path).map_err(|e| format!("创建 {} 失败: {e}", path.display()))?;
            outcome.created_dirs += 1;
        }
    }
    for (rel, content) in TEMPLATE_FILES {
        let path = root.join(rel);
        if !path.is_file() {
            write_atomic(&path, content.as_bytes())?;
            outcome.written_files.push((*rel).to_string());
        }
    }

    let mut manifest_data = if already_initialized {
        manifest::load(workspace)?
    } else {
        super::template::factory_manifest()
    };

    for (rel, content, _provider) in NATIVE_BOOTSTRAP_FILES {
        let path = workspace.join(rel);
        if path.is_file() {
            if !in_protected_baseline(Some(&manifest_data), rel) {
                outcome.native_manual.push((*rel).to_string());
            }
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
        }
        write_atomic(&path, content.as_bytes())?;
        let sha = manifest::sha256_hex_upper(content.as_bytes());
        upsert_protected(&mut manifest_data, rel, &sha);
        outcome.written_native.push((*rel).to_string());
    }

    manifest_data.generated_utc = Some(manifest::now_utc_rfc3339()?);
    if !already_initialized {
        outcome.written_files.push(manifest::MANIFEST_FILE.to_string());
    }
    manifest::save(workspace, &manifest_data)?;

    // 建库(首用即建)并取件:库有而工程无的 skill 全部落进 canonical(fetch 自带登记+该 skill 薄壳)
    let library_manifest = library::ensure_library(library_dir)?;
    for entry in &library_manifest.skills {
        let dst = manifest::skill_dir(workspace, &entry.id)?;
        if !dst.join(manifest::SKILL_ENTRY).is_file() {
            library::fetch_skill(library_dir, workspace, &entry.id)?;
            outcome.fetched_skills.push(entry.id.clone());
        }
    }

    // 首轮全量薄壳(覆盖接管态下既有 canonical 无薄壳的情况;幂等)
    let final_manifest = manifest::load(workspace)?;
    outcome.written_adapters =
        adapters::sync_adapters(workspace, &final_manifest)?.written_adapters;
    Ok(outcome)
}

fn upsert_protected(m: &mut manifest::WorkflowManifest, rel: &str, sha: &str) {
    let list = m.protected_native_config.get_or_insert_with(Vec::new);
    if let Some(existing) = list.iter_mut().find(|p| p.path == rel) {
        existing.sha256 = sha.to_string();
        return;
    }
    let mut extra = Map::new();
    extra.insert("policy".to_string(), json!("read-only-reference"));
    list.push(ProtectedFile {
        path: rel.to_string(),
        sha256: sha.to_string(),
        extra,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn seed_library_with_skill(lib: &Path) {
        library::ensure_library(lib).unwrap();
        let dir = lib.join(library::LIBRARY_SKILLS_DIR).join("plan-create");
        fs::create_dir_all(&dir).unwrap();
        let body = "---\nname: plan-create\n---\nP\n";
        fs::write(dir.join(manifest::SKILL_ENTRY), body).unwrap();
        let mut lm = library::load_library(lib).unwrap();
        lm.skills.push(library::LibrarySkillEntry {
            id: "plan-create".to_string(),
            current_sha256: manifest::sha256_hex_upper(body.as_bytes()),
            file_count: 1,
            versions: vec![library::LibraryVersion {
                sha256: manifest::sha256_hex_upper(body.as_bytes()),
                collected_utc: "2026-07-13T00:00:00Z".to_string(),
                source_workspace: None,
                extra: Map::new(),
            }],
            extra: Map::new(),
        });
        library::save_library(lib, &lm).unwrap();
    }

    #[test]
    fn fresh_init_end_to_end_and_idempotent() {
        let wtmp = tempfile::tempdir().unwrap();
        let ltmp = tempfile::tempdir().unwrap();
        let ws: PathBuf = wtmp.path().to_path_buf();
        let lib = ltmp.path().join("global-env");
        seed_library_with_skill(&lib);

        let preview = init_preview(&ws, &lib).unwrap();
        assert!(!preview.already_initialized);
        assert_eq!(preview.will_create_dirs.len(), TEMPLATE_DIRS.len());
        assert!(preview.will_write_files.contains(&"README.md".to_string()));
        assert!(preview.will_write_files.contains(&manifest::MANIFEST_FILE.to_string()));
        assert_eq!(preview.will_write_native.len(), 2);
        assert!(preview.native_manual.is_empty());
        assert_eq!(preview.will_fetch_skills, vec!["plan-create".to_string()]);

        let outcome = init_execute(&ws, &lib).unwrap();
        assert_eq!(outcome.created_dirs, TEMPLATE_DIRS.len());
        assert_eq!(outcome.written_native.len(), 2);
        assert_eq!(outcome.fetched_skills, vec!["plan-create".to_string()]);
        assert!(outcome.written_adapters >= 2);
        assert!(ws.join(".htyworkflows/rules/common.md").is_file());
        assert!(ws.join(".claude/CLAUDE.md").is_file());
        assert!(ws.join("AGENTS.md").is_file());
        assert!(ws.join(".claude/skills/plan-create/SKILL.md").is_file());
        let m = manifest::load(&ws).unwrap();
        assert_eq!(m.protected_native_config.as_ref().unwrap().len(), 2);
        assert_eq!(m.skills.len(), 1);
        let report = super::super::verify::verify(&ws, &m, None).unwrap();
        let failed: Vec<_> = report.checks.iter().filter(|c| !c.passed).collect();
        assert!(report.all_passed, "全新初始化后 verify 应全绿: {failed:?}");

        let second = init_execute(&ws, &lib).unwrap();
        assert!(second.already_initialized);
        assert_eq!(second.created_dirs, 0);
        assert!(second.written_files.is_empty());
        assert!(second.written_native.is_empty());
        assert!(second.native_manual.is_empty(), "自生成 native 已在基线,不应报人工");
        assert!(second.fetched_skills.is_empty());
        let preview2 = init_preview(&ws, &lib).unwrap();
        assert!(preview2.already_initialized);
        assert!(preview2.will_create_dirs.is_empty() && preview2.will_write_files.is_empty());
    }

    #[test]
    fn adopt_existing_native_reports_manual_and_never_overwrites() {
        let wtmp = tempfile::tempdir().unwrap();
        let ltmp = tempfile::tempdir().unwrap();
        let ws = wtmp.path().to_path_buf();
        let lib = ltmp.path().join("global-env");
        fs::create_dir_all(ws.join(".claude")).unwrap();
        fs::write(ws.join(".claude/CLAUDE.md"), "用户自己的规则").unwrap();

        let preview = init_preview(&ws, &lib).unwrap();
        assert_eq!(preview.native_manual, vec![".claude/CLAUDE.md".to_string()]);
        assert_eq!(preview.will_write_native, vec!["AGENTS.md".to_string()]);

        let outcome = init_execute(&ws, &lib).unwrap();
        assert_eq!(outcome.native_manual, vec![".claude/CLAUDE.md".to_string()]);
        assert_eq!(
            fs::read_to_string(ws.join(".claude/CLAUDE.md")).unwrap(),
            "用户自己的规则",
            "已存在 native 绝不覆盖"
        );
        let m = manifest::load(&ws).unwrap();
        let protected = m.protected_native_config.as_ref().unwrap();
        assert_eq!(protected.len(), 1, "仅自生成的 AGENTS.md 入基线");
        assert_eq!(protected[0].path, "AGENTS.md");
    }
}
