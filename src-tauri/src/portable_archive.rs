//! Versioned HtyBox portable packages and their shared safety boundary.
//! Business modules decide which payload files belong in a Session/Memory package;
//! this module only writes, validates, and extracts a closed manifest of regular entries.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tempfile::Builder;
use zip::read::{ArchiveOffset, Config as ZipReadConfig};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, HasZipMetadata, ZipArchive, ZipWriter};

pub const SESSION_FORMAT: &str = "htybox.session";
pub const MEMORY_FORMAT: &str = "htybox.memory";
pub const ACCOUNTS_FORMAT: &str = "htybox.accounts";
pub const PACKAGE_VERSION: u32 = 1;
pub const SESSION_EXTENSION: &str = "htybox-session";
pub const MEMORY_EXTENSION: &str = "htybox-memory";
pub const ACCOUNTS_EXTENSION: &str = "htybox-accounts";
const MANIFEST_NAME: &str = "manifest.json";
const MAX_MANIFEST_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PackageKind {
    Session,
    Memory,
    Accounts,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveAgent {
    Claude,
    Codex,
    Cursor,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ArchiveCapability {
    FullTree,
    Transcript,
    History,
    Subagents,
    ToolResults,
    Tasks,
    Rollout,
    NativeTitle,
    Metadata,
    PromptHistory,
    StoreDb,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestEntry {
    pub path: String,
    pub kind: ArchiveEntryKind,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionManifest {
    pub version: u32,
    pub kind: PackageKind,
    pub agent: ArchiveAgent,
    pub session_id: String,
    pub source_cwd: String,
    pub source_agent_version: String,
    pub source_schema_version: String,
    pub exported_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_relative_path: Option<String>,
    pub capabilities: Vec<ArchiveCapability>,
    pub entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryManifest {
    pub version: u32,
    pub kind: PackageKind,
    pub agent: ArchiveAgent,
    pub source_workspace: String,
    pub source_slug: String,
    pub source_agent_version: String,
    pub source_schema_version: String,
    pub exported_at_ms: i64,
    pub capabilities: Vec<ArchiveCapability>,
    pub entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountsManifest {
    pub version: u32,
    pub kind: PackageKind,
    pub exported_at_ms: i64,
    pub preset_count: usize,
    pub entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "format")]
pub enum PortableManifest {
    #[serde(rename = "htybox.session")]
    Session(SessionManifest),
    #[serde(rename = "htybox.memory")]
    Memory(MemoryManifest),
    #[serde(rename = "htybox.accounts")]
    Accounts(AccountsManifest),
}

impl PortableManifest {
    pub fn format(&self) -> &'static str {
        match self {
            Self::Session(_) => SESSION_FORMAT,
            Self::Memory(_) => MEMORY_FORMAT,
            Self::Accounts(_) => ACCOUNTS_FORMAT,
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            Self::Session(_) => SESSION_EXTENSION,
            Self::Memory(_) => MEMORY_EXTENSION,
            Self::Accounts(_) => ACCOUNTS_EXTENSION,
        }
    }

    pub fn entries(&self) -> &[ManifestEntry] {
        match self {
            Self::Session(value) => &value.entries,
            Self::Memory(value) => &value.entries,
            Self::Accounts(value) => &value.entries,
        }
    }

    fn entries_mut(&mut self) -> &mut Vec<ManifestEntry> {
        match self {
            Self::Session(value) => &mut value.entries,
            Self::Memory(value) => &mut value.entries,
            Self::Accounts(value) => &mut value.entries,
        }
    }

    pub fn validate_contract(&self, expected_format: Option<&str>) -> Result<(), String> {
        if expected_format.is_some_and(|expected| expected != self.format()) {
            return Err(format!("包类型不匹配：{}", self.format()));
        }
        match self {
            Self::Session(value) => validate_session_manifest(value),
            Self::Memory(value) => validate_memory_manifest(value),
            Self::Accounts(value) => validate_accounts_manifest(value),
        }
    }
}

fn validate_text(value: &str, field: &str, max_len: usize) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max_len
        || value
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return Err(format!("manifest 字段 {field} 为空、过长或含控制字符"));
    }
    Ok(())
}

fn validate_versioned_fields(
    version: u32,
    exported_at_ms: i64,
    source_agent_version: &str,
    source_schema_version: &str,
) -> Result<(), String> {
    if version != PACKAGE_VERSION {
        return Err(format!("不支持的包版本：{version}"));
    }
    if exported_at_ms < 0 {
        return Err("manifest exportedAtMs 不能为负数".into());
    }
    validate_text(source_agent_version, "sourceAgentVersion", 128)?;
    validate_text(source_schema_version, "sourceSchemaVersion", 128)
}

fn validate_capabilities(
    capabilities: &[ArchiveCapability],
    allowed: &[ArchiveCapability],
    required: &[ArchiveCapability],
) -> Result<(), String> {
    let mut unique = HashSet::new();
    for capability in capabilities {
        if !unique.insert(*capability) {
            return Err("manifest capabilities 含重复值".into());
        }
        if !allowed.contains(capability) {
            return Err(format!("manifest capability 不适用于此包：{capability:?}"));
        }
    }
    if required.iter().any(|value| !unique.contains(value)) {
        return Err("manifest 缺少必需 capability".into());
    }
    Ok(())
}

fn validate_session_manifest(value: &SessionManifest) -> Result<(), String> {
    if value.kind != PackageKind::Session {
        return Err("Session 包的 kind 必须为 session".into());
    }
    validate_versioned_fields(
        value.version,
        value.exported_at_ms,
        &value.source_agent_version,
        &value.source_schema_version,
    )?;
    validate_text(&value.session_id, "sessionId", 256)?;
    if !value
        .session_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("manifest sessionId 含不安全字符".into());
    }
    validate_text(&value.source_cwd, "sourceCwd", 32 * 1024)?;
    if let Some(label) = &value.label {
        validate_text(label, "label", 512)?;
    }
    if let Some(native_path) = &value.native_relative_path {
        if validate_archive_path(native_path, false)? != *native_path {
            return Err("manifest nativeRelativePath 未规范化".into());
        }
    }

    let (allowed, required): (&[_], &[_]) = match value.agent {
        ArchiveAgent::Claude => (
            &[
                ArchiveCapability::Transcript,
                ArchiveCapability::History,
                ArchiveCapability::Subagents,
                ArchiveCapability::ToolResults,
                ArchiveCapability::Tasks,
            ],
            &[ArchiveCapability::Transcript, ArchiveCapability::History],
        ),
        ArchiveAgent::Codex => (
            &[ArchiveCapability::Rollout, ArchiveCapability::NativeTitle],
            &[ArchiveCapability::Rollout],
        ),
        ArchiveAgent::Cursor => (
            &[
                ArchiveCapability::Metadata,
                ArchiveCapability::PromptHistory,
                ArchiveCapability::StoreDb,
            ],
            &[ArchiveCapability::Metadata, ArchiveCapability::StoreDb],
        ),
    };
    validate_capabilities(&value.capabilities, allowed, required)?;
    validate_manifest_entries(&value.entries)
}

fn validate_memory_manifest(value: &MemoryManifest) -> Result<(), String> {
    if value.kind != PackageKind::Memory || value.agent != ArchiveAgent::Claude {
        return Err("Memory 包必须声明 kind=memory 且 agent=claude".into());
    }
    validate_versioned_fields(
        value.version,
        value.exported_at_ms,
        &value.source_agent_version,
        &value.source_schema_version,
    )?;
    validate_text(&value.source_workspace, "sourceWorkspace", 32 * 1024)?;
    validate_text(&value.source_slug, "sourceSlug", 4096)?;
    validate_capabilities(
        &value.capabilities,
        &[ArchiveCapability::FullTree],
        &[ArchiveCapability::FullTree],
    )?;
    validate_manifest_entries(&value.entries)
}

fn validate_accounts_manifest(value: &AccountsManifest) -> Result<(), String> {
    if value.kind != PackageKind::Accounts {
        return Err("Accounts 包必须声明 kind=accounts".into());
    }
    if value.version != PACKAGE_VERSION {
        return Err(format!("不支持的包版本：{}", value.version));
    }
    if value.exported_at_ms < 0 {
        return Err("manifest exportedAtMs 不能为负数".into());
    }
    validate_manifest_entries(&value.entries)
}

#[derive(Debug, Clone, Copy)]
pub struct ArchiveLimits {
    pub max_entries: usize,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_compression_ratio: u64,
}

impl ArchiveLimits {
    pub const fn session() -> Self {
        Self {
            max_entries: 10_000,
            max_file_bytes: 2 * 1024 * 1024 * 1024,
            max_total_bytes: 3 * 1024 * 1024 * 1024,
            max_compression_ratio: 1_000,
        }
    }

    pub const fn memory() -> Self {
        Self {
            max_entries: 20_000,
            max_file_bytes: 64 * 1024 * 1024,
            max_total_bytes: 512 * 1024 * 1024,
            max_compression_ratio: 1_000,
        }
    }
    /// 账号预设包：单个 JSON，条目极少、体积小。
    pub const fn accounts() -> Self {
        Self {
            max_entries: 16,
            max_file_bytes: 4 * 1024 * 1024,
            max_total_bytes: 8 * 1024 * 1024,
            max_compression_ratio: 1_000,
        }
    }
}

#[derive(Debug)]
pub enum PackageSource {
    Directory {
        archive_path: String,
    },
    Bytes {
        archive_path: String,
        data: Vec<u8>,
    },
    File {
        archive_path: String,
        source_path: PathBuf,
    },
}

impl PackageSource {
    fn archive_path(&self) -> &str {
        match self {
            Self::Directory { archive_path }
            | Self::Bytes { archive_path, .. }
            | Self::File { archive_path, .. } => archive_path,
        }
    }
}

#[derive(Debug)]
pub struct PackageWriteResult {
    pub path: PathBuf,
    pub bytes: u64,
    pub manifest: PortableManifest,
}

fn is_windows_reserved(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || matches!(
            stem.as_str(),
            "COM¹" | "COM²" | "COM³" | "LPT¹" | "LPT²" | "LPT³"
        )
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
}

pub fn validate_archive_path(raw: &str, is_directory: bool) -> Result<String, String> {
    if raw.is_empty() || raw.len() > 4096 || raw.contains('\0') {
        return Err("归档路径为空、过长或含 NUL".into());
    }
    if raw.contains('\\') || raw.starts_with('/') || raw.starts_with("//") {
        return Err(format!("归档路径不是安全的相对 POSIX 路径：{raw}"));
    }
    let trimmed = raw.strip_suffix('/').unwrap_or(raw);
    if trimmed.is_empty() || (!is_directory && raw.ends_with('/')) {
        return Err(format!("归档文件路径非法：{raw}"));
    }
    let segments: Vec<&str> = trimmed.split('/').collect();
    if segments.len() > 64 {
        return Err(format!("归档路径层级超过 64：{raw}"));
    }
    for segment in &segments {
        if segment.is_empty()
            || *segment == "."
            || *segment == ".."
            || segment.encode_utf16().count() > 255
        {
            return Err(format!("归档路径含空段或跳转段：{raw}"));
        }
        if segment.ends_with('.')
            || segment.ends_with(' ')
            || segment.contains(':')
            || segment
                .chars()
                .any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
            || is_windows_reserved(segment)
        {
            return Err(format!("归档路径含 Windows 非法段：{segment}"));
        }
    }
    Ok(segments.join("/"))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn validate_manifest_entries(entries: &[ManifestEntry]) -> Result<(), String> {
    struct PathNode {
        original_segment: String,
        kind: ArchiveEntryKind,
        explicit: bool,
    }
    let mut nodes = vec![PathNode {
        original_segment: String::new(),
        kind: ArchiveEntryKind::Directory,
        explicit: false,
    }];
    let mut children: HashMap<(usize, String), usize> = HashMap::new();
    for entry in entries {
        let canonical =
            validate_archive_path(&entry.path, entry.kind == ArchiveEntryKind::Directory)?;
        if canonical != entry.path || !canonical.starts_with("payload/") {
            return Err(format!(
                "manifest entry 不在 payload/ 下或未规范化：{}",
                entry.path
            ));
        }
        match entry.kind {
            ArchiveEntryKind::Directory => {
                if entry.size != 0 || entry.sha256.is_some() {
                    return Err(format!("目录 entry 不能带 size/hash：{}", entry.path));
                }
            }
            ArchiveEntryKind::File => {
                if !entry.sha256.as_deref().is_some_and(valid_sha256) {
                    return Err(format!("文件 entry 缺少规范 SHA-256：{}", entry.path));
                }
            }
        }
        let segments: Vec<_> = canonical.split('/').collect();
        let mut parent = 0usize;
        for (index, segment) in segments.iter().enumerate() {
            let is_leaf = index + 1 == segments.len();
            let node_kind = if is_leaf {
                entry.kind
            } else {
                ArchiveEntryKind::Directory
            };
            let key = (parent, segment.to_lowercase());
            if let Some(existing) = children.get(&key).copied() {
                let node = &mut nodes[existing];
                if node.original_segment != *segment {
                    return Err(format!("manifest 含大小写冲突路径：{}", entry.path));
                }
                if node.kind != node_kind {
                    return Err(format!("manifest 文件与目录前缀冲突：{}", entry.path));
                }
                if is_leaf && node.explicit {
                    return Err(format!("manifest 含重复路径：{}", entry.path));
                }
                node.explicit |= is_leaf;
                parent = existing;
            } else {
                let node_index = nodes.len();
                nodes.push(PathNode {
                    original_segment: (*segment).to_string(),
                    kind: node_kind,
                    explicit: is_leaf,
                });
                children.insert(key, node_index);
                parent = node_index;
            }
        }
    }
    Ok(())
}

pub fn ensure_extension(path: &Path, extension: &str) -> PathBuf {
    let suffix = format!(".{extension}");
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.to_lowercase().ends_with(&suffix))
    {
        return path.to_path_buf();
    }
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

pub fn reject_link_or_reparse(path: &Path) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("读取路径元数据失败 {}：{e}", path.display()))?;
    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(format!("拒绝链接或 reparse point：{}", path.display()));
    }
    Ok(metadata)
}

fn ensure_safe_directory(root: &Path, directory: &Path) -> Result<(), String> {
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| format!("目录逃逸 staging：{}", directory.display()))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(segment) = component else {
            return Err("staging 子目录含非普通路径组件".into());
        };
        current.push(segment);
        match std::fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "创建 staging 子目录失败 {}：{error}",
                    current.display()
                ))
            }
        }
        let metadata = reject_link_or_reparse(&current)?;
        if !metadata.is_dir() {
            return Err(format!("staging 路径不是目录：{}", current.display()));
        }
        let resolved = current.canonicalize().map_err(|e| e.to_string())?;
        if !resolved.starts_with(root) {
            return Err(format!("staging 子目录解析后逃逸：{}", current.display()));
        }
    }
    Ok(())
}

fn cleanup_staging(path: &Path) {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        let _ = std::fs::remove_dir(path).or_else(|_| std::fs::remove_file(path));
    } else if metadata.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn copy_with_hash<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    max_bytes: u64,
) -> Result<(u64, String), String> {
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let remaining = max_bytes.saturating_sub(total);
        let read_limit = remaining.saturating_add(1).min(buffer.len() as u64) as usize;
        let read = reader
            .read(&mut buffer[..read_limit])
            .map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "文件大小溢出".to_string())?;
        if total > max_bytes {
            return Err(format!("文件超过允许上限：{max_bytes} bytes"));
        }
        hasher.update(&buffer[..read]);
        writer
            .write_all(&buffer[..read])
            .map_err(|e| e.to_string())?;
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn checked_total(total: &mut u64, add: u64, limits: ArchiveLimits) -> Result<(), String> {
    *total = total
        .checked_add(add)
        .ok_or_else(|| "归档总大小溢出".to_string())?;
    if *total > limits.max_total_bytes {
        return Err(format!(
            "归档解压总量超过上限：{} bytes",
            limits.max_total_bytes
        ));
    }
    Ok(())
}

pub fn write_package(
    destination: &Path,
    extension: &str,
    mut manifest: PortableManifest,
    sources: Vec<PackageSource>,
    limits: ArchiveLimits,
) -> Result<PackageWriteResult, String> {
    if extension != manifest.extension() {
        return Err(format!(
            "导出扩展名与包类型不匹配：应为 .{}",
            manifest.extension()
        ));
    }
    if !manifest.entries().is_empty() {
        return Err("写包前 manifest.entries 必须为空".into());
    }
    if sources.len() > limits.max_entries {
        return Err(format!("归档 entry 数超过上限：{}", limits.max_entries));
    }
    let requested = ensure_extension(destination, extension);
    let parent = requested
        .parent()
        .ok_or_else(|| "导出目标没有父目录".to_string())?;
    let parent = parent
        .canonicalize()
        .map_err(|e| format!("导出父目录无效 {}：{e}", parent.display()))?;
    let file_name = requested
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "导出目标缺少文件名".to_string())?;
    let file_name_text = file_name
        .to_str()
        .ok_or_else(|| "导出目标文件名不是 UTF-8".to_string())?;
    validate_archive_path(file_name_text, false)
        .map_err(|error| format!("导出目标文件名非法：{error}"))?;
    let final_path = parent.join(file_name);
    if final_path.exists() {
        let metadata = reject_link_or_reparse(&final_path)?;
        if !metadata.is_file() {
            return Err("导出目标不是普通文件".into());
        }
    }

    let mut temp = Builder::new()
        .prefix(".htybox-export-")
        .tempfile_in(&parent)
        .map_err(|e| format!("创建导出临时文件失败：{e}"))?;
    let mut entries = Vec::with_capacity(sources.len());
    let mut total = 0u64;
    {
        let mut zip = ZipWriter::new(temp.as_file_mut());
        let file_compression = if matches!(&manifest, PortableManifest::Memory(_)) {
            CompressionMethod::Stored
        } else {
            CompressionMethod::Deflated
        };
        let file_options = SimpleFileOptions::default()
            .compression_method(file_compression)
            .unix_permissions(0o600);
        let dir_options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(0o700);
        for source in sources {
            let is_dir = matches!(source, PackageSource::Directory { .. });
            let archive_path = validate_archive_path(source.archive_path(), is_dir)?;
            match source {
                PackageSource::Directory { .. } => {
                    zip.add_directory(format!("{archive_path}/"), dir_options)
                        .map_err(|e| e.to_string())?;
                    entries.push(ManifestEntry {
                        path: archive_path,
                        kind: ArchiveEntryKind::Directory,
                        size: 0,
                        sha256: None,
                    });
                }
                PackageSource::Bytes { data, .. } => {
                    let size = data.len() as u64;
                    if size > limits.max_file_bytes {
                        return Err(format!("文件超过允许上限：{archive_path}"));
                    }
                    checked_total(&mut total, size, limits)?;
                    zip.start_file(&archive_path, file_options)
                        .map_err(|e| e.to_string())?;
                    zip.write_all(&data).map_err(|e| e.to_string())?;
                    entries.push(ManifestEntry {
                        path: archive_path,
                        kind: ArchiveEntryKind::File,
                        size,
                        sha256: Some(sha256_hex(&data)),
                    });
                }
                PackageSource::File { source_path, .. } => {
                    let metadata = reject_link_or_reparse(&source_path)?;
                    if !metadata.is_file() || metadata.len() > limits.max_file_bytes {
                        return Err(format!(
                            "源不是普通文件或超过上限：{}",
                            source_path.display()
                        ));
                    }
                    zip.start_file(&archive_path, file_options)
                        .map_err(|e| e.to_string())?;
                    let mut source_file = File::open(&source_path).map_err(|e| e.to_string())?;
                    let (size, hash) =
                        copy_with_hash(&mut source_file, &mut zip, limits.max_file_bytes)?;
                    if size != metadata.len() {
                        return Err(format!("源文件在导出时发生变化：{}", source_path.display()));
                    }
                    checked_total(&mut total, size, limits)?;
                    entries.push(ManifestEntry {
                        path: archive_path,
                        kind: ArchiveEntryKind::File,
                        size,
                        sha256: Some(hash),
                    });
                }
            }
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        *manifest.entries_mut() = entries;
        manifest.validate_contract(None)?;
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err("manifest 超过大小上限".into());
        }
        zip.start_file(MANIFEST_NAME, file_options)
            .map_err(|e| e.to_string())?;
        zip.write_all(&manifest_bytes).map_err(|e| e.to_string())?;
        zip.finish().map_err(|e| e.to_string())?;
    }
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    let verifier = temp
        .as_file()
        .try_clone()
        .map_err(|e| format!("复制导出校验句柄失败：{e}"))?;
    let verified = process_open_package(
        open_package_file(verifier, Some(manifest.format()), limits)?,
        limits,
        None,
    )?;
    if verified != manifest {
        return Err("导出临时包自检结果与写入 manifest 不一致".into());
    }
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    let bytes = temp.as_file().metadata().map_err(|e| e.to_string())?.len();
    temp.persist(&final_path)
        .map_err(|e| format!("提交导出文件失败：{}", e.error))?;
    Ok(PackageWriteResult {
        path: final_path,
        bytes,
        manifest,
    })
}

fn validate_zip_entry<R: Read>(
    file: &zip::read::ZipFile<'_, R>,
    limits: ArchiveLimits,
) -> Result<String, String> {
    let metadata = file.get_metadata();
    let raw_name =
        std::str::from_utf8(file.name_raw()).map_err(|_| "归档含非 UTF-8 路径".to_string())?;
    if file.name().as_bytes() != file.name_raw()
        || (!metadata.is_utf8 && !file.name_raw().is_ascii())
    {
        return Err("归档路径编码标志与原始 UTF-8 字节不一致".into());
    }
    let canonical = validate_archive_path(raw_name, file.is_dir())?;
    if file.encrypted() {
        return Err(format!("不支持加密 entry：{canonical}"));
    }
    if metadata.large_file
        || metadata.using_data_descriptor
        || !file.comment().is_empty()
        || file.extra_data().is_some_and(|value| !value.is_empty())
        || metadata
            .central_extra_field
            .as_ref()
            .is_some_and(|value| !value.is_empty())
    {
        return Err(format!(
            "V1 entry 不允许 descriptor/comment/extra：{canonical}"
        ));
    }
    if metadata.external_attributes & 0x400 != 0 {
        return Err(format!("拒绝 DOS reparse entry：{canonical}"));
    }
    if let Some(mode) = file.unix_mode() {
        let file_type = mode & 0o170000;
        let expected = if file.is_dir() { 0o040000 } else { 0o100000 };
        if file_type != expected {
            return Err(format!(
                "entry 类型与路径不一致或不是普通文件/目录：{canonical}"
            ));
        }
    }
    if file.is_symlink() || (!file.is_dir() && !file.is_file()) {
        return Err(format!("只允许普通文件/目录：{canonical}"));
    }
    if !matches!(
        file.compression(),
        CompressionMethod::Stored | CompressionMethod::Deflated
    ) {
        return Err(format!("不支持的压缩方法：{canonical}"));
    }
    if file.is_dir()
        && (file.size() != 0
            || file.compressed_size() != 0
            || file.compression() != CompressionMethod::Stored)
    {
        return Err(format!(
            "目录 entry 必须是无数据的 Stored 记录：{canonical}"
        ));
    }
    if file.size() > limits.max_file_bytes && canonical != MANIFEST_NAME {
        return Err(format!("entry 超过单文件上限：{canonical}"));
    }
    if file.size() > 0 {
        let compressed = file.compressed_size().max(1);
        let allowed_uncompressed = compressed
            .checked_mul(limits.max_compression_ratio)
            .unwrap_or(u64::MAX);
        if file.size() > allowed_uncompressed {
            return Err(format!("entry 压缩比异常：{canonical}"));
        }
    }
    Ok(canonical)
}

fn u16_le(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn u32_le(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

/// Strict V1 preflight before `ZipArchive::with_config` allocates central-directory state.
/// HtyBox packages deliberately exclude ZIP64, multi-disk archives, comments, prefixes, and trailers.
fn preflight_classic_zip(file: &mut File, limits: ArchiveLimits) -> Result<usize, String> {
    const EOCD_LEN: u64 = 22;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    let entry_cap = limits
        .max_entries
        .checked_add(1)
        .ok_or_else(|| "entry 上限溢出".to_string())?;
    let central_cap = (limits.max_entries as u64)
        .checked_mul(8 * 1024)
        .and_then(|value| value.checked_add(MAX_MANIFEST_BYTES))
        .ok_or_else(|| "central directory 上限溢出".to_string())?;
    let archive_cap = limits
        .max_total_bytes
        .checked_add(central_cap)
        .and_then(|value| value.checked_add(EOCD_LEN))
        .ok_or_else(|| "归档文件上限溢出".to_string())?;
    if length < EOCD_LEN || length > archive_cap {
        return Err("归档文件大小不在 V1 允许范围".into());
    }
    file.seek(SeekFrom::End(-(EOCD_LEN as i64)))
        .map_err(|e| e.to_string())?;
    let mut eocd = [0u8; EOCD_LEN as usize];
    file.read_exact(&mut eocd).map_err(|e| e.to_string())?;
    if &eocd[..4] != b"PK\x05\x06" || u16_le(&eocd, 20) != 0 {
        return Err("V1 只接受无注释的经典 ZIP".into());
    }
    let disk = u16_le(&eocd, 4);
    let central_disk = u16_le(&eocd, 6);
    let disk_entries = u16_le(&eocd, 8);
    let total_entries = u16_le(&eocd, 10);
    let central_size = u32_le(&eocd, 12);
    let central_offset = u32_le(&eocd, 16);
    if disk != 0
        || central_disk != 0
        || disk_entries != total_entries
        || total_entries == u16::MAX
        || central_size == u32::MAX
        || central_offset == u32::MAX
    {
        return Err("V1 不接受多盘或 ZIP64 包".into());
    }
    if total_entries as usize > entry_cap || central_size as u64 > central_cap {
        return Err("central directory 超过 V1 上限".into());
    }
    let central_end = (central_offset as u64)
        .checked_add(central_size as u64)
        .ok_or_else(|| "central directory 偏移溢出".to_string())?;
    if central_end != length - EOCD_LEN {
        return Err("ZIP 含前缀、尾随数据或异常 central directory 偏移".into());
    }
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    Ok(total_entries as usize)
}

#[derive(Clone)]
struct ZipEntryLayout {
    header_start: u64,
    data_start: u64,
    data_end: u64,
    central_header_start: u64,
    raw_name: Vec<u8>,
    flags: u16,
    method: u16,
    crc32: u32,
    compressed_size: u32,
    uncompressed_size: u32,
}

fn validate_local_header(file: &mut File, layout: &ZipEntryLayout) -> Result<(), String> {
    file.seek(SeekFrom::Start(layout.header_start))
        .map_err(|e| e.to_string())?;
    let mut header = [0u8; 30];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    let name_length = u16_le(&header, 26) as usize;
    let extra_length = u16_le(&header, 28);
    if name_length != layout.raw_name.len() || extra_length != 0 {
        return Err("V1 local header 名称长度异常或含 extra field".into());
    }
    if &header[..4] != b"PK\x03\x04"
        || u16_le(&header, 6) != layout.flags
        || u16_le(&header, 8) != layout.method
        || u32_le(&header, 14) != layout.crc32
        || u32_le(&header, 18) != layout.compressed_size
        || u32_le(&header, 22) != layout.uncompressed_size
    {
        return Err("ZIP local header 与 central metadata 不一致".into());
    }
    let expected_data_start = layout
        .header_start
        .checked_add(30)
        .and_then(|value| value.checked_add(name_length as u64))
        .ok_or_else(|| "local header 数据偏移溢出".to_string())?;
    if expected_data_start != layout.data_start {
        return Err("ZIP local header 数据偏移不一致".into());
    }
    let mut name = vec![0; name_length];
    file.read_exact(&mut name).map_err(|e| e.to_string())?;
    if name != layout.raw_name {
        return Err("ZIP local header 与 central 路径不一致".into());
    }
    Ok(())
}

fn validate_central_header(file: &mut File, layout: &ZipEntryLayout) -> Result<u64, String> {
    file.seek(SeekFrom::Start(layout.central_header_start))
        .map_err(|e| e.to_string())?;
    let mut header = [0u8; 46];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    let name_length = u16_le(&header, 28) as usize;
    if name_length != layout.raw_name.len() || u16_le(&header, 30) != 0 || u16_le(&header, 32) != 0
    {
        return Err("V1 central header 名称异常或含 extra/comment".into());
    }
    let local_offset = u32::try_from(layout.header_start)
        .map_err(|_| "V1 local header offset 超过经典 ZIP".to_string())?;
    if &header[..4] != b"PK\x01\x02"
        || u16_le(&header, 8) != layout.flags
        || u16_le(&header, 10) != layout.method
        || u32_le(&header, 16) != layout.crc32
        || u32_le(&header, 20) != layout.compressed_size
        || u32_le(&header, 24) != layout.uncompressed_size
        || u16_le(&header, 34) != 0
        || u32_le(&header, 42) != local_offset
    {
        return Err("ZIP central header 与解析 metadata 不一致".into());
    }
    let mut name = vec![0; name_length];
    file.read_exact(&mut name).map_err(|e| e.to_string())?;
    if name != layout.raw_name {
        return Err("ZIP central header 原始路径不一致".into());
    }
    layout
        .central_header_start
        .checked_add(46 + name_length as u64)
        .ok_or_else(|| "central header 范围溢出".to_string())
}

fn validate_non_overlapping_entries(
    archive: &mut ZipArchive<File>,
    raw_file: &mut File,
) -> Result<(), String> {
    let central_start = archive.central_directory_start();
    let mut layouts = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(|e| e.to_string())?;
        let start = entry.header_start();
        let data_start = entry.data_start();
        let end = data_start
            .checked_add(entry.compressed_size())
            .ok_or_else(|| "entry 压缩数据范围溢出".to_string())?;
        if start >= data_start || end > central_start {
            return Err("entry 本地头/数据范围越过 central directory".into());
        }
        let compressed_size = u32::try_from(entry.compressed_size())
            .map_err(|_| "V1 entry compressed size 超过经典 ZIP".to_string())?;
        let uncompressed_size = u32::try_from(entry.size())
            .map_err(|_| "V1 entry uncompressed size 超过经典 ZIP".to_string())?;
        let flags = if entry.name_raw().is_ascii() {
            0
        } else {
            1 << 11
        };
        let method = match entry.compression() {
            CompressionMethod::Stored => 0,
            CompressionMethod::Deflated => 8,
            _ => return Err("V1 不支持该压缩方法".into()),
        };
        layouts.push(ZipEntryLayout {
            header_start: start,
            data_start,
            data_end: end,
            central_header_start: entry.central_header_start(),
            raw_name: entry.name_raw().to_vec(),
            flags,
            method,
            crc32: entry.crc32(),
            compressed_size,
            uncompressed_size,
        });
    }
    let mut local_order = layouts.clone();
    local_order.sort_unstable_by_key(|layout| layout.header_start);
    if local_order
        .first()
        .is_some_and(|layout| layout.header_start != 0)
    {
        return Err("ZIP 含本地文件头之前的前缀数据".into());
    }
    for pair in local_order.windows(2) {
        if pair[1].header_start != pair[0].data_end {
            return Err("ZIP entry 本地记录不连续、存在空洞或重叠".into());
        }
    }
    if local_order
        .last()
        .is_some_and(|layout| layout.data_end != central_start)
    {
        return Err("ZIP 本地记录与 central directory 之间存在隐藏数据".into());
    }

    for layout in &local_order {
        validate_local_header(raw_file, layout)?;
    }
    let mut central_order = layouts;
    central_order.sort_unstable_by_key(|layout| layout.central_header_start);
    let mut expected_central_start = central_start;
    for layout in &central_order {
        if layout.central_header_start != expected_central_start {
            return Err("ZIP central directory 存在空洞、重叠或重排".into());
        }
        expected_central_start = validate_central_header(raw_file, layout)?;
    }
    let eocd_start = raw_file
        .metadata()
        .map_err(|e| e.to_string())?
        .len()
        .checked_sub(22)
        .ok_or_else(|| "ZIP 缺少 EOCD".to_string())?;
    if expected_central_start != eocd_start {
        return Err("ZIP central directory 尾部含隐藏数据".into());
    }
    Ok(())
}

fn open_package(
    path: &Path,
    expected_format: Option<&str>,
    limits: ArchiveLimits,
) -> Result<(ZipArchive<File>, PortableManifest), String> {
    let metadata = reject_link_or_reparse(path)?;
    if !metadata.is_file() {
        return Err("导入源不是普通文件".into());
    }
    let file = File::open(path).map_err(|e| format!("打开包失败：{e}"))?;
    open_package_file(file, expected_format, limits)
}

fn open_package_file(
    mut file: File,
    expected_format: Option<&str>,
    limits: ArchiveLimits,
) -> Result<(ZipArchive<File>, PortableManifest), String> {
    let raw_entry_count = preflight_classic_zip(&mut file, limits)?;
    let config = ZipReadConfig {
        archive_offset: ArchiveOffset::Known(0),
    };
    let mut raw_file = file
        .try_clone()
        .map_err(|e| format!("复制 ZIP 结构校验句柄失败：{e}"))?;
    let mut archive =
        ZipArchive::with_config(config, file).map_err(|e| format!("ZIP 结构无效：{e}"))?;
    if archive.len() != raw_entry_count {
        return Err("ZIP central directory 含被覆盖的重复 entry".into());
    }
    let entry_cap = limits
        .max_entries
        .checked_add(1)
        .ok_or_else(|| "entry 上限溢出".to_string())?;
    if archive.len() > entry_cap {
        return Err(format!("归档 entry 数超过上限：{}", limits.max_entries));
    }
    validate_non_overlapping_entries(&mut archive, &mut raw_file)?;
    let decompressed_cap = limits.max_total_bytes as u128 + MAX_MANIFEST_BYTES as u128;
    if archive
        .decompressed_size()
        .is_some_and(|size| size > decompressed_cap)
    {
        return Err("归档声明的总解压量超过上限".into());
    }

    let mut names = HashSet::new();
    let mut manifest_count = 0usize;
    let mut payload_count = 0usize;
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(|e| e.to_string())?;
        let canonical = validate_zip_entry(&entry, limits)?;
        if entry.enclosed_name().is_none() {
            return Err(format!("entry 无安全 enclosed path：{canonical}"));
        }
        if !names.insert(canonical.to_lowercase()) {
            return Err(format!("ZIP 含重复或大小写冲突 entry：{canonical}"));
        }
        if canonical == MANIFEST_NAME {
            manifest_count += 1;
            if entry.is_dir() || entry.size() > MAX_MANIFEST_BYTES {
                return Err("manifest 不是普通小文件".into());
            }
        } else {
            if !canonical.starts_with("payload/") {
                return Err(format!("ZIP 含 manifest 未声明区域：{canonical}"));
            }
            payload_count += 1;
            checked_total(&mut total, entry.size(), limits)?;
        }
    }
    if manifest_count != 1 {
        return Err("ZIP 必须且只能包含一个 manifest.json".into());
    }

    let manifest = {
        let mut entry = archive.by_name(MANIFEST_NAME).map_err(|e| e.to_string())?;
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .by_ref()
            .take(MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err("manifest 超过大小上限".into());
        }
        serde_json::from_slice::<PortableManifest>(&bytes)
            .map_err(|e| format!("manifest JSON 无效：{e}"))?
    };
    if manifest.entries().len() > limits.max_entries {
        return Err(format!("manifest entry 数超过上限：{}", limits.max_entries));
    }
    if manifest.entries().len() != payload_count {
        return Err("manifest entry 数与 ZIP 不一致".into());
    }
    manifest.validate_contract(expected_format)?;

    if matches!(&manifest, PortableManifest::Memory(_)) {
        for index in 0..archive.len() {
            let entry = archive.by_index_raw(index).map_err(|e| e.to_string())?;
            if entry.compression() != CompressionMethod::Stored {
                return Err("Memory V1 的 payload 与 manifest 必须全部使用 Stored".into());
            }
        }
    }

    let expected: BTreeMap<_, _> = manifest
        .entries()
        .iter()
        .map(|entry| (entry.path.as_str(), (entry.kind, entry.size)))
        .collect();
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(|e| e.to_string())?;
        let canonical = validate_zip_entry(&entry, limits)?;
        if canonical == MANIFEST_NAME {
            continue;
        }
        let actual = (
            if entry.is_dir() {
                ArchiveEntryKind::Directory
            } else {
                ArchiveEntryKind::File
            },
            entry.size(),
        );
        if expected.get(canonical.as_str()) != Some(&actual) {
            return Err(format!("manifest 与 ZIP 元数据不一致：{canonical}"));
        }
    }
    Ok((archive, manifest))
}

fn relative_archive_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| format!("staging 路径不在根目录内：{}", path.display()))?;
    let mut segments = Vec::new();
    for component in relative.components() {
        let std::path::Component::Normal(segment) = component else {
            return Err("staging 含非普通路径组件".into());
        };
        segments.push(
            segment
                .to_str()
                .ok_or_else(|| "staging 含非 UTF-8 路径".to_string())?,
        );
    }
    Ok(segments.join("/"))
}

fn verify_staging(root: &Path, manifest: &PortableManifest) -> Result<(), String> {
    let root_metadata = reject_link_or_reparse(root)?;
    if !root_metadata.is_dir() {
        return Err("staging 根不是普通目录".into());
    }
    let mut allowed_directories = HashSet::new();
    let mut expected_files = BTreeMap::new();
    for entry in manifest.entries() {
        let segments: Vec<_> = entry.path.split('/').collect();
        let directory_depth = if entry.kind == ArchiveEntryKind::Directory {
            segments.len()
        } else {
            segments.len().saturating_sub(1)
        };
        for depth in 1..=directory_depth {
            allowed_directories.insert(segments[..depth].join("/"));
        }
        if entry.kind == ArchiveEntryKind::File {
            expected_files.insert(entry.path.as_str(), entry);
        }
    }

    let mut seen_files = HashSet::new();
    for item in walkdir::WalkDir::new(root).min_depth(1).follow_links(false) {
        let item = item.map_err(|e| format!("重新枚举 staging 失败：{e}"))?;
        let path = item.path();
        let metadata = reject_link_or_reparse(path)?;
        let archive_path = relative_archive_path(root, path)?;
        if metadata.is_dir() {
            if !allowed_directories.contains(&archive_path) {
                return Err(format!("staging 含未声明目录：{archive_path}"));
            }
            continue;
        }
        if !metadata.is_file() {
            return Err(format!("staging 含非普通文件：{archive_path}"));
        }
        let declared = expected_files
            .get(archive_path.as_str())
            .ok_or_else(|| format!("staging 含未声明文件：{archive_path}"))?;
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let (size, hash) = copy_with_hash(&mut file, &mut std::io::sink(), declared.size)?;
        if size != declared.size || declared.sha256.as_deref() != Some(hash.as_str()) {
            return Err(format!("staging 文件复核失败：{archive_path}"));
        }
        seen_files.insert(archive_path);
    }
    if seen_files.len() != expected_files.len() {
        return Err("staging 缺少 manifest 声明文件".into());
    }
    for entry in manifest
        .entries()
        .iter()
        .filter(|entry| entry.kind == ArchiveEntryKind::Directory)
    {
        let target = entry
            .path
            .split('/')
            .fold(root.to_path_buf(), |mut path, segment| {
                path.push(segment);
                path
            });
        let metadata = reject_link_or_reparse(&target)?;
        if !metadata.is_dir() {
            return Err(format!("staging 缺少声明目录：{}", entry.path));
        }
    }
    Ok(())
}

pub fn validate_package(
    path: &Path,
    expected_format: Option<&str>,
    limits: ArchiveLimits,
) -> Result<PortableManifest, String> {
    process_package(path, expected_format, limits, None)
}

pub fn extract_package(
    path: &Path,
    destination: &Path,
    expected_format: Option<&str>,
    limits: ArchiveLimits,
) -> Result<PortableManifest, String> {
    if destination.exists() {
        return Err("解包 staging 必须不存在".into());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "解包 staging 缺少父目录".to_string())?
        .canonicalize()
        .map_err(|e| format!("解包 staging 父目录无效：{e}"))?;
    let parent_metadata = reject_link_or_reparse(&parent)?;
    if !parent_metadata.is_dir() {
        return Err("解包 staging 父路径不是普通目录".into());
    }
    std::fs::create_dir(destination).map_err(|e| format!("创建解包 staging 失败：{e}"))?;
    let result = (|| {
        let metadata = reject_link_or_reparse(destination)?;
        if !metadata.is_dir() {
            return Err("解包 staging 根不是普通目录".into());
        }
        process_package(path, expected_format, limits, Some(destination))
    })();
    match result {
        Ok(manifest) => Ok(manifest),
        Err(error) => {
            cleanup_staging(destination);
            Err(error)
        }
    }
}

fn process_package(
    path: &Path,
    expected_format: Option<&str>,
    limits: ArchiveLimits,
    destination: Option<&Path>,
) -> Result<PortableManifest, String> {
    let opened = open_package(path, expected_format, limits)?;
    process_open_package(opened, limits, destination)
}

fn process_open_package(
    opened: (ZipArchive<File>, PortableManifest),
    limits: ArchiveLimits,
    destination: Option<&Path>,
) -> Result<PortableManifest, String> {
    let (mut archive, manifest) = opened;
    let root = destination
        .map(|path| path.canonicalize().map_err(|e| e.to_string()))
        .transpose()?;
    if let Some(root) = &root {
        let metadata = reject_link_or_reparse(root)?;
        if !metadata.is_dir() {
            return Err("staging 根不是普通目录".into());
        }
    }
    let expected: BTreeMap<_, _> = manifest
        .entries()
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let canonical = validate_zip_entry(&entry, limits)?;
        if canonical == MANIFEST_NAME {
            continue;
        }
        let declared = expected
            .get(canonical.as_str())
            .ok_or_else(|| format!("未声明的 ZIP entry：{canonical}"))?;
        let target = root.as_ref().map(|root| {
            canonical
                .split('/')
                .fold(root.clone(), |mut value, segment| {
                    value.push(segment);
                    value
                })
        });
        if declared.kind == ArchiveEntryKind::Directory {
            if let Some(target) = target {
                ensure_safe_directory(root.as_ref().expect("target 仅在有 root 时存在"), &target)?;
                let metadata = reject_link_or_reparse(&target)?;
                if !metadata.is_dir() {
                    return Err(format!("目录 entry 落点不是目录：{canonical}"));
                }
            }
            continue;
        }

        let (size, hash) = if let Some(target) = target {
            let parent = target
                .parent()
                .ok_or_else(|| "entry 缺少父目录".to_string())?;
            ensure_safe_directory(root.as_ref().expect("target 仅在有 root 时存在"), parent)?;
            let parent = parent.canonicalize().map_err(|e| e.to_string())?;
            if !root.as_ref().is_some_and(|root| parent.starts_with(root)) {
                return Err(format!("entry 逃逸 staging：{canonical}"));
            }
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|e| format!("创建解包文件失败 {canonical}：{e}"))?;
            let result = copy_with_hash(&mut entry, &mut output, declared.size)?;
            output.sync_all().map_err(|e| e.to_string())?;
            result
        } else {
            copy_with_hash(&mut entry, &mut std::io::sink(), declared.size)?
        };
        if size != declared.size || declared.sha256.as_deref() != Some(hash.as_str()) {
            return Err(format!("entry 大小或 SHA-256 不匹配：{canonical}"));
        }
    }
    if let Some(root) = &root {
        verify_staging(root, &manifest)?;
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn memory_manifest() -> PortableManifest {
        PortableManifest::Memory(MemoryManifest {
            version: PACKAGE_VERSION,
            kind: PackageKind::Memory,
            agent: ArchiveAgent::Claude,
            source_workspace: "fixture".into(),
            source_slug: "fixture".into(),
            source_agent_version: "fixture-agent".into(),
            source_schema_version: "claude-memory-v1".into(),
            exported_at_ms: 1,
            capabilities: vec![ArchiveCapability::FullTree],
            entries: Vec::new(),
        })
    }

    fn session_manifest(
        agent: ArchiveAgent,
        capabilities: Vec<ArchiveCapability>,
    ) -> PortableManifest {
        PortableManifest::Session(SessionManifest {
            version: PACKAGE_VERSION,
            kind: PackageKind::Session,
            agent,
            session_id: "00000000-0000-0000-0000-000000000001".into(),
            source_cwd: "G:\\fixture".into(),
            source_agent_version: "fixture-agent".into(),
            source_schema_version: "fixture-schema-v1".into(),
            exported_at_ms: 1,
            label: Some("fixture".into()),
            native_relative_path: Some("sessions/fixture.jsonl".into()),
            capabilities,
            entries: Vec::new(),
        })
    }

    #[test]
    fn manifests_are_mutually_exclusive_and_capabilities_are_typed() {
        for manifest in [
            session_manifest(
                ArchiveAgent::Claude,
                vec![ArchiveCapability::Transcript, ArchiveCapability::History],
            ),
            session_manifest(ArchiveAgent::Codex, vec![ArchiveCapability::Rollout]),
            session_manifest(
                ArchiveAgent::Cursor,
                vec![ArchiveCapability::Metadata, ArchiveCapability::StoreDb],
            ),
            memory_manifest(),
        ] {
            manifest.validate_contract(None).unwrap();
            let encoded = serde_json::to_vec(&manifest).unwrap();
            assert_eq!(
                serde_json::from_slice::<PortableManifest>(&encoded).unwrap(),
                manifest
            );
        }

        let mut memory = serde_json::to_value(memory_manifest()).unwrap();
        memory
            .as_object_mut()
            .unwrap()
            .insert("sourceCwd".into(), serde_json::json!("G:\\wrong"));
        assert!(serde_json::from_value::<PortableManifest>(memory).is_err());

        let mut unknown = serde_json::to_value(memory_manifest()).unwrap();
        unknown["capabilities"] = serde_json::json!(["future-required"]);
        assert!(serde_json::from_value::<PortableManifest>(unknown).is_err());

        let invalid = session_manifest(ArchiveAgent::Codex, vec![ArchiveCapability::History]);
        assert!(invalid.validate_contract(None).is_err());
    }

    #[test]
    fn archive_path_validation_is_windows_safe() {
        assert_eq!(
            validate_archive_path("payload/记忆/topic.md", false).unwrap(),
            "payload/记忆/topic.md"
        );
        for bad in [
            "",
            "/payload/x",
            "../x",
            "payload/../x",
            "payload//x",
            "payload\\x",
            "C:/x",
            "C:x",
            "//server/share",
            "\\\\server\\share",
            "\\\\?\\C:\\x",
            "\\\\.\\C:\\x",
            "payload/NUL.txt",
            "payload/CON .txt",
            "payload/COM¹.txt",
            "payload/LPT³",
            "payload/end.",
            "payload/end ",
            "payload/a:b",
            "payload/*.md",
            "payload/\0x",
        ] {
            assert!(validate_archive_path(bad, false).is_err(), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn manifest_rejects_case_and_file_prefix_conflicts() {
        let file = |path: &str| ManifestEntry {
            path: path.into(),
            kind: ArchiveEntryKind::File,
            size: 1,
            sha256: Some("a".repeat(64)),
        };
        assert!(validate_manifest_entries(&[file("payload/A"), file("payload/a")]).is_err());
        assert!(
            validate_manifest_entries(&[file("payload/parent"), file("payload/parent/child")])
                .is_err()
        );
        assert!(validate_manifest_entries(&[file("payload/A/x"), file("payload/a/y")]).is_err());
    }

    #[test]
    fn package_round_trip_preserves_bytes_and_empty_directory() {
        let temp = tempdir().unwrap();
        let result = write_package(
            &temp.path().join("backup"),
            MEMORY_EXTENSION,
            memory_manifest(),
            vec![
                PackageSource::Directory {
                    archive_path: "payload/memory/empty".into(),
                },
                PackageSource::Bytes {
                    archive_path: "payload/memory/MEMORY.md".into(),
                    data: b"# memory\n".to_vec(),
                },
            ],
            ArchiveLimits::memory(),
        )
        .unwrap();
        assert!(result.path.ends_with("backup.htybox-memory"));
        let mut archive = ZipArchive::new(File::open(&result.path).unwrap()).unwrap();
        for index in 0..archive.len() {
            assert_eq!(
                archive.by_index_raw(index).unwrap().compression(),
                CompressionMethod::Stored
            );
        }
        let checked =
            validate_package(&result.path, Some(MEMORY_FORMAT), ArchiveLimits::memory()).unwrap();
        assert_eq!(checked.entries().len(), 2);
        let extracted = temp.path().join("extracted");
        extract_package(
            &result.path,
            &extracted,
            Some(MEMORY_FORMAT),
            ArchiveLimits::memory(),
        )
        .unwrap();
        assert!(extracted.join("payload/memory/empty").is_dir());
        assert_eq!(
            std::fs::read(extracted.join("payload/memory/MEMORY.md")).unwrap(),
            b"# memory\n"
        );
    }

    #[test]
    fn session_payload_and_manifest_remain_deflated() {
        let temp = tempdir().unwrap();
        let result = write_package(
            &temp.path().join("session"),
            SESSION_EXTENSION,
            session_manifest(ArchiveAgent::Codex, vec![ArchiveCapability::Rollout]),
            vec![PackageSource::Bytes {
                archive_path: "payload/rollout.jsonl".into(),
                data: br#"{"type":"session_meta"}
"#
                .to_vec(),
            }],
            ArchiveLimits::session(),
        )
        .unwrap();
        let mut archive = ZipArchive::new(File::open(result.path).unwrap()).unwrap();
        for index in 0..archive.len() {
            assert_eq!(
                archive.by_index_raw(index).unwrap().compression(),
                CompressionMethod::Deflated
            );
        }
    }

    fn write_raw_archive(
        path: &Path,
        manifest: &PortableManifest,
        files: &[(&str, &[u8])],
        symlink: Option<(&str, &str)>,
    ) {
        let file = File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in files {
            zip.start_file(*name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        if let Some((name, target)) = symlink {
            zip.add_symlink(name, target, options).unwrap();
        }
        zip.start_file(MANIFEST_NAME, options).unwrap();
        zip.write_all(&serde_json::to_vec(manifest).unwrap())
            .unwrap();
        zip.finish().unwrap();
    }

    fn write_stream_archive(path: &Path, manifest: &PortableManifest) {
        let mut zip = ZipWriter::new_stream(Vec::new());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("payload/memory/a", options).unwrap();
        zip.write_all(b"x").unwrap();
        zip.start_file(MANIFEST_NAME, options).unwrap();
        zip.write_all(&serde_json::to_vec(manifest).unwrap())
            .unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        std::fs::write(path, bytes).unwrap();
    }

    fn write_zip64_entry_archive(path: &Path, manifest: &PortableManifest) {
        let file = File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(true);
        zip.start_file("payload/memory/a", options).unwrap();
        zip.write_all(b"x").unwrap();
        zip.start_file(MANIFEST_NAME, SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&serde_json::to_vec(manifest).unwrap())
            .unwrap();
        zip.finish().unwrap();
    }

    fn replace_all_equal_length(path: &Path, from: &[u8], to: &[u8]) {
        assert_eq!(from.len(), to.len());
        validate_package(path, None, ArchiveLimits::memory()).unwrap();
        let mut bytes = std::fs::read(path).unwrap();
        let mut matched = None;
        for central in central_offsets(&bytes) {
            let name_length = read_u16(&bytes, central + 28) as usize;
            let name_start = central + 46;
            if &bytes[name_start..name_start + name_length] == from {
                matched = Some((central, name_start, name_length));
                break;
            }
        }
        let (central, central_name, name_length) = matched.unwrap();
        assert_eq!(name_length, from.len());
        let local = read_u32(&bytes, central + 42) as usize;
        let local_name = local + 30;
        assert_eq!(&bytes[local_name..local_name + name_length], from);
        bytes[local_name..local_name + name_length].copy_from_slice(to);
        bytes[central_name..central_name + name_length].copy_from_slice(to);
        std::fs::write(path, bytes).unwrap();
    }

    fn assert_rejected_without_staging(path: &Path) -> String {
        let staging = path.with_extension("staging");
        let error = extract_package(path, &staging, None, ArchiveLimits::memory()).unwrap_err();
        assert!(!staging.exists());
        error
    }

    fn read_u16(bytes: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
    }

    fn read_u32(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    }

    fn write_u16(bytes: &mut [u8], offset: usize, value: u16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn eocd_offset(bytes: &[u8]) -> usize {
        bytes
            .windows(4)
            .rposition(|window| window == b"PK\x05\x06")
            .unwrap()
    }

    fn central_offsets(bytes: &[u8]) -> Vec<usize> {
        let eocd = eocd_offset(bytes);
        let count = read_u16(bytes, eocd + 10) as usize;
        let mut offset = read_u32(bytes, eocd + 16) as usize;
        let mut result = Vec::with_capacity(count);
        for _ in 0..count {
            assert_eq!(&bytes[offset..offset + 4], b"PK\x01\x02");
            result.push(offset);
            let name = read_u16(bytes, offset + 28) as usize;
            let extra = read_u16(bytes, offset + 30) as usize;
            let comment = read_u16(bytes, offset + 32) as usize;
            offset += 46 + name + extra + comment;
        }
        result
    }

    fn mutate_archive(path: &Path, mutate: impl FnOnce(&mut Vec<u8>)) {
        validate_package(path, None, ArchiveLimits::memory()).unwrap();
        let mut bytes = std::fs::read(path).unwrap();
        mutate(&mut bytes);
        std::fs::write(path, bytes).unwrap();
    }

    fn valid_single_file_archive(path: &Path) {
        let mut manifest = memory_manifest();
        manifest.entries_mut().push(ManifestEntry {
            path: "payload/memory/a".into(),
            kind: ArchiveEntryKind::File,
            size: 1,
            sha256: Some(sha256_hex(b"x")),
        });
        write_raw_archive(path, &manifest, &[("payload/memory/a", b"x")], None);
    }

    #[test]
    fn package_rejects_hash_mismatch_and_unlisted_entry() {
        let temp = tempdir().unwrap();
        let mut manifest = memory_manifest();
        manifest.entries_mut().push(ManifestEntry {
            path: "payload/memory/a.md".into(),
            kind: ArchiveEntryKind::File,
            size: 3,
            sha256: Some("0".repeat(64)),
        });
        let hash_bad = temp.path().join("hash.htybox-memory");
        write_raw_archive(
            &hash_bad,
            &manifest,
            &[("payload/memory/a.md", b"abc")],
            None,
        );
        assert_rejected_without_staging(&hash_bad);

        manifest.entries_mut()[0].sha256 = Some(sha256_hex(b"abc"));
        let extra = temp.path().join("extra.htybox-memory");
        write_raw_archive(
            &extra,
            &manifest,
            &[
                ("payload/memory/a.md", b"abc"),
                ("payload/memory/extra", b"x"),
            ],
            None,
        );
        assert_rejected_without_staging(&extra);
    }

    #[test]
    fn package_rejects_zip_slip_and_windows_absolute_paths() {
        let temp = tempdir().unwrap();
        for (index, malicious) in [
            "../outside",
            "/absolute",
            "C:/absolute",
            "//server/share",
            "payload\\escape",
        ]
        .into_iter()
        .enumerate()
        {
            let mut manifest = memory_manifest();
            manifest.entries_mut().push(ManifestEntry {
                path: malicious.into(),
                kind: ArchiveEntryKind::File,
                size: 1,
                sha256: Some(sha256_hex(b"x")),
            });
            let path = temp.path().join(format!("path-{index}.htybox-memory"));
            write_raw_archive(&path, &manifest, &[(malicious, b"x")], None);
            assert_rejected_without_staging(&path);
        }
    }

    #[test]
    fn package_rejects_duplicate_and_symlink_entries() {
        let temp = tempdir().unwrap();
        let mut manifest = memory_manifest();
        for name in ["a", "b"] {
            manifest.entries_mut().push(ManifestEntry {
                path: format!("payload/memory/{name}"),
                kind: ArchiveEntryKind::File,
                size: 1,
                sha256: Some(sha256_hex(b"x")),
            });
        }
        let duplicate = temp.path().join("duplicate.htybox-memory");
        write_raw_archive(
            &duplicate,
            &manifest,
            &[("payload/memory/a", b"x"), ("payload/memory/b", b"x")],
            None,
        );
        replace_all_equal_length(&duplicate, b"payload/memory/b", b"payload/memory/a");
        assert!(assert_rejected_without_staging(&duplicate).contains("重复 entry"));

        let mut manifest = memory_manifest();
        manifest.entries_mut().push(ManifestEntry {
            path: "payload/memory/link".into(),
            kind: ArchiveEntryKind::File,
            size: 0,
            sha256: Some(sha256_hex(b"")),
        });
        let link = temp.path().join("link.htybox-memory");
        write_raw_archive(
            &link,
            &manifest,
            &[],
            Some(("payload/memory/link", "../outside")),
        );
        assert_rejected_without_staging(&link);
    }

    #[test]
    fn package_rejects_eocd_prefix_comment_and_zip64_tampering() {
        let temp = tempdir().unwrap();

        let multi_disk = temp.path().join("multi-disk.htybox-memory");
        valid_single_file_archive(&multi_disk);
        mutate_archive(&multi_disk, |bytes| {
            let eocd = eocd_offset(bytes);
            write_u16(bytes, eocd + 4, 1);
        });
        assert_rejected_without_staging(&multi_disk);

        let zip64 = temp.path().join("zip64.htybox-memory");
        valid_single_file_archive(&zip64);
        mutate_archive(&zip64, |bytes| {
            let eocd = eocd_offset(bytes);
            write_u16(bytes, eocd + 8, u16::MAX);
            write_u16(bytes, eocd + 10, u16::MAX);
        });
        assert_rejected_without_staging(&zip64);

        let count_bomb = temp.path().join("count-bomb.htybox-memory");
        valid_single_file_archive(&count_bomb);
        mutate_archive(&count_bomb, |bytes| {
            let eocd = eocd_offset(bytes);
            write_u16(bytes, eocd + 8, 20_002);
            write_u16(bytes, eocd + 10, 20_002);
        });
        assert_rejected_without_staging(&count_bomb);

        let comment = temp.path().join("comment.htybox-memory");
        valid_single_file_archive(&comment);
        mutate_archive(&comment, |bytes| {
            let eocd = eocd_offset(bytes);
            write_u16(bytes, eocd + 20, 1);
            bytes.push(b'x');
        });
        assert_rejected_without_staging(&comment);

        let prefixed = temp.path().join("prefixed.htybox-memory");
        valid_single_file_archive(&prefixed);
        mutate_archive(&prefixed, |bytes| {
            let eocd = eocd_offset(bytes);
            let central = central_offsets(bytes);
            for offset in central {
                let local = read_u32(bytes, offset + 42);
                write_u32(bytes, offset + 42, local + 2);
            }
            let central_start = read_u32(bytes, eocd + 16);
            write_u32(bytes, eocd + 16, central_start + 2);
            bytes.splice(0..0, *b"MZ");
        });
        assert!(assert_rejected_without_staging(&prefixed).contains("前缀"));
    }

    #[test]
    fn package_rejects_encryption_compression_and_special_file_metadata() {
        let temp = tempdir().unwrap();

        let encrypted = temp.path().join("encrypted.htybox-memory");
        valid_single_file_archive(&encrypted);
        mutate_archive(&encrypted, |bytes| {
            let central = central_offsets(bytes)[0];
            let local = read_u32(bytes, central + 42) as usize;
            let central_flags = read_u16(bytes, central + 8) | 1;
            let local_flags = read_u16(bytes, local + 6) | 1;
            write_u16(bytes, central + 8, central_flags);
            write_u16(bytes, local + 6, local_flags);
        });
        assert!(assert_rejected_without_staging(&encrypted).contains("header"));

        let unsupported = temp.path().join("unsupported.htybox-memory");
        valid_single_file_archive(&unsupported);
        mutate_archive(&unsupported, |bytes| {
            let central = central_offsets(bytes)[0];
            let local = read_u32(bytes, central + 42) as usize;
            write_u16(bytes, central + 10, 98);
            write_u16(bytes, local + 8, 98);
        });
        let error = assert_rejected_without_staging(&unsupported);
        assert!(error.contains("压缩方法"), "unexpected error: {error}");

        let fifo = temp.path().join("fifo.htybox-memory");
        valid_single_file_archive(&fifo);
        mutate_archive(&fifo, |bytes| {
            let central = central_offsets(bytes)[0];
            bytes[central + 5] = 3;
            write_u32(bytes, central + 38, (0o010000 | 0o600) << 16);
        });
        assert!(assert_rejected_without_staging(&fifo).contains("普通文件/目录"));

        let reparse = temp.path().join("reparse.htybox-memory");
        valid_single_file_archive(&reparse);
        mutate_archive(&reparse, |bytes| {
            let central = central_offsets(bytes)[0];
            bytes[central + 5] = 0;
            write_u32(bytes, central + 38, 0x400);
        });
        assert!(assert_rejected_without_staging(&reparse).contains("DOS reparse"));
    }

    #[test]
    fn package_rejects_data_descriptors_and_per_entry_zip64_extra() {
        let temp = tempdir().unwrap();
        let mut manifest = memory_manifest();
        manifest.entries_mut().push(ManifestEntry {
            path: "payload/memory/a".into(),
            kind: ArchiveEntryKind::File,
            size: 1,
            sha256: Some(sha256_hex(b"x")),
        });

        let descriptor = temp.path().join("descriptor.htybox-memory");
        write_stream_archive(&descriptor, &manifest);
        assert_rejected_without_staging(&descriptor);

        let zip64 = temp.path().join("entry-zip64.htybox-memory");
        write_zip64_entry_archive(&zip64, &manifest);
        let error = assert_rejected_without_staging(&zip64);
        assert!(error.contains("extra"), "unexpected error: {error}");
    }

    #[test]
    fn package_rejects_local_header_mismatch_and_directory_payload_data() {
        let temp = tempdir().unwrap();
        let local_mismatch = temp.path().join("local-name.htybox-memory");
        valid_single_file_archive(&local_mismatch);
        mutate_archive(&local_mismatch, |bytes| {
            let central = central_offsets(bytes)[0];
            let local = read_u32(bytes, central + 42) as usize;
            let name_length = read_u16(bytes, local + 26) as usize;
            assert_eq!(
                &bytes[local + 30..local + 30 + name_length],
                b"payload/memory/a"
            );
            bytes[local + 30 + name_length - 1] = b'b';
        });
        assert!(assert_rejected_without_staging(&local_mismatch).contains("路径不一致"));

        let directory_data = temp.path().join("directory-data.htybox-memory");
        let mut manifest = memory_manifest();
        manifest.entries_mut().push(ManifestEntry {
            path: "payload/memory/dir".into(),
            kind: ArchiveEntryKind::Directory,
            size: 0,
            sha256: None,
        });
        write_raw_archive(
            &directory_data,
            &manifest,
            &[("payload/memory/dir/", b"hidden")],
            None,
        );
        let mut bytes = std::fs::read(&directory_data).unwrap();
        let central = central_offsets(&bytes)[0];
        bytes[central + 5] = 3;
        write_u32(&mut bytes, central + 38, (0o040000 | 0o700) << 16);
        std::fs::write(&directory_data, bytes).unwrap();
        let error = assert_rejected_without_staging(&directory_data);
        assert!(error.contains("目录 entry"), "unexpected error: {error}");
    }

    #[test]
    fn package_rejects_central_directory_padding() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("central-padding.htybox-memory");
        valid_single_file_archive(&path);
        mutate_archive(&path, |bytes| {
            let eocd = eocd_offset(bytes);
            let central_size = read_u32(bytes, eocd + 12);
            write_u32(bytes, eocd + 12, central_size + 1);
            bytes.insert(eocd, 0);
        });
        let error = assert_rejected_without_staging(&path);
        assert!(error.contains("central") || error.contains("ZIP 结构"));
    }

    #[test]
    fn package_rejects_overlapping_local_entry_ranges() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("overlap.htybox-memory");
        let mut manifest = memory_manifest();
        for name in ["a", "b"] {
            manifest.entries_mut().push(ManifestEntry {
                path: format!("payload/memory/{name}"),
                kind: ArchiveEntryKind::File,
                size: 1,
                sha256: Some(sha256_hex(b"x")),
            });
        }
        write_raw_archive(
            &path,
            &manifest,
            &[("payload/memory/a", b"x"), ("payload/memory/b", b"x")],
            None,
        );
        mutate_archive(&path, |bytes| {
            let central = central_offsets(bytes);
            let first_local = read_u32(bytes, central[0] + 42);
            write_u32(bytes, central[1] + 42, first_local);
        });
        assert!(assert_rejected_without_staging(&path).contains("重叠"));
    }

    #[test]
    fn failed_export_preserves_existing_target_and_removes_tempfile() {
        let temp = tempdir().unwrap();
        let requested = temp.path().join("backup");
        let target = temp.path().join("backup.htybox-memory");
        std::fs::write(&target, b"sentinel").unwrap();
        let result = write_package(
            &requested,
            MEMORY_EXTENSION,
            memory_manifest(),
            vec![
                PackageSource::Bytes {
                    archive_path: "payload/memory/A".into(),
                    data: b"a".to_vec(),
                },
                PackageSource::Bytes {
                    archive_path: "payload/memory/a".into(),
                    data: b"b".to_vec(),
                },
            ],
            ArchiveLimits::memory(),
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"sentinel");
        assert!(std::fs::read_dir(temp.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".htybox-export-")
        }));

        assert!(write_package(
            &requested,
            SESSION_EXTENSION,
            memory_manifest(),
            Vec::new(),
            ArchiveLimits::memory(),
        )
        .is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"sentinel");
        assert!(!temp.path().join("backup.htybox-session").exists());
        assert!(std::fs::read_dir(temp.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".htybox-export-")
        }));
    }

    #[test]
    fn self_validation_rejects_abnormal_compression_ratio_atomically() {
        let temp = tempdir().unwrap();
        let limits = ArchiveLimits {
            max_compression_ratio: 2,
            ..ArchiveLimits::session()
        };
        let target = temp.path().join("ratio.htybox-session");
        assert!(write_package(
            &temp.path().join("ratio"),
            SESSION_EXTENSION,
            session_manifest(ArchiveAgent::Codex, vec![ArchiveCapability::Rollout]),
            vec![PackageSource::Bytes {
                archive_path: "payload/rollout.jsonl".into(),
                data: vec![0; 64 * 1024],
            }],
            limits,
        )
        .is_err());
        assert!(!target.exists());
    }

    #[test]
    fn package_rejects_wrong_contract_and_limits() {
        let mut manifest = memory_manifest();
        let PortableManifest::Memory(value) = &mut manifest else {
            unreachable!();
        };
        value.version = PACKAGE_VERSION + 1;
        assert!(manifest.validate_contract(None).is_err());
        let PortableManifest::Memory(value) = &mut manifest else {
            unreachable!();
        };
        value.version = PACKAGE_VERSION;
        assert!(manifest.validate_contract(Some(SESSION_FORMAT)).is_err());

        let temp = tempdir().unwrap();
        let small = ArchiveLimits {
            max_file_bytes: 2,
            max_total_bytes: 2,
            ..ArchiveLimits::memory()
        };
        let requested = temp.path().join("too-large");
        assert!(write_package(
            &requested,
            MEMORY_EXTENSION,
            memory_manifest(),
            vec![PackageSource::Bytes {
                archive_path: "payload/memory/a".into(),
                data: b"abc".to_vec()
            }],
            small,
        )
        .is_err());
        assert!(!temp.path().join("too-large.htybox-memory").exists());
    }
}
