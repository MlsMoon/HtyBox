//! 扫描并解析 Claude 的 Skill 与 Memory（M3）。
//! Skill：user(`~/.claude/skills`)、project(`<proj>/.claude/skills`)、plugin(市场)。
//! Memory：`~/.claude/projects/<slug>/memory/*.md`（排除 MEMORY.md 索引）。

use std::path::{Path, PathBuf};

use serde::Serialize;
use walkdir::WalkDir;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
    /// "user" | "project" | "plugin:<plugin>"
    pub source: String,
    /// 推导出的调用串：`/name` 或 `/plugin:name`
    pub invoke: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub name: String,
    pub description: String,
    pub mem_type: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub slug: String,
    pub path: String,
    pub memory_count: usize,
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// 解析以 `---` 包裹的 YAML frontmatter。
fn parse_frontmatter(content: &str) -> Option<serde_yaml::Value> {
    let rest = content.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    serde_yaml::from_str(&rest[..end]).ok()
}

fn str_field(v: &serde_yaml::Value, key: &str) -> Option<String> {
    v.get(key)?
        .as_str()
        .map(|s| s.trim().to_string())
        // 值存在但为空/纯空白时视作"无"，让上层回退到文件名（否则 name 落空 → 空白卡片）
        .filter(|s| !s.is_empty())
}

fn file_stem(p: &Path) -> String {
    p.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("?")
        .to_string()
}

// ---------------- Skill ----------------

fn parse_skill(skill_md: &Path, source: String) -> Option<Skill> {
    let content = std::fs::read_to_string(skill_md).ok()?;
    let fm = parse_frontmatter(&content);
    let name = fm
        .as_ref()
        .and_then(|v| str_field(v, "name"))
        .unwrap_or_else(|| {
            skill_md
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("?")
                .to_string()
        });
    let description = fm
        .as_ref()
        .and_then(|v| str_field(v, "description"))
        .unwrap_or_default();
    let invoke = match source.strip_prefix("plugin:") {
        Some(plugin) => format!("/{plugin}:{name}"),
        None => format!("/{name}"),
    };
    Some(Skill {
        name,
        description,
        path: skill_md.to_string_lossy().into_owned(),
        source,
        invoke,
    })
}

/// 扫描某目录下每个一级子目录里的 SKILL.md。
fn scan_skill_dir(dir: &Path, source: &str, out: &mut Vec<Skill>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            let skill_md = p.join("SKILL.md");
            if skill_md.is_file() {
                if let Some(s) = parse_skill(&skill_md, source.to_string()) {
                    out.push(s);
                }
            }
        }
    }
}

/// 递归扫描插件市场里的 `*/skills/*/SKILL.md`，插件名取 skills 目录的父目录名。
fn scan_plugin_skills(root: &Path, out: &mut Vec<Skill>) {
    if !root.is_dir() {
        return;
    }
    for entry in WalkDir::new(root)
        .max_depth(8)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() && entry.file_name() == "SKILL.md" {
            let p = entry.path();
            let plugin = p
                .parent() // <skill>/
                .and_then(|d| d.parent()) // skills/
                .and_then(|d| d.parent()) // <plugin>/
                .and_then(|d| d.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("plugin")
                .to_string();
            if let Some(s) = parse_skill(p, format!("plugin:{plugin}")) {
                out.push(s);
            }
        }
    }
}

pub fn scan_skills(project_dir: Option<&str>) -> Vec<Skill> {
    let mut out = Vec::new();
    if let Some(h) = home() {
        scan_skill_dir(&h.join(".claude").join("skills"), "user", &mut out);
        scan_plugin_skills(
            &h.join(".claude").join("plugins").join("marketplaces"),
            &mut out,
        );
    }
    if let Some(pd) = project_dir.filter(|p| !p.is_empty()) {
        scan_skill_dir(
            &Path::new(pd).join(".claude").join("skills"),
            "project",
            &mut out,
        );
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// 只扫某工作区文件夹自己的 `<dir>/.claude/skills`（用户/插件级 skill 留给未来单独界面）。
pub fn scan_project_skills(project_dir: &str) -> Vec<Skill> {
    let mut out = Vec::new();
    if !project_dir.is_empty() {
        scan_skill_dir(
            &Path::new(project_dir).join(".claude").join("skills"),
            "project",
            &mut out,
        );
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

// ---------------- M8：Skill 上架/下架管理（工作区级） ----------------
// 活动根可配置（默认 `.claude/skills`）：上架 = <pd>/<skills_rel>/<dir>；
// 下架 = 同 agent 根下 <pd>/<agentRoot>/downtime/skills/<dir>（镜像规则）。
// 标识统一用文件夹名 `dir`（稳定），不用可能与文件夹名不一致的 frontmatter name。

/// 默认 skill 根（相对工作区）；与前端默认候选首项对齐。
pub const DEFAULT_SKILLS_REL: &str = ".claude/skills";

/// 在候选列表中按顺序解析出唯一激活根（不合并扫描）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSkillRoot {
    /// 当前唯一激活的 skills 相对路径
    pub active: String,
    /// 是否在某个候选上「发现」了目录（skills 或 downtime 存在）
    pub found: bool,
    /// 归一化后的候选顺序（去重）
    pub candidates: Vec<String>,
}

/// 某相对根是否已在工作区出现（上架或下架目录任一存在即算发现）。
pub fn skill_root_present(project_dir: &str, skills_rel: &str) -> Result<bool, String> {
    let (skills, down) = resolve_skills_pair(project_dir, skills_rel)?;
    Ok(skills.is_dir() || down.is_dir())
}

/// 按候选顺序选唯一激活根：第一个「发现」的胜出；若皆未发现则回退到候选首项（便于空仓库新建）。
/// 非法候选项跳过（不因单项坏路径让整次解析失败）。
pub fn resolve_active_skill_root(
    project_dir: &str,
    candidates: &[String],
) -> Result<ActiveSkillRoot, String> {
    let mut normalized: Vec<String> = Vec::new();
    for c in candidates {
        match normalize_skills_rel(c) {
            Ok(n) if !normalized.iter().any(|x| x == &n) => normalized.push(n),
            _ => {}
        }
    }
    if normalized.is_empty() {
        normalized.push(DEFAULT_SKILLS_REL.to_string());
    }
    if project_dir.is_empty() {
        return Ok(ActiveSkillRoot {
            active: normalized[0].clone(),
            found: false,
            candidates: normalized,
        });
    }
    for rel in &normalized {
        if skill_root_present(project_dir, rel)? {
            return Ok(ActiveSkillRoot {
                active: rel.clone(),
                found: true,
                candidates: normalized,
            });
        }
    }
    Ok(ActiveSkillRoot {
        active: normalized[0].clone(),
        found: false,
        candidates: normalized,
    })
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkill {
    pub name: String,
    pub description: String,
    /// 文件夹名 = 稳定标识（移动/模板都用它）
    pub dir: String,
    /// 调用串 `/name`
    pub invoke: String,
    /// SKILL.md 绝对路径（上架后拖拽注入用）
    pub path: String,
    /// true=在活动 skills 根；false=在对应 downtime/skills
    pub enabled: bool,
}

/// 归一化并校验工作区相对的 skills 根路径。
/// 须相对、无 `..`、无空段、不以盘符/UNC/绝对 `/` 开头，且末段为 `skills`。
pub fn normalize_skills_rel(skills_rel: &str) -> Result<String, String> {
    let s = skills_rel.trim().replace('\\', "/");
    if s.is_empty() {
        return Err("skill 根路径不能为空".into());
    }
    // 绝对路径：Unix 根、Windows 盘符（C:）、UNC（//server）
    if s.starts_with('/') {
        return Err(format!(
            "skill 根须为工作区相对路径，不能是绝对路径：{skills_rel}"
        ));
    }
    let s = s.trim_end_matches('/').to_string();
    if s.is_empty() {
        return Err("skill 根路径不能为空".into());
    }
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        return Err(format!(
            "skill 根须为工作区相对路径，不能是绝对路径：{skills_rel}"
        ));
    }
    for seg in s.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(format!("skill 根路径非法（含空段或 ..）：{skills_rel}"));
        }
    }
    if !s.ends_with("/skills") && s != "skills" {
        return Err(format!(
            "skill 根路径须以 skills 结尾（例如 .claude/skills），当前：{s}"
        ));
    }
    Ok(s)
}

/// 由工作区 + skills 相对根推导 (skills 绝对路径, downtime/skills 绝对路径)。
pub fn resolve_skills_pair(
    project_dir: &str,
    skills_rel: &str,
) -> Result<(PathBuf, PathBuf), String> {
    if project_dir.is_empty() {
        return Err("工作区路径为空".into());
    }
    let rel = normalize_skills_rel(skills_rel)?;
    let mut skills = PathBuf::from(project_dir);
    for seg in rel.split('/') {
        skills.push(seg);
    }
    let mut downtime = skills.clone();
    downtime.pop(); // 去掉末段 skills → agent 根（如 .claude）
    downtime.push("downtime");
    downtime.push("skills");
    Ok((skills, downtime))
}

/// 解析一个 skill 文件夹为 ManagedSkill；无 SKILL.md 则返回 None。
fn parse_managed_skill(skill_dir: &Path, enabled: bool) -> Option<ManagedSkill> {
    let skill_md = skill_dir.join("SKILL.md");
    if !skill_md.is_file() {
        return None;
    }
    let dir = skill_dir.file_name().and_then(|n| n.to_str())?.to_string();
    let content = std::fs::read_to_string(&skill_md).ok()?;
    let fm = parse_frontmatter(&content);
    let name = fm
        .as_ref()
        .and_then(|v| str_field(v, "name"))
        .unwrap_or_else(|| dir.clone());
    let description = fm
        .as_ref()
        .and_then(|v| str_field(v, "description"))
        .unwrap_or_default();
    let invoke = format!("/{name}");
    Some(ManagedSkill {
        name,
        description,
        dir,
        invoke,
        path: skill_md.to_string_lossy().into_owned(),
        enabled,
    })
}

/// 扫某根目录下每个含 SKILL.md 的一级子目录。
fn scan_managed_dir(root: &Path, enabled: bool, out: &mut Vec<ManagedSkill>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(s) = parse_managed_skill(&p, enabled) {
                out.push(s);
            }
        }
    }
}

/// 返回某根目录下的一级子目录名列表（用于 apply 计算当前已上架集合）。
fn skill_dir_names(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if let Some(n) = p.file_name().and_then(|s| s.to_str()) {
                    out.push(n.to_string());
                }
            }
        }
    }
    out
}

/// 扫工作区级 上架(skills_rel) + 下架(镜像 downtime/skills) 的全部 skill。
/// `skills_rel` 为空时回退 [`DEFAULT_SKILLS_REL`]。
pub fn scan_managed_skills(
    project_dir: &str,
    skills_rel: &str,
) -> Result<Vec<ManagedSkill>, String> {
    let mut out = Vec::new();
    if project_dir.is_empty() {
        return Ok(out);
    }
    let rel = if skills_rel.trim().is_empty() {
        DEFAULT_SKILLS_REL
    } else {
        skills_rel
    };
    let (active, down) = resolve_skills_pair(project_dir, rel)?;
    scan_managed_dir(&active, true, &mut out);
    scan_managed_dir(&down, false, &mut out);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// 校验文件夹名安全（防路径越界）。
fn sanitize_dir(dir: &str) -> Result<(), String> {
    if dir.is_empty() || dir.contains('/') || dir.contains('\\') || dir.contains("..") {
        return Err(format!("非法 skill 目录名：{dir}"));
    }
    Ok(())
}

/// 上架/下架一个 skill 文件夹（同卷原子 rename）。`skills_rel` 为空回退默认根。
pub fn set_skill_enabled(
    project_dir: &str,
    dir: &str,
    enabled: bool,
    skills_rel: &str,
) -> Result<(), String> {
    sanitize_dir(dir)?;
    let rel = if skills_rel.trim().is_empty() {
        DEFAULT_SKILLS_REL
    } else {
        skills_rel
    };
    let (active_root, down_root) = resolve_skills_pair(project_dir, rel)?;
    let active = active_root.join(dir);
    let down = down_root.join(dir);
    let (from, to) = if enabled {
        (&down, &active)
    } else {
        (&active, &down)
    };
    if !from.is_dir() {
        return Err(format!("源目录不存在：{}", from.display()));
    }
    if to.exists() {
        return Err(format!("目标已存在，未覆盖：{}", to.display()));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(from, to).map_err(|e| e.to_string())
}

/// 应用模板：目标 dirs 全上架、其余全下架。单项失败不中断，收集为 warnings 返回。
/// 路径非法时以单条 warning 返回（不 Err），便于前端展示。
pub fn apply_skill_template(
    project_dir: &str,
    dirs: &[String],
    skills_rel: &str,
) -> Vec<String> {
    let mut warnings = Vec::new();
    let mut target: std::collections::HashSet<String> = std::collections::HashSet::new();
    for d in dirs {
        match sanitize_dir(d) {
            Ok(()) => {
                target.insert(d.clone());
            }
            Err(e) => warnings.push(e),
        }
    }
    let rel = if skills_rel.trim().is_empty() {
        DEFAULT_SKILLS_REL
    } else {
        skills_rel
    };
    let (active_root, _) = match resolve_skills_pair(project_dir, rel) {
        Ok(p) => p,
        Err(e) => {
            warnings.push(e);
            return warnings;
        }
    };
    let current = skill_dir_names(&active_root);
    for d in &current {
        if !target.contains(d) {
            if let Err(e) = set_skill_enabled(project_dir, d, false, rel) {
                warnings.push(format!("下架 {d} 失败：{e}"));
            }
        }
    }
    for d in &target {
        if !current.contains(d) {
            if let Err(e) = set_skill_enabled(project_dir, d, true, rel) {
                warnings.push(format!("上架 {d} 失败：{e}"));
            }
        }
    }
    warnings
}

// ---------------- Memory ----------------

fn projects_root() -> Option<PathBuf> {
    home().map(|h| h.join(".claude").join("projects"))
}

/// Claude 原生 project bucket 的权威解析结果。
///
/// `exists` 只表示 project storage 已存在；`memory_dir` 可以尚未创建。
/// 当 `exists == false` 时，`actual_slug` 等于未来应使用的 `expected_slug`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClaudeProjectPaths {
    pub workspace: PathBuf,
    pub projects_root: PathBuf,
    pub expected_slug: String,
    pub actual_slug: String,
    pub storage_dir: PathBuf,
    pub memory_dir: PathBuf,
    pub exists: bool,
}

/// 与前端 `slugify` 完全一致：逐字符把 `: \\ / _` 替换为 `-`，不折叠连字符。
pub(crate) fn claude_project_slug(project_dir: &str) -> Result<String, String> {
    if project_dir.is_empty() {
        return Err("工作区路径不能为空".to_string());
    }
    if !Path::new(project_dir).is_absolute() {
        return Err(format!("工作区路径必须是绝对路径：{project_dir}"));
    }
    if Path::new(project_dir).components().any(|component| {
        matches!(
            component,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    }) {
        return Err("工作区路径不能包含 . 或 ..".into());
    }
    Ok(project_dir
        .chars()
        .map(|ch| match ch {
            ':' | '\\' | '/' | '_' => '-',
            other => other,
        })
        .collect())
}

fn metadata_if_present(path: &Path) -> Result<Option<std::fs::Metadata>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法检查路径 {}：{error}", path.display())),
    }
}

fn is_reparse_or_symlink(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn validate_plain_directory(path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        metadata_if_present(path)?.ok_or_else(|| format!("{label}不存在：{}", path.display()))?;
    if is_reparse_or_symlink(&metadata) {
        return Err(format!(
            "{label}不能是符号链接或 reparse point：{}",
            path.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!("{label}必须是目录：{}", path.display()));
    }
    Ok(())
}

fn validate_optional_plain_directory(path: &Path, label: &str) -> Result<bool, String> {
    let Some(metadata) = metadata_if_present(path)? else {
        return Ok(false);
    };
    if is_reparse_or_symlink(&metadata) {
        return Err(format!(
            "{label}不能是符号链接或 reparse point：{}",
            path.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!(
            "{label}存在同名文件，必须是目录：{}",
            path.display()
        ));
    }
    Ok(true)
}

fn case_insensitive_key(value: &str) -> String {
    value.chars().flat_map(char::to_lowercase).collect()
}

fn select_project_match(
    expected_slug: &str,
    candidates: Vec<(String, PathBuf)>,
) -> Result<Option<(String, PathBuf)>, String> {
    let expected_key = case_insensitive_key(expected_slug);
    let mut matches: Vec<_> = candidates
        .into_iter()
        .filter(|(name, _)| case_insensitive_key(name) == expected_key)
        .collect();
    matches.sort_by(|left, right| left.0.cmp(&right.0));
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.pop()),
        _ => Err(format!(
            "Claude projects 下存在多个大小写不敏感同名目录，无法确定目标：{}",
            matches
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// 只解析、不创建目录；测试可注入隔离的 home。
pub(crate) fn resolve_claude_project_in_home(
    project_dir: &str,
    home_dir: &Path,
) -> Result<ClaudeProjectPaths, String> {
    let expected_slug = claude_project_slug(project_dir)?;
    let workspace = PathBuf::from(project_dir);
    validate_plain_directory(&workspace, "工作区")?;
    validate_plain_directory(home_dir, "用户 home")?;

    let claude_root = home_dir.join(".claude");
    let claude_exists = validate_optional_plain_directory(&claude_root, "Claude 配置目录")?;
    let projects_root = claude_root.join("projects");
    let projects_exists = if claude_exists {
        validate_optional_plain_directory(&projects_root, "Claude projects 目录")?
    } else {
        false
    };

    let selected = if projects_exists {
        let entries = std::fs::read_dir(&projects_root)
            .map_err(|error| format!("无法读取 Claude projects 目录：{error}"))?;
        let mut candidates = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| format!("无法读取 Claude project 条目：{error}"))?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            candidates.push((name, entry.path()));
        }
        select_project_match(&expected_slug, candidates)?
    } else {
        None
    };

    let (actual_slug, storage_dir, exists) = match selected {
        Some((actual_slug, storage_dir)) => {
            validate_plain_directory(&storage_dir, "Claude project storage")?;
            (actual_slug, storage_dir, true)
        }
        None => (
            expected_slug.clone(),
            projects_root.join(&expected_slug),
            false,
        ),
    };
    let memory_dir = storage_dir.join("memory");
    if exists {
        validate_optional_plain_directory(&memory_dir, "Claude memory 目录")?;
    }

    Ok(ClaudeProjectPaths {
        workspace,
        projects_root,
        expected_slug,
        actual_slug,
        storage_dir,
        memory_dir,
        exists,
    })
}

pub(crate) fn resolve_claude_project(project_dir: &str) -> Result<ClaudeProjectPaths, String> {
    let home_dir = home().ok_or_else(|| "无法定位用户 home 目录".to_string())?;
    resolve_claude_project_in_home(project_dir, &home_dir)
}

fn count_memory_md(mem_dir: &Path) -> usize {
    std::fs::read_dir(mem_dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| {
                    let p = e.path();
                    p.extension().map(|x| x == "md").unwrap_or(false)
                        && !p
                            .file_name()
                            .map(|n| n.eq_ignore_ascii_case("MEMORY.md"))
                            .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

pub fn list_projects() -> Vec<ProjectRef> {
    let mut out = Vec::new();
    let Some(root) = projects_root() else {
        return out;
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            let count = count_memory_md(&p.join("memory"));
            if count > 0 {
                out.push(ProjectRef {
                    slug: file_name_str(&p),
                    path: p.to_string_lossy().into_owned(),
                    memory_count: count,
                });
            }
        }
    }
    out.sort_by(|a, b| {
        b.memory_count
            .cmp(&a.memory_count)
            .then(a.slug.cmp(&b.slug))
    });
    out
}

fn file_name_str(p: &Path) -> String {
    p.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string()
}

fn parse_memory(md: &Path) -> Option<MemoryItem> {
    let content = std::fs::read_to_string(md).ok()?;
    let fm = parse_frontmatter(&content);
    let name = fm
        .as_ref()
        .and_then(|v| str_field(v, "name"))
        .unwrap_or_else(|| file_stem(md));
    let description = fm
        .as_ref()
        .and_then(|v| str_field(v, "description"))
        .unwrap_or_default();
    let mem_type = fm
        .as_ref()
        .and_then(|v| v.get("metadata"))
        .and_then(|m| m.get("type"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    Some(MemoryItem {
        name,
        description,
        mem_type,
        path: md.to_string_lossy().into_owned(),
    })
}

pub fn scan_memories(slug: &str) -> Vec<MemoryItem> {
    let mut out = Vec::new();
    let Some(root) = projects_root() else {
        return out;
    };
    let mem_dir = root.join(slug).join("memory");
    let Ok(entries) = std::fs::read_dir(&mem_dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().map(|x| x == "md").unwrap_or(false)
            && !p
                .file_name()
                .map(|n| n.eq_ignore_ascii_case("MEMORY.md"))
                .unwrap_or(false)
        {
            if let Some(m) = parse_memory(&p) {
                out.push(m);
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

// ---------------- M9：记忆树（分级文件夹 + 封面索引链结构）----------------
// 新记忆结构：memory/ 根 = MEMORY.md + 分组文件夹 index_N[_set]_<组>/；
// topic(feedback_*/project_*/reference_*) 物理在所属组文件夹内。
// 树视图：分组文件夹=枝、topic=叶；隐藏 MEMORY.md 与 index_*.md(封面/子域索引脚手架)。兼容旧平铺结构。

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemoryNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub mem_type: String,
    pub description: String,
    pub children: Vec<MemoryNode>,
}

fn build_memory_nodes(dir: &Path) -> Vec<MemoryNode> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            let children = build_memory_nodes(&p);
            if !children.is_empty() {
                out.push(MemoryNode {
                    name: file_name_str(&p),
                    path: p.to_string_lossy().into_owned(),
                    is_dir: true,
                    mem_type: String::new(),
                    description: String::new(),
                    children,
                });
            }
        } else if p.extension().map(|x| x == "md").unwrap_or(false) {
            let fname = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // 跳过 MEMORY.md 与 index_*.md(封面/子域索引脚手架)，只收真正的 topic
            if fname.eq_ignore_ascii_case("MEMORY.md") || fname.starts_with("index_") {
                continue;
            }
            if let Some(m) = parse_memory(&p) {
                out.push(MemoryNode {
                    name: m.name,
                    path: m.path,
                    is_dir: false,
                    mem_type: m.mem_type,
                    description: m.description,
                    children: Vec::new(),
                });
            }
        }
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

#[cfg(test)]
fn scan_memory_tree_in_home(project_dir: &str, home_dir: &Path) -> Result<Vec<MemoryNode>, String> {
    let resolved = resolve_claude_project_in_home(project_dir, home_dir)?;
    Ok(build_memory_nodes(&resolved.memory_dir))
}

/// 扫某工作区记忆为树（分组文件夹 → topic）。
///
/// 接收真实工作区路径，并通过 Claude project resolver 复用实际 bucket；不再信任前端 slug。
pub fn scan_memory_tree(project_dir: &str) -> Result<Vec<MemoryNode>, String> {
    let resolved = resolve_claude_project(project_dir)?;
    Ok(build_memory_nodes(&resolved.memory_dir))
}

/// 扫工作区 canonical 权威记忆为树(.htyworkflows/memory;plan-5 决策 2A「策展记忆」tab)。
/// 复用同一隐藏规则(MEMORY.md/index_*);imports/ 为契约段 include 机制目录,同属脚手架不呈现。
pub fn scan_canonical_memory_tree(project_dir: &str) -> Result<Vec<MemoryNode>, String> {
    let dir = Path::new(project_dir).join(".htyworkflows").join("memory");
    if !dir.is_dir() {
        return Err(format!("canonical 记忆目录不存在: {}", dir.display()));
    }
    Ok(build_memory_nodes(&dir)
        .into_iter()
        .filter(|n| !(n.is_dir && n.name == "imports"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn normalize_skills_rel_accepts_presets() {
        assert_eq!(
            normalize_skills_rel(".claude/skills").unwrap(),
            ".claude/skills"
        );
        assert_eq!(
            normalize_skills_rel(".cursor\\skills").unwrap(),
            ".cursor/skills"
        );
        assert_eq!(
            normalize_skills_rel(".agents/skills").unwrap(),
            ".agents/skills"
        );
        assert_eq!(normalize_skills_rel("skills").unwrap(), "skills");
    }

    #[test]
    fn normalize_skills_rel_rejects_absolute_and_dotdot() {
        assert!(normalize_skills_rel("C:\\foo\\skills").is_err());
        assert!(normalize_skills_rel("/abs/skills").is_err());
        assert!(normalize_skills_rel("../outside/skills").is_err());
        assert!(normalize_skills_rel(".claude").is_err()); // 不以 skills 结尾
        assert!(normalize_skills_rel("").is_err());
    }

    #[test]
    fn resolve_skills_pair_mirrors_downtime() {
        let (skills, down) = resolve_skills_pair(r"G:\proj", ".claude/skills").unwrap();
        assert_eq!(
            skills,
            PathBuf::from(r"G:\proj").join(".claude").join("skills")
        );
        assert_eq!(
            down,
            PathBuf::from(r"G:\proj")
                .join(".claude")
                .join("downtime")
                .join("skills")
        );
    }

    #[test]
    fn resolve_active_picks_first_present() {
        let tmp = TempDir::new().unwrap();
        let pd = tmp.path();
        std::fs::create_dir_all(pd.join(".cursor").join("skills")).unwrap();
        let r = resolve_active_skill_root(
            pd.to_str().unwrap(),
            &[
                ".claude/skills".into(),
                ".cursor/skills".into(),
                ".agents/skills".into(),
            ],
        )
        .unwrap();
        assert_eq!(r.active, ".cursor/skills");
        assert!(r.found);
    }

    #[test]
    fn resolve_active_falls_back_to_first_when_none() {
        let tmp = TempDir::new().unwrap();
        let r = resolve_active_skill_root(
            tmp.path().to_str().unwrap(),
            &[".cursor/skills".into(), ".agents/skills".into()],
        )
        .unwrap();
        assert_eq!(r.active, ".cursor/skills");
        assert!(!r.found);
    }

    struct ResolverFixture {
        _temp: TempDir,
        home: PathBuf,
        workspace: PathBuf,
        projects: PathBuf,
    }

    impl ResolverFixture {
        fn new(workspace_name: &str) -> Self {
            let temp = tempfile::tempdir().expect("tempdir");
            let home = temp.path().join("home");
            let workspace = temp.path().join(workspace_name);
            std::fs::create_dir_all(&home).expect("home");
            std::fs::create_dir_all(&workspace).expect("workspace");
            let projects = home.join(".claude").join("projects");
            Self {
                _temp: temp,
                home,
                workspace,
                projects,
            }
        }

        fn workspace_str(&self) -> &str {
            self.workspace.to_str().expect("UTF-8 fixture path")
        }
    }

    #[test]
    fn slug_matches_frontend_replacement_without_collapsing() {
        #[cfg(windows)]
        let (input, expected) = (r"C:\work__area/foo", "C--work--area-foo");
        #[cfg(not(windows))]
        let (input, expected) = ("/work:__area/foo", "-work---area-foo");

        assert_eq!(claude_project_slug(input).unwrap(), expected);
        assert!(claude_project_slug("relative/path").is_err());
    }

    #[test]
    fn resolver_returns_vacant_paths_without_creating_them() {
        let fixture = ResolverFixture::new("Workspace__One");
        let resolved =
            resolve_claude_project_in_home(fixture.workspace_str(), &fixture.home).unwrap();

        assert!(!resolved.exists);
        assert_eq!(resolved.actual_slug, resolved.expected_slug);
        assert_eq!(
            resolved.storage_dir,
            fixture.projects.join(&resolved.expected_slug)
        );
        assert_eq!(resolved.memory_dir, resolved.storage_dir.join("memory"));
        assert!(!fixture.home.join(".claude").exists());
    }

    #[test]
    fn resolver_reuses_the_unique_case_insensitive_directory() {
        let fixture = ResolverFixture::new("CaseWorkspace");
        let expected = claude_project_slug(fixture.workspace_str()).unwrap();
        let mut actual = expected.to_uppercase();
        if actual == expected {
            actual = expected.to_lowercase();
        }
        assert_ne!(actual, expected);
        let storage = fixture.projects.join(&actual);
        std::fs::create_dir_all(&storage).unwrap();

        let resolved =
            resolve_claude_project_in_home(fixture.workspace_str(), &fixture.home).unwrap();
        assert!(resolved.exists);
        assert_eq!(resolved.expected_slug, expected);
        assert_eq!(resolved.actual_slug, actual);
        assert_eq!(resolved.storage_dir, storage);
    }

    #[test]
    fn memory_tree_reads_the_resolved_actual_bucket() {
        let fixture = ResolverFixture::new("MemoryWorkspace");
        let expected = claude_project_slug(fixture.workspace_str()).unwrap();
        let mut actual = expected.to_uppercase();
        if actual == expected {
            actual = expected.to_lowercase();
        }
        let memory = fixture.projects.join(&actual).join("memory");
        std::fs::create_dir_all(&memory).unwrap();
        std::fs::write(memory.join("project_actual.md"), b"actual bucket").unwrap();

        let nodes = scan_memory_tree_in_home(fixture.workspace_str(), &fixture.home).unwrap();

        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "project_actual");
        assert_eq!(
            nodes[0].path,
            memory
                .join("project_actual.md")
                .to_string_lossy()
                .into_owned()
        );
    }

    #[test]
    fn selection_rejects_case_insensitive_ambiguity() {
        let result = select_project_match(
            "Project-A",
            vec![
                ("project-a".into(), PathBuf::from("one")),
                ("PROJECT-A".into(), PathBuf::from("two")),
            ],
        );
        let error = result.unwrap_err();
        assert!(error.contains("多个"));
        assert!(error.contains("PROJECT-A"));
        assert!(error.contains("project-a"));
    }

    #[test]
    fn resolver_rejects_missing_or_non_directory_workspace() {
        let fixture = ResolverFixture::new("Workspace");
        let relative_error =
            resolve_claude_project_in_home("relative/path", &fixture.home).unwrap_err();
        assert!(relative_error.contains("绝对路径"));

        let child = fixture.workspace.join("child");
        std::fs::create_dir_all(&child).unwrap();
        let with_parent = child.join("..");
        let error = resolve_claude_project_in_home(with_parent.to_str().unwrap(), &fixture.home)
            .unwrap_err();
        assert!(error.contains("不能包含"));

        let missing = fixture.workspace.join("missing");
        assert!(resolve_claude_project_in_home(missing.to_str().unwrap(), &fixture.home).is_err());

        let file = fixture.workspace.join("file.txt");
        std::fs::write(&file, b"not a directory").unwrap();
        let error =
            resolve_claude_project_in_home(file.to_str().unwrap(), &fixture.home).unwrap_err();
        assert!(error.contains("必须是目录"));
    }

    #[test]
    fn resolver_rejects_a_matching_file_in_projects() {
        let fixture = ResolverFixture::new("Workspace");
        let expected = claude_project_slug(fixture.workspace_str()).unwrap();
        std::fs::create_dir_all(&fixture.projects).unwrap();
        std::fs::write(fixture.projects.join(expected), b"collision").unwrap();

        let error =
            resolve_claude_project_in_home(fixture.workspace_str(), &fixture.home).unwrap_err();
        assert!(error.contains("必须是目录"));
    }

    #[test]
    fn resolver_rejects_a_memory_file_collision() {
        let fixture = ResolverFixture::new("Workspace");
        let expected = claude_project_slug(fixture.workspace_str()).unwrap();
        let storage = fixture.projects.join(expected);
        std::fs::create_dir_all(&storage).unwrap();
        std::fs::write(storage.join("memory"), b"collision").unwrap();

        let error =
            resolve_claude_project_in_home(fixture.workspace_str(), &fixture.home).unwrap_err();
        assert!(error.contains("同名文件"));
    }

    #[test]
    fn resolver_rejects_symlink_workspace_when_supported() {
        let fixture = ResolverFixture::new("RealWorkspace");
        let link = fixture._temp.path().join("LinkedWorkspace");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&fixture.workspace, &link).is_ok();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&fixture.workspace, &link).is_ok();
        #[cfg(not(any(windows, unix)))]
        let linked = false;

        if linked {
            let error =
                resolve_claude_project_in_home(link.to_str().unwrap(), &fixture.home).unwrap_err();
            assert!(error.contains("符号链接") || error.contains("reparse point"));
        }
    }
}
