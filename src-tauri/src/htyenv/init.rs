// htyenv/init.rs —— 任意工程一键初始化:dry-run 先行,execute 只做预览过的事;全程幂等只增不覆。
// native 薄引导(决策 3A):缺失才生成并纳保护基线;已存在且不在基线内 → 报"需人工接线"(主题群决策 5)。
use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::{json, Map};

use super::adapters;
use super::library;
use super::manifest::{self, ProtectedFile};
use super::template::{managed_files, NATIVE_BOOTSTRAP_FILES, TEMPLATE_DIRS, TEMPLATE_FILES};
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
    /// 受管官方文件:与已装基线一致但内置已更新 → 可安全一键更新(仅 complete_preview 填充)
    pub will_update_files: Vec<String>,
    /// 受管官方文件:本地已改动/首装无基线且内容异 → 需逐项确认覆盖或注入裁决(仅 complete_preview 填充)
    pub diverged_files: Vec<String>,
    /// 受管官方文件:已针对当前官方版裁决、保留本地变体(无动作,供回溯;仅 complete_preview 填充)
    pub reconciled_files: Vec<String>,
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
        will_update_files: Vec::new(),
        diverged_files: Vec::new(),
        reconciled_files: Vec::new(),
    };
    for dir in TEMPLATE_DIRS {
        if !root.join(dir).is_dir() {
            preview.will_create_dirs.push((*dir).to_string());
        }
    }
    for (rel, _, _) in TEMPLATE_FILES {
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
    /// 受管官方文件本次覆盖到最新的(cleanOutdated + 已确认 diverged)
    pub updated_files: Vec<String>,
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
        updated_files: Vec::new(),
    };

    for dir in TEMPLATE_DIRS {
        let path = root.join(dir);
        if !path.is_dir() {
            fs::create_dir_all(&path).map_err(|e| format!("创建 {} 失败: {e}", path.display()))?;
            outcome.created_dirs += 1;
        }
    }
    for (rel, content, _) in TEMPLATE_FILES {
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

/// 环境补全 dry-run:仅已初始化工作区可用;清单语义与 init_preview 相同(缺什么补什么)。
pub fn complete_preview(workspace: &Path, library_dir: &Path) -> Result<InitPreview, String> {
    let mut preview = init_preview(workspace, library_dir)?;
    if !preview.already_initialized {
        return Err(
            "工作区尚未初始化 hty 环境——请先在概览使用「初始化」,补全仅用于已就绪工程".into(),
        );
    }
    // 受管官方文件更新检测(仅 complete 路径;init_preview 维持补缺语义):
    // present Managed 文件按基线三态判 cleanOutdated/diverged,并从 skipped_existing 剔除避免双计。
    let manifest_data = manifest::load(workspace)?;
    let scan = super::managed::scan(workspace, &manifest_data)?;
    let surfaced = scan.surfaced();
    preview.skipped_existing.retain(|rel| !surfaced.contains(rel));
    preview.will_update_files = scan.clean_outdated;
    preview.diverged_files = scan.diverged;
    preview.reconciled_files = scan.reconciled;
    Ok(preview)
}

/// 环境补全执行:补缺目录/治理文件/库 skill 取件 + 重生薄壳(init_execute)→ 叠加受管官方文件更新。
/// 补缺永不覆盖已有;更新分两级:cleanOutdated 安全覆盖,diverged 仅 `confirm_diverged` 列表内才覆盖。native 入口永不动。
pub fn complete_execute(
    workspace: &Path,
    library_dir: &Path,
    confirm_diverged: &[String],
) -> Result<InitOutcome, String> {
    if !manifest::manifest_path(workspace).is_file() {
        return Err(
            "工作区尚未初始化 hty 环境——请先初始化,补全仅用于已就绪工程".into(),
        );
    }
    let mut outcome = init_execute(workspace, library_dir)?;
    apply_managed_updates(workspace, confirm_diverged, &mut outcome)?;
    Ok(outcome)
}

/// 受管官方文件更新 pass(complete_execute 专属,init_execute 之后叠加):
/// cleanOutdated 全部安全覆盖 + `confirm_diverged` 列表内的 diverged 覆盖 + upToDate 无基线回填;凡写过则落基线。
fn apply_managed_updates(
    workspace: &Path,
    confirm_diverged: &[String],
    outcome: &mut InitOutcome,
) -> Result<(), String> {
    let root = manifest::env_root(workspace);
    let mut m = manifest::load(workspace)?;
    let scan = super::managed::scan(workspace, &m)?;

    let builtin = |rel: &str| -> Result<&'static str, String> {
        managed_files()
            .find(|(r, _)| *r == rel)
            .map(|(_, c)| c)
            .ok_or_else(|| format!("受管文件不在内置清单: {rel}"))
    };

    // 覆盖目标 = 全部 cleanOutdated + 已确认的 diverged
    let confirmed: std::collections::HashSet<&str> =
        confirm_diverged.iter().map(String::as_str).collect();
    let mut overwrite = scan.clean_outdated.clone();
    for rel in &scan.diverged {
        if confirmed.contains(rel.as_str()) {
            overwrite.push(rel.clone());
        }
    }
    for rel in &overwrite {
        let content = builtin(rel)?;
        write_atomic(&root.join(rel), content.as_bytes())?;
        m.upsert_managed_baseline(rel, &manifest::sha256_hex_upper(content.as_bytes()));
        outcome.updated_files.push(rel.clone());
    }
    // upToDate 但基线缺失/陈旧(含 init 刚补写的缺失文件)→ 仅回填基线,不改内容
    for rel in &scan.backfill_baseline {
        let content = builtin(rel)?;
        m.upsert_managed_baseline(rel, &manifest::sha256_hex_upper(content.as_bytes()));
    }
    if !outcome.updated_files.is_empty() || !scan.backfill_baseline.is_empty() {
        m.generated_utc = Some(manifest::now_utc_rfc3339()?);
        manifest::save(workspace, &m)?;
    }
    Ok(())
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
        // ensure_library 会装入出厂种子;seed_library 再加 plan-create
        assert!(preview.will_fetch_skills.contains(&"plan-create".to_string()));
        assert!(preview.will_fetch_skills.contains(&"htyenv-native-migrate".to_string()));
        assert_eq!(preview.will_fetch_skills.len(), 2);

        let outcome = init_execute(&ws, &lib).unwrap();
        assert_eq!(outcome.created_dirs, TEMPLATE_DIRS.len());
        assert_eq!(outcome.written_native.len(), 2);
        assert!(outcome.fetched_skills.contains(&"plan-create".to_string()));
        assert!(outcome.fetched_skills.contains(&"htyenv-native-migrate".to_string()));
        assert_eq!(outcome.fetched_skills.len(), 2);
        assert!(outcome.written_adapters >= 4, "两端 × 2 skill");
        assert!(ws.join(".htyworkflows/rules/common.md").is_file());
        assert!(ws.join(".claude/CLAUDE.md").is_file());
        assert!(ws.join("AGENTS.md").is_file());
        assert!(ws.join(".claude/skills/plan-create/SKILL.md").is_file());
        assert!(ws.join(".claude/skills/htyenv-native-migrate/SKILL.md").is_file());
        let m = manifest::load(&ws).unwrap();
        assert_eq!(m.protected_native_config.as_ref().unwrap().len(), 2);
        assert_eq!(m.skills.len(), 2);
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

    #[test]
    fn complete_requires_initialized_then_fetches_missing_seed() {
        let wtmp = tempfile::tempdir().unwrap();
        let ltmp = tempfile::tempdir().unwrap();
        let ws = wtmp.path().to_path_buf();
        let lib = ltmp.path().join("global-env");

        assert!(
            complete_preview(&ws, &lib).unwrap_err().contains("尚未初始化"),
            "未初始化不得走补全"
        );

        // 先普通初始化(会取走当时库内种子)
        init_execute(&ws, &lib).unwrap();
        let before = manifest::load(&ws).unwrap().skills.len();

        // 模拟「升级后库多了用户自定义 skill」:往库塞 beta,工程尚无
        let beta_dir = lib.join(library::LIBRARY_SKILLS_DIR).join("beta-tool");
        fs::create_dir_all(&beta_dir).unwrap();
        let body = "---\nname: beta-tool\n---\nB\n";
        fs::write(beta_dir.join(manifest::SKILL_ENTRY), body).unwrap();
        let mut lm = library::load_library(&lib).unwrap();
        lm.skills.push(library::LibrarySkillEntry {
            id: "beta-tool".to_string(),
            current_sha256: manifest::sha256_hex_upper(body.as_bytes()),
            file_count: 1,
            versions: vec![library::LibraryVersion {
                sha256: manifest::sha256_hex_upper(body.as_bytes()),
                collected_utc: "2026-07-14T00:00:00Z".to_string(),
                source_workspace: None,
                extra: Map::new(),
            }],
            extra: Map::new(),
        });
        library::save_library(&lib, &lm).unwrap();

        let preview = complete_preview(&ws, &lib).unwrap();
        assert!(preview.already_initialized);
        assert!(preview.will_fetch_skills.contains(&"beta-tool".to_string()));

        let outcome = complete_execute(&ws, &lib, &[]).unwrap();
        assert!(outcome.fetched_skills.contains(&"beta-tool".to_string()));
        assert!(ws.join(".htyworkflows/skills/beta-tool/SKILL.md").is_file());
        assert!(manifest::load(&ws).unwrap().skills.len() > before);
    }

    #[test]
    fn complete_updates_outdated_and_respects_diverged_confirm() {
        let wtmp = tempfile::tempdir().unwrap();
        let ltmp = tempfile::tempdir().unwrap();
        let ws = wtmp.path().to_path_buf();
        let lib = ltmp.path().join("global-env");
        init_execute(&ws, &lib).unwrap();
        // init 后受管文件均 == 内置 → 首次 complete 回填基线,零更新
        let out0 = complete_execute(&ws, &lib, &[]).unwrap();
        assert!(out0.updated_files.is_empty(), "初装后无可更新");
        let m = manifest::load(&ws).unwrap();
        assert!(m.managed_baseline("tools/verify.ps1").is_some(), "回填了基线");

        let root = manifest::env_root(&ws);
        // 场景 A:把 verify.ps1 改成"旧官方版"并令基线=旧 → cleanOutdated → 安全一键更新
        let mut m = manifest::load(&ws).unwrap();
        fs::write(root.join("tools/verify.ps1"), b"OLD OFFICIAL").unwrap();
        m.upsert_managed_baseline("tools/verify.ps1", &manifest::sha256_hex_upper(b"OLD OFFICIAL"));
        // 场景 B:把 path-audit.ps1 改成"用户本地版",基线保持内置 → diverged
        fs::write(root.join("tools/path-audit.ps1"), b"USER LOCAL EDIT").unwrap();
        manifest::save(&ws, &m).unwrap();

        let prev = complete_preview(&ws, &lib).unwrap();
        assert!(prev.will_update_files.contains(&"tools/verify.ps1".to_string()));
        assert!(prev.diverged_files.contains(&"tools/path-audit.ps1".to_string()));

        // 不确认 diverged:verify 被安全更新,path-audit 保留用户改动
        let out = complete_execute(&ws, &lib, &[]).unwrap();
        assert!(out.updated_files.contains(&"tools/verify.ps1".to_string()));
        assert!(!out.updated_files.contains(&"tools/path-audit.ps1".to_string()));
        assert_eq!(
            fs::read(root.join("tools/path-audit.ps1")).unwrap(),
            b"USER LOCAL EDIT",
            "未确认的 diverged 绝不覆盖"
        );
        // verify 已回内置 → 再 preview 应无它
        let prev2 = complete_preview(&ws, &lib).unwrap();
        assert!(!prev2.will_update_files.contains(&"tools/verify.ps1".to_string()));

        // 确认 path-audit 后才覆盖
        let out2 = complete_execute(&ws, &lib, &["tools/path-audit.ps1".to_string()]).unwrap();
        assert!(out2.updated_files.contains(&"tools/path-audit.ps1".to_string()));
        assert!(complete_preview(&ws, &lib).unwrap().diverged_files.is_empty(), "确认后 diverged 清空");
    }
}
