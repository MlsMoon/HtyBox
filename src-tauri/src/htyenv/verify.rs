// htyenv/verify.rs —— canonical 完整性综合校验(verify.ps1 九组移植)+ path-audit(路径语义审计)。
// 组序与 PS 版一致;第 5 组(HtyHub registry)为工程条件项(决策 4);孤儿薄壳为引擎新增组(PS 无)。
// path-audit 豁免清单来自可选配置 tools/path-audit-skip.json(工程特有数据的配置点,缺省为空)。
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::adapters::{self, AdapterState};
use super::manifest::{self, WorkflowManifest, SKILL_ENTRY};

/// 活跃写入目标目录:引用出厂结构权威清单(plan-2 落地,终结清单漂移)。
use super::template::ACTIVE_WRITE_DIRS as ACTIVE_DIRS;

const REGISTRY_FILE: &str = "HtyHub/htyhub-skills-installed.json";
const AUDIT_SKIP_FILE: &str = "tools/path-audit-skip.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyCheck {
    pub name: String,
    pub passed: bool,
    /// 条件项因前提缺失而未执行(不计入整体失败)
    pub skipped: bool,
    pub details: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub checks: Vec<VerifyCheck>,
    pub all_passed: bool,
}

fn check(name: &str, details: Vec<String>) -> VerifyCheck {
    VerifyCheck {
        name: name.to_string(),
        passed: details.is_empty(),
        skipped: false,
        details,
    }
}

fn skipped(name: &str, reason: &str) -> VerifyCheck {
    VerifyCheck {
        name: name.to_string(),
        passed: true,
        skipped: true,
        details: vec![reason.to_string()],
    }
}

/// 综合校验主入口;cache_memory_dir 为 None 时第 9 组按条件项跳过。
pub fn verify(
    workspace: &Path,
    manifest_data: &WorkflowManifest,
    cache_memory_dir: Option<&Path>,
) -> Result<VerifyReport, String> {
    let mut checks = Vec::new();
    checks.push(check_counts(workspace, manifest_data)?);
    let (entry_case, frontmatter, hash) = check_entries(workspace, manifest_data)?;
    checks.push(entry_case);
    checks.push(frontmatter);
    checks.push(hash);
    checks.push(check_openai_yaml(workspace)?);
    let (adapter_check, orphan_check) = check_adapter_groups(workspace, manifest_data)?;
    checks.push(adapter_check);
    checks.push(orphan_check);
    checks.push(check_registry(workspace)?);
    checks.push(check_path_audit(workspace)?);
    checks.push(check_active_dirs(workspace));
    checks.push(check_protected(workspace, manifest_data)?);
    checks.push(check_memory_cache(workspace, cache_memory_dir)?);
    let all_passed = checks.iter().all(|c| c.passed);
    Ok(VerifyReport { checks, all_passed })
}

/// ① 数量与 ID 集合:canonical 目录集 == manifest 登记集。
fn check_counts(workspace: &Path, m: &WorkflowManifest) -> Result<VerifyCheck, String> {
    let ids: BTreeSet<String> = super::list_skill_dirs(workspace)?.into_iter().collect();
    let registered: BTreeSet<String> = m.skills.iter().map(|s| s.id.clone()).collect();
    let mut details = Vec::new();
    if ids.is_empty() && registered.is_empty() {
        // 全新环境两侧皆空视为一致(bootstrap 后未收编)
    }
    for missing in registered.difference(&ids) {
        details.push(format!("GHOST: manifest 登记 {missing} 但 canonical 无此目录"));
    }
    for unregistered in ids.difference(&registered) {
        details.push(format!("UNREGISTERED: canonical 有 {unregistered} 但 manifest 未登记"));
    }
    Ok(check("数量与 ID 集合: canonical == manifest", details))
}

/// ②(三项)入口精确大写 / frontmatter 可解析 / manifest entrySha256 与实际一致。
fn check_entries(
    workspace: &Path,
    m: &WorkflowManifest,
) -> Result<(VerifyCheck, VerifyCheck, VerifyCheck), String> {
    let mut bad_case = Vec::new();
    let mut bad_frontmatter = Vec::new();
    let mut bad_hash = Vec::new();
    for entry in &m.skills {
        let dir = manifest::skill_dir(workspace, &entry.id)?;
        let Some(actual) = find_entry_name(&dir)? else {
            bad_case.push(format!("{}: 缺入口 {SKILL_ENTRY}", entry.id));
            continue;
        };
        if actual != SKILL_ENTRY {
            bad_case.push(format!("{}: 入口大小写异常({actual})", entry.id));
            continue;
        }
        let path = dir.join(SKILL_ENTRY);
        let raw = fs::read(&path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
        if adapters::slice_frontmatter_bytes(&raw).is_none() {
            bad_frontmatter.push(format!("{}: frontmatter 不可解析", entry.id));
        }
        if manifest::sha256_hex_upper(&raw) != entry.entry_sha256 {
            bad_hash.push(format!("{}: entrySha256 漂移", entry.id));
        }
    }
    Ok((
        check("入口: 全部精确大写 SKILL.md", bad_case),
        check("frontmatter: 全部可解析", bad_frontmatter),
        check("manifest entrySha256 与实际一致", bad_hash),
    ))
}

/// 大小写不敏感地找入口文件的实际名称(None=不存在)。
fn find_entry_name(dir: &Path) -> Result<Option<String>, String> {
    if !dir.is_dir() {
        return Ok(None);
    }
    for entry in fs::read_dir(dir).map_err(|e| format!("读取 {} 失败: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("读取 {} 失败: {e}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.eq_ignore_ascii_case(SKILL_ENTRY) {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

/// ③ openai.yaml 编码:skills/ 下全部 openai.yaml 不得含 U+FFFD(损坏字符)。
fn check_openai_yaml(workspace: &Path) -> Result<VerifyCheck, String> {
    let root = manifest::env_root(workspace).join(manifest::SKILLS_DIR);
    let mut details = Vec::new();
    if root.is_dir() {
        for item in walkdir::WalkDir::new(&root) {
            let item = item.map_err(|e| format!("遍历 {} 失败: {e}", root.display()))?;
            if !item.file_type().is_file()
                || !item.file_name().to_string_lossy().eq_ignore_ascii_case("openai.yaml")
            {
                continue;
            }
            let raw = fs::read(item.path())
                .map_err(|e| format!("读取 {} 失败: {e}", item.path().display()))?;
            if String::from_utf8_lossy(&raw).contains('\u{fffd}') {
                details.push(format!("{} 含 U+FFFD", item.path().display()));
            }
        }
    }
    Ok(check("openai.yaml: 无 U+FFFD", details))
}

/// ④ 适配器契约一致(PS sync-adapters -Check 等价) + 孤儿薄壳(引擎新增组)。
fn check_adapter_groups(
    workspace: &Path,
    m: &WorkflowManifest,
) -> Result<(VerifyCheck, VerifyCheck), String> {
    let report = adapters::check_adapters(workspace, m)?;
    let mut details = Vec::new();
    for skill in &report.skills {
        for (provider, state) in &skill.states {
            match state {
                AdapterState::Consistent => {}
                AdapterState::Stale => details.push(format!("陈旧适配器: {provider}/{}", skill.id)),
                AdapterState::HandEdited => details.push(format!("手改/非生成内容: {provider}/{}", skill.id)),
                AdapterState::Missing => details.push(format!("缺失适配器: {provider}/{}", skill.id)),
            }
        }
    }
    for id in &report.canonical_missing_entry {
        details.push(format!("canonical 缺失入口: {id}"));
    }
    for rel in &report.metadata_missing {
        details.push(format!("缺失 codex metadata: {rel}"));
    }
    for rel in &report.metadata_out_of_sync {
        details.push(format!("codex metadata 不同步: {rel}"));
    }
    let orphan_details: Vec<String> = report
        .orphan_shells
        .iter()
        .map(|o| format!("缺真版(孤儿薄壳): {}/{}", o.provider, o.id))
        .collect();
    Ok((
        check("适配器: 与 canonical 契约一致", details),
        check("孤儿薄壳(缺真版)【引擎新增】", orphan_details),
    ))
}

/// ⑤ HtyHub registry 对账(工程条件项,决策 4):文件存在才校验。
fn check_registry(workspace: &Path) -> Result<VerifyCheck, String> {
    let name = "registry: HtyHub 与 canonical 一致(条件项)";
    let path = workspace.join(REGISTRY_FILE);
    if !path.is_file() {
        return Ok(skipped(name, "HtyHub/htyhub-skills-installed.json 不存在,跳过"));
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("registry 解析失败: {e}"))?;
    let mut details = Vec::new();
    let mut reg_ids = BTreeSet::new();
    match value["skills"].as_array() {
        None => details.push("registry 缺 skills 数组".to_string()),
        Some(items) => {
            for item in items {
                let Some(id) = item["id"].as_str() else {
                    details.push("registry 存在缺 id 的条目".to_string());
                    continue;
                };
                reg_ids.insert(id.to_string());
                let expect = format!(".htyworkflows/skills/{id}");
                if item["localPath"].as_str() != Some(expect.as_str()) {
                    details.push(format!("registry localPath 非 canonical: {id}"));
                }
            }
            let ids: BTreeSet<String> = super::list_skill_dirs(workspace)?.into_iter().collect();
            for extra in reg_ids.difference(&ids) {
                details.push(format!("registry 多出: {extra}"));
            }
            for missing in ids.difference(&reg_ids) {
                details.push(format!("registry 缺: {missing}"));
            }
        }
    }
    Ok(check(name, details))
}

/// ⑥ path-audit:活跃能力层(skills/rules/memory 索引)无未登记的 .claude/.agents 业务引用。
fn check_path_audit(workspace: &Path) -> Result<VerifyCheck, String> {
    let exempt = load_audit_exemptions(workspace)?;
    let violations = path_audit(workspace, &exempt)?;
    Ok(check("path-audit: 活跃层无未登记旧路径", violations))
}

/// 工程豁免清单(可选配置点):tools/path-audit-skip.json = ["skills/x/SKILL.md", ...](env 根相对,'/'分隔)。
fn load_audit_exemptions(workspace: &Path) -> Result<BTreeSet<String>, String> {
    let path = manifest::env_root(workspace).join(AUDIT_SKIP_FILE);
    if !path.is_file() {
        return Ok(BTreeSet::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    let list: Vec<String> =
        serde_json::from_str(&text).map_err(|e| format!("path-audit-skip.json 解析失败: {e}"))?;
    Ok(list.into_iter().map(|s| s.replace('\u{5C}', "/")).collect())
}

/// 路径语义审计(path-audit.ps1 同语义,扫描根为 canonical 三根;工程代码根扩展不在 V1)。
/// 返回违规行清单("<env 相对路径>:<行号>: <截断行>")。
pub fn path_audit(workspace: &Path, exempt_rel: &BTreeSet<String>) -> Result<Vec<String>, String> {
    let root = manifest::env_root(workspace);
    let mut targets: Vec<std::path::PathBuf> = Vec::new();
    let skills = root.join(manifest::SKILLS_DIR);
    if skills.is_dir() {
        for item in walkdir::WalkDir::new(&skills) {
            let item = item.map_err(|e| format!("遍历 {} 失败: {e}", skills.display()))?;
            if item.file_type().is_file() && audit_ext(&item.file_name().to_string_lossy()) {
                targets.push(item.path().to_path_buf());
            }
        }
    }
    let rules = root.join("rules");
    if rules.is_dir() {
        for item in walkdir::WalkDir::new(&rules) {
            let item = item.map_err(|e| format!("遍历 {} 失败: {e}", rules.display()))?;
            if item.file_type().is_file()
                && item.file_name().to_string_lossy().to_lowercase().ends_with(".md")
            {
                targets.push(item.path().to_path_buf());
            }
        }
    }
    let memory_index = root.join("memory").join("MEMORY.md");
    if memory_index.is_file() {
        targets.push(memory_index);
    }

    let mut violations = Vec::new();
    for path in targets {
        let rel = path
            .strip_prefix(&root)
            .map_err(|e| format!("相对化 {} 失败: {e}", path.display()))?
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        if exempt_rel.contains(&rel) {
            continue;
        }
        let raw = fs::read(&path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
        let text = String::from_utf8_lossy(&raw);
        for (index, line) in text.lines().enumerate() {
            if has_agent_path_ref(line) && !allowed_audit_line(line) {
                let trimmed = line.trim();
                let snippet: String = trimmed.chars().take(100).collect();
                violations.push(format!("{rel}:{}: {snippet}", index + 1));
            }
        }
    }
    Ok(violations)
}

fn audit_ext(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".md", ".ps1", ".py", ".yaml"].iter().any(|ext| lower.ends_with(ext))
}

fn has_agent_path_ref(line: &str) -> bool {
    [".claude/", ".claude\\", ".agents/", ".agents\\"]
        .iter()
        .any(|needle| line.contains(needle))
}

/// allowlist 四类(path-audit.ps1 同语义;"Users\<user>\.claude" 泛化用户名,不锁 admin)。
fn allowed_audit_line(line: &str) -> bool {
    // ① 产品固有:用户级 Claude 目录 / Codex home / 原生规则入口 / CLI 安装探测 / 全局 MCP 配置
    if line.contains("~/.claude")
        || line.contains(r"~\.claude")
        || line.contains(".claude.json")
        || line.contains("\".claude\", \"local\"")
        || line.contains(".claude/CLAUDE.md")
        || line.contains(r".claude\CLAUDE.md")
        || users_home_claude(line)
    {
        return true;
    }
    // ② 禁手改声明(适配器边界声明本身需要提及旧目录)
    if ["禁止手改", "禁手改", "生成薄适配器", "生成适配器"].iter().any(|k| line.contains(k)) {
        return true;
    }
    // ③ 受保护宿主配置的边界声明
    if line.contains(".claude/settings") || line.contains(r".claude\settings") {
        return true;
    }
    // ④ legacy 迁移识别语义
    if line.contains("旧默认") || line.contains("迁移前的旧") {
        return true;
    }
    false
}

/// 匹配 "Users<sep><任意单段><sep>.claude"(PS 版锁定 admin,引擎按通用产品泛化用户名)。
fn users_home_claude(line: &str) -> bool {
    let mut search_from = 0usize;
    while let Some(found) = line[search_from..].find("Users") {
        let after = search_from + found + "Users".len();
        let rest = &line[after..];
        let mut chars = rest.char_indices();
        if let Some((_, sep)) = chars.next() {
            if sep == '/' || sep == '\u{5C}' {
                if let Some(seg_end) = rest[1..].find(['/', '\u{5C}']) {
                    if seg_end > 0 && rest[1 + seg_end + 1..].starts_with(".claude") {
                        return true;
                    }
                }
            }
        }
        search_from = after;
    }
    false
}

/// ⑦ 活跃写入目标目录存在。
fn check_active_dirs(workspace: &Path) -> VerifyCheck {
    let root = manifest::env_root(workspace);
    let details = ACTIVE_DIRS
        .iter()
        .filter(|rel| !root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)).is_dir())
        .map(|rel| format!("活跃写入目标缺失: {rel}"))
        .collect();
    check("活跃写入目标目录存在", details)
}

/// ⑧ 受保护 native 文件哈希 = manifest 基线(决策 2A 铁律:只核对提醒,绝不写)。
fn check_protected(workspace: &Path, m: &WorkflowManifest) -> Result<VerifyCheck, String> {
    let mut details = Vec::new();
    for item in m.protected_native_config.as_deref().unwrap_or(&[]) {
        let path = workspace.join(&item.path);
        if !path.is_file() {
            details.push(format!("受保护文件缺失: {}", item.path));
            continue;
        }
        if manifest::sha256_file_upper(&path)? != item.sha256 {
            details.push(format!("受保护文件漂移: {}", item.path));
        }
    }
    Ok(check("受保护 native 文件: 哈希与基线一致", details))
}

/// ⑨ 记忆:canonical 与产品缓存一致(以缓存为基准,MEMORY.md 契约段除外;verify.ps1 第 9 组同向)。
fn check_memory_cache(
    workspace: &Path,
    cache_memory_dir: Option<&Path>,
) -> Result<VerifyCheck, String> {
    let name = "记忆: canonical 与产品缓存一致(契约段除外)";
    let Some(cache) = cache_memory_dir else {
        return Ok(skipped(name, "未提供 Claude 缓存目录,跳过"));
    };
    if !cache.is_dir() {
        return Ok(skipped(name, "Claude 缓存目录不存在,跳过"));
    }
    let src = manifest::env_root(workspace).join("memory");
    let mut details = Vec::new();
    for item in walkdir::WalkDir::new(cache) {
        let item = item.map_err(|e| format!("遍历 {} 失败: {e}", cache.display()))?;
        if !item.file_type().is_file() {
            continue;
        }
        let rel = item
            .path()
            .strip_prefix(cache)
            .map_err(|e| format!("相对化 {} 失败: {e}", item.path().display()))?
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        if rel == "MEMORY.md" {
            continue;
        }
        let canonical = src.join(&rel);
        if !canonical.is_file() {
            details.push(format!("缓存有而 canonical 无: {rel}"));
            continue;
        }
        let a = fs::read(item.path())
            .map_err(|e| format!("读取 {} 失败: {e}", item.path().display()))?;
        let b = fs::read(&canonical)
            .map_err(|e| format!("读取 {} 失败: {e}", canonical.display()))?;
        if a != b {
            details.push(format!("两侧内容不同: {rel}"));
        }
    }
    Ok(check(name, details))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn write(path: &PathBuf, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// 搭一个应当全绿的最小环境(含缓存目录),返回 (tmp, ws, manifest, cache)。
    fn green_env() -> (tempfile::TempDir, PathBuf, WorkflowManifest, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().to_path_buf();
        let root = ws.join(manifest::ENV_DIR);
        let skill_body = "---\nname: alpha\n---\nA\n";
        write(&root.join("skills/alpha/SKILL.md"), skill_body);
        write(&root.join("rules/common.md"), "c");
        write(&root.join("rules/claude.md"), "c");
        write(&root.join("rules/codex.md"), "c");
        fs::create_dir_all(root.join("adapters/claude")).unwrap();
        fs::create_dir_all(root.join("adapters/codex")).unwrap();
        for dir in ACTIVE_DIRS {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        write(&root.join("memory/MEMORY.md"), "# 契约\n# 索引\n");
        write(&root.join("memory/index_0/x.md"), "same");
        write(&ws.join("native.md"), "protected");
        let sha = manifest::sha256_hex_upper(skill_body.as_bytes());
        let native_sha = manifest::sha256_file_upper(&ws.join("native.md")).unwrap();
        let manifest_text = format!(
            r#"{{
  "schemaVersion": 1,
  "providers": {{
    "claude": {{ "adapterDir": ".claude/skills" }},
    "codex": {{ "adapterDir": ".agents/skills" }}
  }},
  "protectedNativeConfig": [ {{ "path": "native.md", "sha256": "{native_sha}" }} ],
  "skills": [ {{ "id": "alpha", "entrySha256": "{sha}", "fileCount": 1 }} ]
}}"#
        );
        write(&root.join(manifest::MANIFEST_FILE), &manifest_text);
        let m = manifest::load(&ws).unwrap();
        super::super::adapters::sync_adapters(&ws, &m).unwrap();
        let cache = ws.join("cache-memory");
        write(&cache.join("MEMORY.md"), "# 索引\n");
        write(&cache.join("index_0/x.md"), "same");
        (tmp, ws, m, cache)
    }

    #[test]
    fn green_env_all_passed_and_registry_skipped() {
        let (_tmp, ws, m, cache) = green_env();
        let report = verify(&ws, &m, Some(&cache)).unwrap();
        let failed: Vec<_> = report.checks.iter().filter(|c| !c.passed).collect();
        assert!(report.all_passed, "应全绿,失败项: {failed:?}");
        let registry = report.checks.iter().find(|c| c.name.starts_with("registry")).unwrap();
        assert!(registry.skipped, "registry 缺文件应为条件跳过");
    }

    #[test]
    fn breakages_fail_matching_groups() {
        let (_tmp, ws, m, cache) = green_env();
        let root = ws.join(manifest::ENV_DIR);
        fs::create_dir_all(root.join("skills/ghostdir")).unwrap(); // UNREGISTERED + canonical 缺入口
        write(&ws.join("native.md"), "tampered"); // 受保护漂移
        fs::remove_dir_all(root.join("docking")).unwrap(); // 活跃目录缺失
        fs::create_dir_all(ws.join(".agents/skills/orphan")).unwrap(); // 孤儿薄壳
        write(&cache.join("index_0/extra.md"), "x"); // 缓存有而 canonical 无
        let report = verify(&ws, &m, Some(&cache)).unwrap();
        assert!(!report.all_passed);
        let failed: Vec<&str> = report
            .checks
            .iter()
            .filter(|c| !c.passed)
            .map(|c| c.name.as_str())
            .collect();
        assert!(failed.contains(&"数量与 ID 集合: canonical == manifest"), "{failed:?}");
        assert!(failed.contains(&"适配器: 与 canonical 契约一致"), "{failed:?}");
        assert!(failed.contains(&"孤儿薄壳(缺真版)【引擎新增】"), "{failed:?}");
        assert!(failed.contains(&"活跃写入目标目录存在"), "{failed:?}");
        assert!(failed.contains(&"受保护 native 文件: 哈希与基线一致"), "{failed:?}");
        assert!(failed.contains(&"记忆: canonical 与产品缓存一致(契约段除外)"), "{failed:?}");
    }

    #[test]
    fn path_audit_allowlist_and_exemptions() {
        let (_tmp, ws, _m, _cache) = green_env();
        let root = ws.join(manifest::ENV_DIR);
        let offender = root.join("skills/alpha/references/notes.md");
        write(
            &offender,
            "写入 .claude/plans/ 是违规\n~/.claude/skills 是产品固有\nUsers/foo/.claude/projects 泛化允许\n本目录为生成薄适配器说明 .agents/skills\n读 .claude/settings.json 的边界声明\n旧默认路径 .claude/svg 兼容\n",
        );
        let none = BTreeSet::new();
        let violations = path_audit(&ws, &none).unwrap();
        assert_eq!(violations.len(), 1, "{violations:?}");
        assert!(violations[0].starts_with("skills/alpha/references/notes.md:1:"));
        // 豁免配置点
        write(&root.join(AUDIT_SKIP_FILE), r#"["skills/alpha/references/notes.md"]"#);
        let exempt = load_audit_exemptions(&ws).unwrap();
        assert!(path_audit(&ws, &exempt).unwrap().is_empty());
    }

    #[test]
    fn registry_conditional_check() {
        let (_tmp, ws, m, cache) = green_env();
        write(
            &ws.join(REGISTRY_FILE),
            r#"{ "skills": [ { "id": "alpha", "localPath": "wrong/place" } ] }"#,
        );
        let report = verify(&ws, &m, Some(&cache)).unwrap();
        let registry = report.checks.iter().find(|c| c.name.starts_with("registry")).unwrap();
        assert!(!registry.passed && !registry.skipped);
        write(
            &ws.join(REGISTRY_FILE),
            r#"{ "skills": [ { "id": "alpha", "localPath": ".htyworkflows/skills/alpha" } ] }"#,
        );
        let ok = verify(&ws, &m, Some(&cache)).unwrap();
        assert!(ok.checks.iter().find(|c| c.name.starts_with("registry")).unwrap().passed);
    }
}
