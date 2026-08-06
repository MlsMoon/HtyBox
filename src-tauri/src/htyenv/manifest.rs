// htyenv/manifest.rs —— workflow-manifest.json 模型与读写(schemaVersion 1)。
// 宽容解析:未知字段经 #[serde(flatten)] 透传,写回不丢(plan-5 的 enabled 等演进字段依赖此保障);
// 序列化字段序 = 结构体声明序 = schemaVersion 1 实际文件序,未知字段落在各层末尾。
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

pub const ENV_DIR: &str = ".htyworkflows";
pub const SKILLS_DIR: &str = "skills";
pub const SKILL_ENTRY: &str = "SKILL.md";
pub const MANIFEST_FILE: &str = "workflow-manifest.json";
pub const SUPPORTED_SCHEMA_VERSION: u64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowManifest {
    pub schema_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generator_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_utc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical: Option<Value>,
    pub providers: BTreeMap<String, ProviderConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protected_native_config: Option<Vec<ProtectedFile>>,
    /// 受管官方模板文件的「已安装基线 sha」(环境补全更新检测据此判 cleanOutdated vs diverged)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed_template_files: Option<Vec<ManagedFile>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renames: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zero_loss_constraints: Option<Value>,
    pub skills: Vec<SkillEntry>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub adapter_dir: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtectedFile {
    pub path: String,
    pub sha256: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// 受管官方模板文件的「已安装基线 sha」记录(env 根相对路径;大写十六进制 SHA-256)。
/// 与 ProtectedFile 同构:环境补全更新检测据此区分"过时可安全更新"与"用户本地改动(diverged)"。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedFile {
    pub path: String,
    pub sha256: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    pub entry_sha256: String,
    pub file_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// 上下架元数据(plan-5 决策 1A=G3):缺省/true=启用;false=下架(各端薄壳删除,canonical 不动)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// 最后一次与全局权威库同步的基线 sha(库侧 SKILL.md 大写 SHA-256;缺失=untracked,plan-3 决策 1A)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library_sha: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl WorkflowManifest {
    /// 启用态判定:未登记(UNREGISTERED)与缺省字段都视为启用(宽容旧文件)。
    pub fn skill_enabled(&self, id: &str) -> bool {
        self.skills
            .iter()
            .find(|s| s.id == id)
            .and_then(|s| s.enabled)
            .unwrap_or(true)
    }

    /// 受管官方文件的已安装基线 sha(缺失=未追踪基线)。
    pub fn managed_baseline(&self, path: &str) -> Option<&str> {
        self.managed_template_files
            .as_ref()?
            .iter()
            .find(|m| m.path == path)
            .map(|m| m.sha256.as_str())
    }

    /// 写入/更新受管官方文件基线 sha(存在则改，不存在则追加)。
    pub fn upsert_managed_baseline(&mut self, path: &str, sha: &str) {
        let list = self.managed_template_files.get_or_insert_with(Vec::new);
        if let Some(e) = list.iter_mut().find(|m| m.path == path) {
            e.sha256 = sha.to_string();
        } else {
            list.push(ManagedFile {
                path: path.to_string(),
                sha256: sha.to_string(),
                extra: Map::new(),
            });
        }
    }
}

pub fn env_root(workspace: &Path) -> PathBuf {
    workspace.join(ENV_DIR)
}

pub fn manifest_path(workspace: &Path) -> PathBuf {
    env_root(workspace).join(MANIFEST_FILE)
}

/// skill id 来自工作区 manifest/目录名,参与路径拼接前必须过此校验,拒绝任何可越界成分。
pub fn validate_skill_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id == "." || id == ".." {
        return Err(format!("非法 skill id: {id:?}"));
    }
    if id.chars().any(|c| matches!(c, '/' | '\\' | ':')) || id.contains("..") {
        return Err(format!("skill id 含路径成分: {id:?}"));
    }
    Ok(())
}

pub fn skill_dir(workspace: &Path, id: &str) -> Result<PathBuf, String> {
    validate_skill_id(id)?;
    Ok(env_root(workspace).join(SKILLS_DIR).join(id))
}

pub fn parse(text: &str) -> Result<WorkflowManifest, String> {
    // PS 5.1 `Set-Content -Encoding utf8` 会写 UTF-8 BOM;serde_json 不认,先剥再解析。
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let manifest: WorkflowManifest =
        serde_json::from_str(text).map_err(|e| format!("workflow-manifest.json 解析失败: {e}"))?;
    if manifest.schema_version != SUPPORTED_SCHEMA_VERSION {
        return Err(format!(
            "不支持的 schemaVersion {}(引擎当前支持 {})",
            manifest.schema_version, SUPPORTED_SCHEMA_VERSION
        ));
    }
    Ok(manifest)
}

pub fn serialize(manifest: &WorkflowManifest) -> Result<String, String> {
    let mut text =
        serde_json::to_string_pretty(manifest).map_err(|e| format!("manifest 序列化失败: {e}"))?;
    text.push('\n');
    Ok(text)
}

pub fn load(workspace: &Path) -> Result<WorkflowManifest, String> {
    let path = manifest_path(workspace);
    let text =
        fs::read_to_string(&path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    parse(&text)
}

/// 原子落盘:同目录临时文件写全 + sync 后 persist 替换,不留半成品。
pub fn save(workspace: &Path, manifest: &WorkflowManifest) -> Result<(), String> {
    let path = manifest_path(workspace);
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} 无父目录", path.display()))?;
    let text = serialize(manifest)?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".htybox-manifest-")
        .tempfile_in(dir)
        .map_err(|e| format!("创建 manifest 临时文件失败: {e}"))?;
    tmp.write_all(text.as_bytes())
        .map_err(|e| format!("写 manifest 临时文件失败: {e}"))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("manifest 临时文件落盘失败: {e}"))?;
    tmp.persist(&path)
        .map_err(|e| format!("写入 {} 失败: {}", path.display(), e.error))?;
    Ok(())
}

/// 登记跟随刷新(sync-all ② 同语义):canonical SKILL.md 合法更新 → 刷新 entrySha256/fileCount,
/// 任一变化则刷新 generatedUtc;canonical 缺失的登记项跳过(GHOST 属对账报告,不在此处置)。
/// 返回被刷新的 skill id 列表。
pub fn refresh_from_canonical(
    workspace: &Path,
    manifest: &mut WorkflowManifest,
) -> Result<Vec<String>, String> {
    let mut refreshed = Vec::new();
    for entry in &mut manifest.skills {
        let dir = skill_dir(workspace, &entry.id)?;
        let entry_path = dir.join(SKILL_ENTRY);
        if !entry_path.is_file() {
            continue;
        }
        let hash = sha256_file_upper(&entry_path)?;
        if hash != entry.entry_sha256 {
            entry.entry_sha256 = hash;
            entry.file_count = count_files(&dir)?;
            refreshed.push(entry.id.clone());
        }
    }
    if !refreshed.is_empty() {
        manifest.generated_utc = Some(now_utc_rfc3339()?);
    }
    Ok(refreshed)
}

/// SKILL.md frontmatter 内 `name:`/`description:` 行值(展示用途,宽松解析;头部 4KB 内)。
pub(crate) fn skill_frontmatter_meta(entry_file: &Path) -> (Option<String>, Option<String>) {
    let Ok(bytes) = fs::read(entry_file) else {
        return (None, None);
    };
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
    let mut in_frontmatter = false;
    let (mut name, mut description) = (None, None);
    for line in head.lines() {
        let line = line.trim_start_matches('\u{feff}').trim_end();
        if line.trim() == "---" {
            if in_frontmatter {
                break;
            }
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            for (key, slot) in [("name:", &mut name), ("description:", &mut description)] {
                if slot.is_none() {
                    if let Some(rest) = line.strip_prefix(key) {
                        let value = rest.trim().trim_matches(['"', '\'']).to_string();
                        if !value.is_empty() {
                            *slot = Some(value);
                        }
                    }
                }
            }
        }
    }
    (name, description)
}

/// frontmatter description 便捷取值。
pub(crate) fn skill_description(entry_file: &Path) -> Option<String> {
    skill_frontmatter_meta(entry_file).1
}

pub(crate) fn now_utc_rfc3339() -> Result<String, String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|e| format!("UTC 时间格式化失败: {e}"))
}

pub(crate) fn sha256_file_upper(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    Ok(sha256_hex_upper(&bytes))
}

/// 与 manifest entrySha256 / 薄壳契约 v1 一致的大写十六进制 SHA-256。
pub(crate) fn sha256_hex_upper(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02X}"));
    }
    out
}

/// 递归文件计数(含隐藏文件,不跟符号链接),与 PS `Get-ChildItem -Recurse -File -Force` 口径一致。
pub(crate) fn count_files(dir: &Path) -> Result<u64, String> {
    let mut count = 0u64;
    for item in walkdir::WalkDir::new(dir) {
        let item = item.map_err(|e| format!("遍历 {} 失败: {e}", dir.display()))?;
        if item.file_type().is_file() {
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
  "schemaVersion": 1,
  "generatorVersion": "1.0.0",
  "generatedUtc": "2026-07-11T17:23:46.6193824Z",
  "canonical": { "root": ".htyworkflows", "skillsDir": "skills", "skillEntry": "SKILL.md", "encoding": "utf-8" },
  "providers": {
    "claude": { "adapterDir": ".claude/skills", "overlayDir": "adapters/claude", "nativeRulesEntry": ".claude/CLAUDE.md", "nativeRulesPolicy": "protected-native-config" },
    "codex": { "adapterDir": ".agents/skills", "overlayDir": "adapters/codex", "nativeRulesEntry": "AGENTS.md", "nativeRulesPolicy": "protected-native-config" }
  },
  "protectedNativeConfig": [ { "path": ".claude/CLAUDE.md", "sha256": "AB", "policy": "read-only-reference" } ],
  "renames": [ { "from": "skill-creator", "to": "skill-creator-hty" } ],
  "zeroLossConstraints": ["x"],
  "futureTopLevel": { "k": 1 },
  "skills": [
    { "id": "alpha", "sourceId": "alpha", "entrySha256": "00", "fileCount": 2, "status": "merged", "librarySha": "FFEE" }
  ]
}"#;

    #[test]
    fn round_trip_preserves_all_fields() {
        let manifest = parse(SAMPLE).unwrap();
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.providers.len(), 2);
        assert_eq!(manifest.providers["claude"].adapter_dir, ".claude/skills");
        assert_eq!(manifest.skills.len(), 1);
        assert_eq!(manifest.skills[0].library_sha.as_deref(), Some("FFEE"));
        assert_eq!(manifest.extra["futureTopLevel"]["k"], 1);
        let out = serialize(&manifest).unwrap();
        let original: Value = serde_json::from_str(SAMPLE).unwrap();
        let rewritten: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(original, rewritten, "round-trip 后语义不等价/字段丢失");
    }

    #[test]
    fn unsupported_schema_version_rejected() {
        let text = SAMPLE.replace("\"schemaVersion\": 1", "\"schemaVersion\": 2");
        let err = parse(&text).unwrap_err();
        assert!(err.contains("schemaVersion"), "错误应指明 schemaVersion: {err}");
    }

    #[test]
    fn parse_tolerates_utf8_bom() {
        let text = format!("\u{feff}{SAMPLE}");
        let manifest = parse(&text).expect("带 BOM 的 manifest 应可解析");
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.skills.len(), 1);
    }

    #[test]
    fn refresh_updates_changed_skips_missing_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        let dir = ws.join(ENV_DIR).join(SKILLS_DIR).join("alpha");
        fs::create_dir_all(dir.join("references")).unwrap();
        fs::write(dir.join(SKILL_ENTRY), b"---\nname: alpha\n---\nbody\n").unwrap();
        fs::write(dir.join("references").join("r.md"), b"ref").unwrap();
        let mut manifest = parse(SAMPLE).unwrap();
        manifest.skills.push(SkillEntry {
            id: "ghost".into(),
            source_id: None,
            entry_sha256: "11".into(),
            file_count: 1,
            status: None,
            enabled: None,
            library_sha: None,
            extra: Map::new(),
        });
        let refreshed = refresh_from_canonical(ws, &mut manifest).unwrap();
        assert_eq!(refreshed, vec!["alpha".to_string()]);
        let expect = sha256_file_upper(&dir.join(SKILL_ENTRY)).unwrap();
        assert_eq!(manifest.skills[0].entry_sha256, expect);
        assert_eq!(manifest.skills[0].file_count, 2);
        assert!(manifest.generated_utc.as_deref().unwrap().ends_with('Z'));
        assert_eq!(manifest.skills[0].library_sha.as_deref(), Some("FFEE"), "刷新不得丢谱系基线");
        assert_eq!(manifest.skills[1].entry_sha256, "11", "canonical 缺失的登记项不得改动");
        assert!(refresh_from_canonical(ws, &mut manifest).unwrap().is_empty(), "二跑应零刷新");
    }

    #[test]
    fn save_then_load_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        fs::create_dir_all(env_root(ws)).unwrap();
        let manifest = parse(SAMPLE).unwrap();
        save(ws, &manifest).unwrap();
        let loaded = load(ws).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&serialize(&manifest).unwrap()).unwrap(),
            serde_json::from_str::<Value>(&serialize(&loaded).unwrap()).unwrap()
        );
    }

    #[test]
    fn skill_id_traversal_rejected() {
        assert!(validate_skill_id("../x").is_err());
        assert!(validate_skill_id("a/b").is_err());
        assert!(validate_skill_id(r"a\b").is_err());
        assert!(validate_skill_id("c:evil").is_err());
        assert!(validate_skill_id("").is_err());
        assert!(validate_skill_id(".").is_err());
        assert!(validate_skill_id("plan-create").is_ok());
    }

    #[test]
    fn sha256_hex_upper_known_vector() {
        assert_eq!(
            sha256_hex_upper(b"abc"),
            "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"
        );
    }

    #[test]
    fn managed_baseline_upsert_lookup_and_round_trip() {
        let mut m = parse(SAMPLE).unwrap();
        assert!(m.managed_baseline("tools/verify.ps1").is_none(), "初始无基线");
        m.upsert_managed_baseline("tools/verify.ps1", "AA");
        assert_eq!(m.managed_baseline("tools/verify.ps1"), Some("AA"));
        m.upsert_managed_baseline("tools/verify.ps1", "BB"); // upsert 改现值
        assert_eq!(m.managed_baseline("tools/verify.ps1"), Some("BB"));
        assert_eq!(m.managed_template_files.as_ref().unwrap().len(), 1, "同路径不重复");
        let out = serialize(&m).unwrap();
        assert!(out.contains("managedTemplateFiles"), "序列化应含 camelCase 字段");
        assert_eq!(parse(&out).unwrap().managed_baseline("tools/verify.ps1"), Some("BB"));
    }

    #[test]
    fn absent_managed_field_stays_none_and_not_serialized() {
        let m = parse(SAMPLE).unwrap(); // SAMPLE 无 managedTemplateFiles
        assert!(m.managed_template_files.is_none());
        assert!(!serialize(&m).unwrap().contains("managedTemplateFiles"), "空字段不落盘");
    }
}
