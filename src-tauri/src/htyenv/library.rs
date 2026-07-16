// htyenv/library.rs —— 全局权威环境库(出厂结构 + 内置种子 skill;用户经"收编"继续长内容)。
// 库即普通目录(可被用户 git 管理),位置由命令层传入(设置可配,决策 1A),默认 config_dir/HtyBox/global-env。
// 收编/取件是"无冲突基线操作":目标已存在且内容不同一律拒绝并指向 plan-3 的 diff 流程,绝不静默覆盖。
// 内置种子(SEED_SKILLS)经 ensure_library 装入并标 bundled;用户同名收编版不被种子覆盖。
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::manifest::{self, SkillEntry};
use super::template::{SEED_SKILLS, TEMPLATE_VERSION};
use super::write_atomic;

pub const LIBRARY_MANIFEST: &str = "library-manifest.json";
pub const LIBRARY_SKILLS_DIR: &str = "skills";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryManifest {
    pub schema_version: u32,
    /// 库身份标识(路径迁移时据此识别同一库,主题群风险缓解)
    pub library_id: String,
    pub template_version: u32,
    pub created_utc: String,
    pub skills: Vec<LibrarySkillEntry>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySkillEntry {
    pub id: String,
    /// 库内当前版 SKILL.md 的 SHA-256(大写)
    pub current_sha256: String,
    pub file_count: u64,
    /// 版本链(首=收编起点,末=当前;plan-3 谱系对比的库侧依据)
    pub versions: Vec<LibraryVersion>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryVersion {
    pub sha256: String,
    pub collected_utc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_workspace: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStatus {
    pub path: String,
    pub present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_error: Option<String>,
}

/// 默认库位置(host_identity config_dir 范式)。
pub fn default_library_dir() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or_else(|| "无法定位系统配置目录".to_string())?
        .join("HtyBox")
        .join("global-env"))
}

/// 命令层入参解析:自定义路径(设置项)非空用之,否则默认。
pub fn resolve_library_dir(custom: Option<&str>) -> Result<PathBuf, String> {
    match custom.map(str::trim) {
        Some(path) if !path.is_empty() => Ok(PathBuf::from(path)),
        _ => default_library_dir(),
    }
}

fn manifest_path(library_dir: &Path) -> PathBuf {
    library_dir.join(LIBRARY_MANIFEST)
}

pub fn load_library(library_dir: &Path) -> Result<LibraryManifest, String> {
    let path = manifest_path(library_dir);
    let text =
        fs::read_to_string(&path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("library-manifest.json 解析失败: {e}"))
}

pub fn save_library(library_dir: &Path, manifest: &LibraryManifest) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("library-manifest 序列化失败: {e}"))?;
    text.push('\n');
    write_atomic(&manifest_path(library_dir), text.as_bytes())
}

/// 首启建库(幂等):目录 + skills/ + library-manifest;已存在则加载。
/// 随后装入/刷新出厂种子 skill(见 `ensure_seed_skills`)。
pub fn ensure_library(library_dir: &Path) -> Result<LibraryManifest, String> {
    let mut manifest = if manifest_path(library_dir).is_file() {
        load_library(library_dir)?
    } else {
        fs::create_dir_all(library_dir.join(LIBRARY_SKILLS_DIR))
            .map_err(|e| format!("创建库目录 {} 失败: {e}", library_dir.display()))?;
        let m = LibraryManifest {
            schema_version: 1,
            library_id: new_library_id(library_dir),
            template_version: TEMPLATE_VERSION,
            created_utc: manifest::now_utc_rfc3339()?,
            skills: Vec::new(),
            extra: Map::new(),
        };
        save_library(library_dir, &m)?;
        m
    };
    let seeded = ensure_seed_skills(library_dir, &mut manifest)?;
    if !seeded.is_empty() {
        save_library(library_dir, &manifest)?;
    }
    Ok(manifest)
}

const BUNDLED_KEY: &str = "bundled";

pub(crate) fn is_bundled_entry(entry: &LibrarySkillEntry) -> bool {
    entry
        .extra
        .get(BUNDLED_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// 将应用内嵌的 SEED_SKILLS 装入全局库(幂等)。
/// - 库无该 id → 安装并标记 `bundled: true`
/// - 库有且 `bundled: true` 且 sha 不同 → 刷新为种子版(版本升级随应用下发)
/// - 库有且非 bundled(用户收编/回流) → 不碰
/// 返回发生写入的 skill id 列表。
pub fn ensure_seed_skills(
    library_dir: &Path,
    library: &mut LibraryManifest,
) -> Result<Vec<String>, String> {
    let mut changed = Vec::new();
    for (skill_id, files) in SEED_SKILLS {
        manifest::validate_skill_id(skill_id)?;
        let entry_bytes = files
            .iter()
            .find(|(rel, _)| *rel == manifest::SKILL_ENTRY)
            .map(|(_, c)| c.as_bytes())
            .ok_or_else(|| format!("种子 skill {skill_id} 缺 {}", manifest::SKILL_ENTRY))?;
        let seed_sha = manifest::sha256_hex_upper(entry_bytes);
        let existing = library.skills.iter().find(|s| s.id == *skill_id);
        match existing {
            Some(e) if !is_bundled_entry(e) => continue,
            Some(e) if e.current_sha256 == seed_sha => continue,
            _ => {}
        }
        let file_count = install_seed_skill_files(library_dir, skill_id, files)?;
        let now = manifest::now_utc_rfc3339()?;
        let mut extra = Map::new();
        extra.insert(BUNDLED_KEY.to_string(), serde_json::json!(true));
        if let Some(entry) = library.skills.iter_mut().find(|s| s.id == *skill_id) {
            entry.current_sha256 = seed_sha.clone();
            entry.file_count = file_count;
            entry.versions.push(LibraryVersion {
                sha256: seed_sha,
                collected_utc: now,
                source_workspace: None,
                extra: {
                    let mut v = Map::new();
                    v.insert(BUNDLED_KEY.to_string(), serde_json::json!(true));
                    v
                },
            });
            entry.extra.insert(BUNDLED_KEY.to_string(), serde_json::json!(true));
        } else {
            library.skills.push(LibrarySkillEntry {
                id: (*skill_id).to_string(),
                current_sha256: seed_sha.clone(),
                file_count,
                versions: vec![LibraryVersion {
                    sha256: seed_sha,
                    collected_utc: now,
                    source_workspace: None,
                    extra: {
                        let mut v = Map::new();
                        v.insert(BUNDLED_KEY.to_string(), serde_json::json!(true));
                        v
                    },
                }],
                extra,
            });
            library.skills.sort_by(|a, b| a.id.cmp(&b.id));
        }
        changed.push((*skill_id).to_string());
    }
    Ok(changed)
}

/// 把种子文件写入库 skills/<id>/(staging 原子替换;可覆盖已有 bundled 目录)。
fn install_seed_skill_files(
    library_dir: &Path,
    skill_id: &str,
    files: &[(&str, &str)],
) -> Result<u64, String> {
    let dst = library_dir.join(LIBRARY_SKILLS_DIR).join(skill_id);
    let parent = dst
        .parent()
        .ok_or_else(|| format!("{} 无父目录", dst.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = parent.join(format!(".htybox-seed-{nanos}"));
    let result = (|| {
        fs::create_dir_all(&staging)
            .map_err(|e| format!("创建 staging 失败: {e}"))?;
        let mut count = 0u64;
        for (rel, content) in files {
            let target = staging.join(rel);
            if let Some(dir) = target.parent() {
                fs::create_dir_all(dir)
                    .map_err(|e| format!("创建 {} 失败: {e}", dir.display()))?;
            }
            fs::write(&target, content.as_bytes())
                .map_err(|e| format!("写入 {} 失败: {e}", target.display()))?;
            count += 1;
        }
        if dst.exists() {
            let trash = parent.join(format!(".htybox-seed-trash-{nanos}"));
            fs::rename(&dst, &trash)
                .map_err(|e| format!("挪走旧目录失败: {e}"))?;
            let rename_result = fs::rename(&staging, &dst);
            let _ = fs::remove_dir_all(&trash);
            rename_result.map_err(|e| format!("入位 {} 失败: {e}", dst.display()))?;
        } else {
            fs::rename(&staging, &dst)
                .map_err(|e| format!("入位 {} 失败: {e}", dst.display()))?;
        }
        Ok(count)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

/// 库状态:已存在时经 ensure_library 刷新种子后再读(保证升级后内置 skill 可见)。
/// 不存在时不建库(仍是「未就绪」状态;建库由 init/ensure 显式触发)。
pub fn library_status(library_dir: &Path) -> LibraryStatus {
    let mut status = LibraryStatus {
        path: library_dir.display().to_string(),
        present: manifest_path(library_dir).is_file(),
        library_id: None,
        template_version: None,
        skill_count: None,
        manifest_error: None,
    };
    if status.present {
        match ensure_library(library_dir) {
            Ok(m) => {
                status.library_id = Some(m.library_id);
                status.template_version = Some(m.template_version);
                status.skill_count = Some(m.skills.len());
            }
            Err(e) => status.manifest_error = Some(e),
        }
    }
    status
}

/// 库身份:路径+时钟纳秒+进程号的哈希前缀(仅作迁移识别,非安全用途)。
fn new_library_id(library_dir: &Path) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seed = format!("{}|{}|{}", library_dir.display(), nanos, std::process::id());
    format!("lib-{}", &manifest::sha256_hex_upper(seed.as_bytes())[..12].to_lowercase())
}

/// 库侧跟随刷新(同 manifest::refresh_from_canonical 语义):登记 sha ≠ 实文件 → 对齐并把外部演进记入
/// 版本链(来源未知,sourceWorkspace=None);实体缺 SKILL.md 的登记项不动(属对账报告面)。返回被刷新的 id。
pub fn refresh_library(
    library_dir: &Path,
    library: &mut LibraryManifest,
) -> Result<Vec<String>, String> {
    let mut refreshed = Vec::new();
    for entry in &mut library.skills {
        manifest::validate_skill_id(&entry.id)?;
        let dir = library_dir.join(LIBRARY_SKILLS_DIR).join(&entry.id);
        let file = dir.join(manifest::SKILL_ENTRY);
        if !file.is_file() {
            continue;
        }
        let live = manifest::sha256_file_upper(&file)?;
        if live != entry.current_sha256 {
            entry.current_sha256 = live.clone();
            entry.file_count = manifest::count_files(&dir)?;
            entry.versions.push(LibraryVersion {
                sha256: live,
                collected_utc: manifest::now_utc_rfc3339()?,
                source_workspace: None,
                extra: Map::new(),
            });
            refreshed.push(entry.id.clone());
        }
    }
    Ok(refreshed)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectOutcome {
    pub id: String,
    /// "collected" | "alreadyPresent"
    pub status: String,
    pub library_sha256: String,
    /// 去工程化整理的 AI 指令文本(可注入 agent 终端,plan-4 接线)
    pub curation_brief: String,
}

/// 收编:工程 canonical skill → 库(无冲突基线操作;库已有异版一律拒绝,回流走 plan-3)。
pub fn collect_skill(
    workspace: &Path,
    library_dir: &Path,
    skill_id: &str,
) -> Result<CollectOutcome, String> {
    manifest::validate_skill_id(skill_id)?;
    let src_dir = manifest::skill_dir(workspace, skill_id)?;
    let src_entry = src_dir.join(manifest::SKILL_ENTRY);
    if !src_entry.is_file() {
        return Err(format!("工程 canonical 无 {skill_id}/{}", manifest::SKILL_ENTRY));
    }
    let entry_sha = manifest::sha256_file_upper(&src_entry)?;
    let mut workspace_manifest = manifest::load(workspace)?;
    if !workspace_manifest.skills.iter().any(|s| s.id == skill_id) {
        return Err(format!(
            "{skill_id} 未登记于 workflow-manifest.json(UNREGISTERED),请先补登记再收编"
        ));
    }

    let mut library = ensure_library(library_dir)?;
    let brief = curation_brief(library_dir, workspace, skill_id);
    if let Some(existing) = library.skills.iter().find(|s| s.id == skill_id) {
        if existing.current_sha256 == entry_sha {
            set_library_sha(&mut workspace_manifest, skill_id, &entry_sha);
            manifest::save(workspace, &workspace_manifest)?;
            return Ok(CollectOutcome {
                id: skill_id.to_string(),
                status: "alreadyPresent".to_string(),
                library_sha256: entry_sha,
                curation_brief: brief,
            });
        }
        return Err(format!(
            "库内已有 {skill_id} 且内容不同(库 {} / 工程 {}),收编不做覆盖——回流走双向同步(plan-3)",
            &existing.current_sha256[..8],
            &entry_sha[..8]
        ));
    }

    let dst_dir = library_dir.join(LIBRARY_SKILLS_DIR).join(skill_id);
    let file_count = copy_skill_tree(&src_dir, &dst_dir)?;
    library.skills.push(LibrarySkillEntry {
        id: skill_id.to_string(),
        current_sha256: entry_sha.clone(),
        file_count,
        versions: vec![LibraryVersion {
            sha256: entry_sha.clone(),
            collected_utc: manifest::now_utc_rfc3339()?,
            source_workspace: Some(workspace.display().to_string()),
            extra: Map::new(),
        }],
        extra: Map::new(),
    });
    library.skills.sort_by(|a, b| a.id.cmp(&b.id));
    save_library(library_dir, &library)?;

    set_library_sha(&mut workspace_manifest, skill_id, &entry_sha);
    manifest::save(workspace, &workspace_manifest)?;
    Ok(CollectOutcome {
        id: skill_id.to_string(),
        status: "collected".to_string(),
        library_sha256: entry_sha,
        curation_brief: brief,
    })
}

fn set_library_sha(m: &mut manifest::WorkflowManifest, skill_id: &str, sha: &str) {
    if let Some(entry) = m.skills.iter_mut().find(|s| s.id == skill_id) {
        entry.library_sha = Some(sha.to_string());
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchOutcome {
    pub id: String,
    /// "fetched" | "alreadyPresent"
    pub status: String,
    pub library_sha256: String,
    pub written_adapters: usize,
}

/// 取件:库 skill → 工程 canonical + manifest 登记(librarySha) + 该 skill 薄壳生成。
/// 工程已有异版一律拒绝(更新走 plan-3)。
pub fn fetch_skill(
    library_dir: &Path,
    workspace: &Path,
    skill_id: &str,
) -> Result<FetchOutcome, String> {
    manifest::validate_skill_id(skill_id)?;
    let library = load_library(library_dir)?;
    let Some(lib_entry) = library.skills.iter().find(|s| s.id == skill_id) else {
        return Err(format!("库内无 {skill_id}"));
    };
    let src_dir = library_dir.join(LIBRARY_SKILLS_DIR).join(skill_id);
    if !src_dir.join(manifest::SKILL_ENTRY).is_file() {
        return Err(format!("库登记与实体不一致:{skill_id} 缺 SKILL.md"));
    }
    let mut workspace_manifest = manifest::load(workspace)?;
    let dst_dir = manifest::skill_dir(workspace, skill_id)?;
    let mut status = "fetched";
    if dst_dir.join(manifest::SKILL_ENTRY).is_file() {
        let ws_sha = manifest::sha256_file_upper(&dst_dir.join(manifest::SKILL_ENTRY))?;
        if ws_sha != lib_entry.current_sha256 {
            return Err(format!(
                "工程已有 {skill_id} 且内容不同(工程 {} / 库 {}),取件不做覆盖——更新走双向同步(plan-3)",
                &ws_sha[..8],
                &lib_entry.current_sha256[..8]
            ));
        }
        status = "alreadyPresent";
    } else {
        copy_skill_tree(&src_dir, &dst_dir)?;
    }

    let entry_sha = lib_entry.current_sha256.clone();
    match workspace_manifest.skills.iter_mut().find(|s| s.id == skill_id) {
        Some(entry) => {
            entry.entry_sha256 = entry_sha.clone();
            entry.file_count = lib_entry.file_count;
            entry.library_sha = Some(entry_sha.clone());
        }
        None => {
            workspace_manifest.skills.push(SkillEntry {
                id: skill_id.to_string(),
                source_id: None,
                entry_sha256: entry_sha.clone(),
                file_count: lib_entry.file_count,
                status: None,
                enabled: None,
                library_sha: Some(entry_sha.clone()),
                extra: Map::new(),
            });
            workspace_manifest.skills.sort_by(|a, b| a.id.cmp(&b.id));
        }
    }
    workspace_manifest.generated_utc = Some(manifest::now_utc_rfc3339()?);
    manifest::save(workspace, &workspace_manifest)?;
    let sync = super::adapters::sync_skill(workspace, &workspace_manifest, skill_id)?;
    Ok(FetchOutcome {
        id: skill_id.to_string(),
        status: status.to_string(),
        library_sha256: entry_sha,
        written_adapters: sync.written_adapters,
    })
}

/// 整 skill 目录安全拷贝(拒符号链接;staging + rename 原子入位;目标必须不存在)。返回文件计数。
pub(crate) fn copy_skill_tree(src: &Path, dst: &Path) -> Result<u64, String> {
    if dst.exists() {
        return Err(format!("目标已存在: {}", dst.display()));
    }
    let parent = dst
        .parent()
        .ok_or_else(|| format!("{} 无父目录", dst.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = parent.join(format!(".htybox-tree-{nanos}"));
    let result = copy_tree_into(src, &staging).and_then(|count| {
        fs::rename(&staging, dst).map_err(|e| format!("入位 {} 失败: {e}", dst.display()))?;
        Ok(count)
    });
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn copy_tree_into(src: &Path, staging: &Path) -> Result<u64, String> {
    let mut count = 0u64;
    for item in walkdir::WalkDir::new(src) {
        let item = item.map_err(|e| format!("遍历 {} 失败: {e}", src.display()))?;
        if item.path_is_symlink() {
            return Err(format!("拒绝符号链接: {}", item.path().display()));
        }
        let rel = item
            .path()
            .strip_prefix(src)
            .map_err(|e| format!("相对化失败: {e}"))?;
        let target = staging.join(rel);
        if item.file_type().is_dir() {
            fs::create_dir_all(&target)
                .map_err(|e| format!("创建 {} 失败: {e}", target.display()))?;
        } else if item.file_type().is_file() {
            let bytes = fs::read(item.path())
                .map_err(|e| format!("读取 {} 失败: {e}", item.path().display()))?;
            if let Some(dir) = target.parent() {
                fs::create_dir_all(dir)
                    .map_err(|e| format!("创建 {} 失败: {e}", dir.display()))?;
            }
            fs::write(&target, bytes)
                .map_err(|e| format!("写入 {} 失败: {e}", target.display()))?;
            count += 1;
        }
    }
    Ok(count)
}

/// 库 skill 概要(plan-4 全局库管理视图列表行)。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySkillInfo {
    pub id: String,
    pub current_sha256: String,
    pub file_count: u64,
    /// frontmatter description(缺失如实为空)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 登记在而实体缺 SKILL.md(库损坏,如实展示)
    pub entry_missing: bool,
    /// 版本链(首=收编起点,末=当前;「最近动向」与版本数的真源)
    pub versions: Vec<LibraryVersionInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryVersionInfo {
    pub sha256: String,
    pub collected_utc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_workspace: Option<String>,
}

/// 库 skill 清单(按 id 升序)。经 ensure_library 刷新种子后再列。
pub fn list_library_skills(library_dir: &Path) -> Result<Vec<LibrarySkillInfo>, String> {
    let library = ensure_library(library_dir)?;
    let mut out = Vec::with_capacity(library.skills.len());
    for entry in &library.skills {
        manifest::validate_skill_id(&entry.id)?;
        let entry_file = library_dir
            .join(LIBRARY_SKILLS_DIR)
            .join(&entry.id)
            .join(manifest::SKILL_ENTRY);
        out.push(LibrarySkillInfo {
            id: entry.id.clone(),
            current_sha256: entry.current_sha256.clone(),
            file_count: entry.file_count,
            description: manifest::skill_description(&entry_file),
            entry_missing: !entry_file.is_file(),
            versions: entry
                .versions
                .iter()
                .map(|v| LibraryVersionInfo {
                    sha256: v.sha256.clone(),
                    collected_utc: v.collected_utc.clone(),
                    source_workspace: v.source_workspace.clone(),
                })
                .collect(),
        });
    }
    Ok(out)
}

/// 从库删除 skill(登记 + 实体;确认交互在前端)。顺序=实体改名入回收 → 记账 → 清回收:
/// 任一步失败均可重跑本函数自愈,且 id 目录位随即腾空,不阻塞同 id 未来收编。
/// 工作区仍持有该 skill 与基线时,下次谱系对比如实报 diverged「库侧断链」——删除是治理动作,不改写任何工作区。
pub fn delete_library_skill(library_dir: &Path, skill_id: &str) -> Result<(), String> {
    manifest::validate_skill_id(skill_id)?;
    let mut library = load_library(library_dir)?;
    let before = library.skills.len();
    library.skills.retain(|s| s.id != skill_id);
    if library.skills.len() == before {
        return Err(format!("库内无 {skill_id}"));
    }
    let dir = library_dir.join(LIBRARY_SKILLS_DIR).join(skill_id);
    let mut trash = None;
    if dir.is_dir() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dst = library_dir.join(LIBRARY_SKILLS_DIR).join(format!(".htybox-trash-{nanos}"));
        fs::rename(&dir, &dst).map_err(|e| format!("移除 {} 失败: {e}", dir.display()))?;
        trash = Some(dst);
    }
    save_library(library_dir, &library)?;
    if let Some(dst) = trash {
        let _ = fs::remove_dir_all(&dst);
    }
    Ok(())
}

/// 去工程化整理指令(注入 agent 终端用;plan-4 接线)。
fn curation_brief(library_dir: &Path, workspace: &Path, skill_id: &str) -> String {
    [
        "以下 skill 刚被收编进全局权威 hty 环境库,请做「去工程化」审查并直接修改库内文件:".to_string(),
        format!(
            "- 库内路径: {}",
            library_dir.join(LIBRARY_SKILLS_DIR).join(skill_id).display()
        ),
        format!("- 源工程: {}", workspace.display()),
        "- 审查点: ①移除只对源工程成立的路径/工具链/专名;②frontmatter name/description 语义保持不变;③落盘路径措辞统一为 .htyworkflows/*。".to_string(),
        "- 完成后直接保存库内文件;各工程此后经「从库更新」取回,勿直接改工程副本。".to_string(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &PathBuf, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// 最小已初始化工程:manifest 登记 alpha(sha 正确),canonical 有 alpha。
    fn setup_workspace() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().to_path_buf();
        let root = ws.join(manifest::ENV_DIR);
        let body = "---\nname: alpha\n---\nA\n";
        write(&root.join("skills/alpha/SKILL.md"), body);
        write(&root.join("skills/alpha/references/r.md"), "ref");
        let sha = manifest::sha256_hex_upper(body.as_bytes());
        let text = format!(
            r#"{{
  "schemaVersion": 1,
  "providers": {{
    "claude": {{ "adapterDir": ".claude/skills" }},
    "codex": {{ "adapterDir": ".agents/skills" }}
  }},
  "skills": [ {{ "id": "alpha", "entrySha256": "{sha}", "fileCount": 2 }} ]
}}"#
        );
        write(&root.join(manifest::MANIFEST_FILE), &text);
        (tmp, ws)
    }

    #[test]
    fn ensure_library_idempotent_and_status() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path().join("global-env");
        let first = ensure_library(&lib).unwrap();
        let second = ensure_library(&lib).unwrap();
        assert_eq!(first.library_id, second.library_id, "二次 ensure 不得换库身份");
        assert!(
            first.skills.iter().any(|s| s.id == "htyenv-native-migrate"),
            "出厂须装入迁移种子 skill"
        );
        assert!(is_bundled_entry(
            first.skills.iter().find(|s| s.id == "htyenv-native-migrate").unwrap()
        ));
        let status = library_status(&lib);
        assert!(status.present);
        assert_eq!(status.skill_count, Some(SEED_SKILLS.len()));
        assert_eq!(status.template_version, Some(TEMPLATE_VERSION));
    }

    #[test]
    fn seed_skills_skip_user_owned_and_refresh_bundled() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path().join("global-env");
        let mut m = ensure_library(&lib).unwrap();
        let seed_id = "htyenv-native-migrate";
        let seed_sha = m
            .skills
            .iter()
            .find(|s| s.id == seed_id)
            .unwrap()
            .current_sha256
            .clone();

        // 用户版(无 bundled):ensure 不得覆盖
        let user_body = "---\nname: htyenv-native-migrate\n---\nuser edition\n";
        let user_sha = manifest::sha256_hex_upper(user_body.as_bytes());
        let dir = lib.join(LIBRARY_SKILLS_DIR).join(seed_id);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), user_body).unwrap();
        if let Some(e) = m.skills.iter_mut().find(|s| s.id == seed_id) {
            e.current_sha256 = user_sha.clone();
            e.file_count = 1;
            e.extra.clear(); // 去掉 bundled
            e.versions.push(LibraryVersion {
                sha256: user_sha.clone(),
                collected_utc: manifest::now_utc_rfc3339().unwrap(),
                source_workspace: Some("G:/user-ws".into()),
                extra: Map::new(),
            });
        }
        save_library(&lib, &m).unwrap();
        let after = ensure_library(&lib).unwrap();
        let e = after.skills.iter().find(|s| s.id == seed_id).unwrap();
        assert_eq!(e.current_sha256, user_sha, "用户收编版不得被种子覆盖");
        assert!(!is_bundled_entry(e));

        // 恢复为 bundled 旧 sha → 应刷新回种子
        if let Some(e) = m.skills.iter_mut().find(|s| s.id == seed_id) {
            e.current_sha256 = "DEADBEEF".repeat(8); // 假旧哈希
            e.extra.insert(BUNDLED_KEY.into(), serde_json::json!(true));
        }
        // 注意:上面 m 已是旧内存态;重载用户版后再标 bundled
        let mut m2 = load_library(&lib).unwrap();
        if let Some(e) = m2.skills.iter_mut().find(|s| s.id == seed_id) {
            e.extra.insert(BUNDLED_KEY.into(), serde_json::json!(true));
            // 保持 user_sha 与文件一致但 bundled=true → ensure 因 sha==文件? 
            // seed_sha != user_sha → 应刷新为种子内容
        }
        save_library(&lib, &m2).unwrap();
        let refreshed = ensure_library(&lib).unwrap();
        let e2 = refreshed.skills.iter().find(|s| s.id == seed_id).unwrap();
        assert_eq!(e2.current_sha256, seed_sha, "bundled 异版应刷新为种子");
        assert!(is_bundled_entry(e2));
        let live = fs::read_to_string(dir.join("SKILL.md")).unwrap();
        assert!(live.contains("原生 Agent 环境"), "实体须写回种子正文");
    }

    #[test]
    fn collect_then_fetch_round_trip() {
        let (_a, ws) = setup_workspace();
        let libtmp = tempfile::tempdir().unwrap();
        let lib = libtmp.path().join("global-env");

        let collected = collect_skill(&ws, &lib, "alpha").unwrap();
        assert_eq!(collected.status, "collected");
        assert!(lib.join("skills/alpha/references/r.md").is_file(), "整目录收编");
        let lm = load_library(&lib).unwrap();
        assert_eq!(lm.skills[0].versions.len(), 1);
        assert_eq!(lm.skills[0].current_sha256, collected.library_sha256);
        // 工程 manifest 写入谱系基线
        let wm = manifest::load(&ws).unwrap();
        assert_eq!(wm.skills[0].library_sha.as_deref(), Some(collected.library_sha256.as_str()));
        // 幂等收编
        assert_eq!(collect_skill(&ws, &lib, "alpha").unwrap().status, "alreadyPresent");
        // 库异版拒绝
        fs::write(lib.join("skills/alpha/SKILL.md"), "---\nname: alpha\n---\nLIB\n").unwrap();
        let mut lm2 = load_library(&lib).unwrap();
        lm2.skills[0].current_sha256 =
            manifest::sha256_hex_upper(b"---\nname: alpha\n---\nLIB\n");
        save_library(&lib, &lm2).unwrap();
        assert!(collect_skill(&ws, &lib, "alpha").unwrap_err().contains("plan-3"));

        // 取件到全新工程:登记 + librarySha + 薄壳
        let (_b, ws2) = setup_workspace();
        fs::remove_dir_all(ws2.join(manifest::ENV_DIR).join("skills/alpha")).unwrap();
        let mut m2 = manifest::load(&ws2).unwrap();
        m2.skills.clear();
        manifest::save(&ws2, &m2).unwrap();
        let fetched = fetch_skill(&lib, &ws2, "alpha").unwrap();
        assert_eq!(fetched.status, "fetched");
        assert_eq!(fetched.written_adapters, 2);
        assert!(ws2.join(".claude/skills/alpha/SKILL.md").is_file());
        assert!(ws2.join(".agents/skills/alpha/SKILL.md").is_file());
        let wm2 = manifest::load(&ws2).unwrap();
        assert_eq!(wm2.skills.len(), 1);
        assert_eq!(wm2.skills[0].entry_sha256, fetched.library_sha256);
        assert_eq!(wm2.skills[0].library_sha.as_deref(), Some(fetched.library_sha256.as_str()));
        // 取件幂等;工程异版拒绝
        assert_eq!(fetch_skill(&lib, &ws2, "alpha").unwrap().status, "alreadyPresent");
        fs::write(
            ws2.join(manifest::ENV_DIR).join("skills/alpha/SKILL.md"),
            "---\nname: alpha\n---\nWS\n",
        )
        .unwrap();
        assert!(fetch_skill(&lib, &ws2, "alpha").unwrap_err().contains("plan-3"));
    }

    #[test]
    fn list_and_delete_library_skill_round_trip() {
        let (_a, ws) = setup_workspace();
        let libtmp = tempfile::tempdir().unwrap();
        let lib = libtmp.path().join("global-env");
        collect_skill(&ws, &lib, "alpha").unwrap();
        let list = list_library_skills(&lib).unwrap();
        // 库含收编的 alpha + 出厂种子 htyenv-native-migrate（ensure_library 必装）→ 定向断言 alpha，勿硬编码计数
        let alpha = list.iter().find(|s| s.id == "alpha").expect("alpha 应在库内");
        assert_eq!(alpha.versions.len(), 1);
        assert!(!alpha.entry_missing);
        assert!(alpha.versions[0].source_workspace.is_some());
        delete_library_skill(&lib, "alpha").unwrap();
        assert!(
            list_library_skills(&lib).unwrap().iter().all(|s| s.id != "alpha"),
            "alpha 应已移除（种子仍在）"
        );
        assert!(!lib.join("skills/alpha").exists(), "实体应移除");
        assert!(delete_library_skill(&lib, "alpha").is_err(), "重删应报无此 skill");
        // 删除后同 id 目录位腾空,可再收编
        assert_eq!(collect_skill(&ws, &lib, "alpha").unwrap().status, "collected");
    }

    #[test]
    fn collect_requires_registration_and_rejects_symlinkless_missing() {
        let (_a, ws) = setup_workspace();
        let libtmp = tempfile::tempdir().unwrap();
        let lib = libtmp.path().join("global-env");
        // 未登记 → 拒绝
        fs::create_dir_all(ws.join(manifest::ENV_DIR).join("skills/beta")).unwrap();
        fs::write(
            ws.join(manifest::ENV_DIR).join("skills/beta/SKILL.md"),
            "---\nname: beta\n---\nB\n",
        )
        .unwrap();
        assert!(collect_skill(&ws, &lib, "beta").unwrap_err().contains("UNREGISTERED"));
        // canonical 缺失 → 拒绝
        assert!(collect_skill(&ws, &lib, "nope").is_err());
    }
}
