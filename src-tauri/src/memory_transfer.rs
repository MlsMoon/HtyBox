//! Full-fidelity Claude project Memory snapshot export, inspection, and replace import.

use crate::catalog::resolve_claude_project_in_home;
use crate::portable_archive::{
    ensure_extension, extract_package, reject_link_or_reparse, validate_package, ArchiveAgent,
    ArchiveCapability, ArchiveEntryKind, ArchiveLimits, MemoryManifest, PackageKind, PackageSource,
    PackageWriteResult, PortableManifest, MEMORY_EXTENSION, MEMORY_FORMAT, PACKAGE_VERSION,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::TempDir;
use walkdir::WalkDir;

pub const CLAUDE_MEMORY_SCHEMA: &str = "claude-memory-v1";
pub const CLAUDE_MEMORY_VERSION_SENTINEL: &str = "not-recorded-by-claude-memory-v1";
pub const ABSENT_TARGET_REVISION: &str = "absent:v1";
const MEMORY_PAYLOAD_ROOT: &str = "payload/memory";
const STABLE_ATTEMPTS: usize = 3;
const MAX_MEMORY_ARCHIVE_BYTES: u64 = 768 * 1024 * 1024;

static MEMORY_IMPORT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static UNIQUE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryExportResult {
    pub path: String,
    pub bytes: u64,
    pub file_count: usize,
    pub directory_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportPreview {
    pub source_workspace: String,
    pub source_slug: String,
    pub source_agent_version: String,
    pub source_schema_version: String,
    pub exported_at_ms: i64,
    pub file_count: usize,
    pub directory_count: usize,
    pub total_bytes: u64,
    pub target_non_empty: bool,
    pub target_path: String,
    pub archive_sha256: String,
    pub target_revision: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportResult {
    pub status: String,
    pub target_path: String,
    pub file_count: usize,
    pub directory_count: usize,
    pub total_bytes: u64,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retained_backup_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportFault {
    None,
    AfterOldMoved,
    BeforeNewInstall,
    AfterNewInstall,
    RecreateExternalBeforeNewInstall,
    TamperAfterNewInstall,
    MutateOldBeforeCleanup,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TreeKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TreeEntry {
    relative: String,
    kind: TreeKind,
    size: u64,
    sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TreeFingerprint {
    digest: String,
    entries: Vec<TreeEntry>,
    file_count: usize,
    directory_count: usize,
    total_bytes: u64,
}

#[derive(Debug)]
struct StableSnapshot {
    _scratch: TempDir,
    root: PathBuf,
    fingerprint: TreeFingerprint,
}

#[derive(Debug)]
struct ValidatedMemoryArchive {
    manifest: MemoryManifest,
    archive_sha256: String,
    file_count: usize,
    directory_count: usize,
    total_bytes: u64,
}

fn memory_warnings() -> Vec<String> {
    vec![
        "Claude Memory 包是明文敏感数据，可能包含项目约定、代码信息和历史上下文。".into(),
        "Claude Memory V1 不记录 Claude CLI 版本，manifest 已使用明确 sentinel。".into(),
    ]
}

fn path_relative_string(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Memory entry 逃逸根目录".to_string())?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => parts.push(
                value
                    .to_str()
                    .ok_or_else(|| "Memory 路径不是 UTF-8".to_string())?,
            ),
            _ => return Err("Memory 路径含非普通组件".into()),
        }
    }
    if parts.is_empty() {
        return Err("Memory entry 相对路径为空".into());
    }
    Ok(parts.join("/"))
}

fn hash_frame(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

fn finish_fingerprint(mut entries: Vec<TreeEntry>) -> Result<TreeFingerprint, String> {
    entries.sort_by(|left, right| left.relative.cmp(&right.relative));
    if entries.len() > ArchiveLimits::memory().max_entries.saturating_sub(1) {
        return Err("Memory entry 数超过 20,000 上限（含 transport 根）".into());
    }
    let mut file_count = 0usize;
    let mut directory_count = 0usize;
    let mut total_bytes = 0u64;
    let mut hasher = Sha256::new();
    hash_frame(&mut hasher, b"htybox-memory-tree-v1:present");
    for entry in &entries {
        hash_frame(&mut hasher, entry.relative.as_bytes());
        match entry.kind {
            TreeKind::Directory => {
                directory_count += 1;
                hash_frame(&mut hasher, b"directory");
            }
            TreeKind::File => {
                file_count += 1;
                total_bytes = total_bytes
                    .checked_add(entry.size)
                    .ok_or_else(|| "Memory 总大小溢出".to_string())?;
                if total_bytes > ArchiveLimits::memory().max_total_bytes {
                    return Err("Memory 总大小超过 512 MiB".into());
                }
                hash_frame(&mut hasher, b"file");
                hash_frame(&mut hasher, &entry.size.to_le_bytes());
                hash_frame(
                    &mut hasher,
                    entry
                        .sha256
                        .as_deref()
                        .ok_or_else(|| "Memory file fingerprint 缺少 SHA-256".to_string())?
                        .as_bytes(),
                );
            }
        }
    }
    Ok(TreeFingerprint {
        digest: format!("present:v1:{:x}", hasher.finalize()),
        entries,
        file_count,
        directory_count,
        total_bytes,
    })
}

fn hash_or_copy_file(source: &Path, destination: Option<&Path>) -> Result<(u64, String), String> {
    let metadata = reject_link_or_reparse(source)?;
    if !metadata.is_file() || metadata.len() > ArchiveLimits::memory().max_file_bytes {
        return Err(format!(
            "Memory 来源不是普通文件或超过 64 MiB：{}",
            source.display()
        ));
    }
    let source_file = File::open(source).map_err(|error| error.to_string())?;
    let opened_len = source_file
        .metadata()
        .map_err(|error| error.to_string())?
        .len();
    if opened_len != metadata.len() {
        return Err("Memory 文件在打开期间发生长度变化".into());
    }
    let mut reader = source_file.take(opened_len);
    let mut target = match destination {
        Some(path) => {
            let parent = path
                .parent()
                .ok_or_else(|| "Memory snapshot 文件缺少父目录".to_string())?;
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            Some(
                OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(path)
                    .map_err(|error| format!("创建 Memory snapshot 文件失败：{error}"))?,
            )
        }
        None => None,
    };
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "Memory 文件读取计数溢出".to_string())?;
        if total > opened_len {
            return Err("Memory 文件读取超过固定长度".into());
        }
        hasher.update(&buffer[..read]);
        if let Some(target) = target.as_mut() {
            target
                .write_all(&buffer[..read])
                .map_err(|error| error.to_string())?;
        }
    }
    if total != opened_len {
        return Err("Memory 文件在读取期间被截断".into());
    }
    if let Some(target) = target {
        target.sync_all().map_err(|error| error.to_string())?;
    }
    let final_metadata = reject_link_or_reparse(source)?;
    if !final_metadata.is_file() || final_metadata.len() != opened_len {
        return Err("Memory 文件在读取后发生类型或长度变化".into());
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn collect_paths(root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let metadata = reject_link_or_reparse(root)?;
    if !metadata.is_dir() {
        return Err(format!("Memory 根不是普通目录：{}", root.display()));
    }
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let mut paths = Vec::new();
    for item in WalkDir::new(root).min_depth(1).follow_links(false) {
        let item = item.map_err(|error| format!("扫描 Memory 树失败：{error}"))?;
        reject_link_or_reparse(item.path())?;
        let canonical = item
            .path()
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let relative = path_relative_string(&canonical_root, &canonical)?;
        paths.push((relative, canonical));
        if paths.len() > ArchiveLimits::memory().max_entries.saturating_sub(1) {
            return Err("Memory entry 数超过 20,000 上限".into());
        }
    }
    paths.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(paths)
}

fn fingerprint_tree(root: &Path) -> Result<TreeFingerprint, String> {
    let mut entries = Vec::new();
    for (relative, path) in collect_paths(root)? {
        let metadata = reject_link_or_reparse(&path)?;
        if metadata.is_dir() {
            entries.push(TreeEntry {
                relative,
                kind: TreeKind::Directory,
                size: 0,
                sha256: None,
            });
        } else if metadata.is_file() {
            let (size, sha256) = hash_or_copy_file(&path, None)?;
            entries.push(TreeEntry {
                relative,
                kind: TreeKind::File,
                size,
                sha256: Some(sha256),
            });
        } else {
            return Err("Memory 只允许普通文件和目录".into());
        }
    }
    finish_fingerprint(entries)
}

fn copy_tree_snapshot(source: &Path, destination: &Path) -> Result<TreeFingerprint, String> {
    if destination.exists() {
        return Err("Memory snapshot 目标必须不存在".into());
    }
    std::fs::create_dir(destination).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    for (relative, path) in collect_paths(source)? {
        let target = relative
            .split('/')
            .fold(destination.to_path_buf(), |mut value, part| {
                value.push(part);
                value
            });
        let metadata = reject_link_or_reparse(&path)?;
        if metadata.is_dir() {
            std::fs::create_dir(&target).map_err(|error| {
                format!(
                    "创建 Memory snapshot 目录 {} 失败：{error}",
                    target.display()
                )
            })?;
            entries.push(TreeEntry {
                relative,
                kind: TreeKind::Directory,
                size: 0,
                sha256: None,
            });
        } else if metadata.is_file() {
            let (size, sha256) = hash_or_copy_file(&path, Some(&target))?;
            entries.push(TreeEntry {
                relative,
                kind: TreeKind::File,
                size,
                sha256: Some(sha256),
            });
        } else {
            return Err("Memory snapshot 只允许普通文件和目录".into());
        }
    }
    finish_fingerprint(entries)
}

fn stable_source_snapshot(memory: &Path, scratch_parent: &Path) -> Result<StableSnapshot, String> {
    stable_source_snapshot_with_hook(memory, scratch_parent, &mut |_, _| {})
}

fn stable_source_snapshot_with_hook(
    memory: &Path,
    scratch_parent: &Path,
    hook: &mut dyn FnMut(usize, &Path),
) -> Result<StableSnapshot, String> {
    let mut last_error = String::new();
    for attempt_index in 0..STABLE_ATTEMPTS {
        let attempt = (|| {
            let pre = fingerprint_tree(memory)?;
            let scratch = tempfile::Builder::new()
                .prefix(".htybox-snap-")
                .tempdir_in(scratch_parent)
                .map_err(|error| format!("创建 Memory snapshot scratch 失败：{error}"))?;
            let snapshot_root = scratch.path().join("tree");
            let copied = copy_tree_snapshot(memory, &snapshot_root)?;
            hook(attempt_index, memory);
            let post = fingerprint_tree(memory)?;
            if pre != copied || copied != post {
                return Err("Memory 树在 pre/copy/post 期间发生变化".to_string());
            }
            Ok(StableSnapshot {
                _scratch: scratch,
                root: snapshot_root,
                fingerprint: copied,
            })
        })();
        match attempt {
            Ok(snapshot) => return Ok(snapshot),
            Err(error) => last_error = error,
        }
    }
    Err(format!("Memory 树连续 3 次无法取得稳定快照：{last_error}"))
}

fn stable_target_revision(memory: &Path) -> Result<(String, bool), String> {
    match std::fs::symlink_metadata(memory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((ABSENT_TARGET_REVISION.into(), false));
        }
        Err(error) => return Err(format!("检查目标 Memory 失败：{error}")),
        Ok(_) => {}
    }
    let metadata = reject_link_or_reparse(memory)?;
    if !metadata.is_dir() {
        return Err("目标 memory 存在但不是普通目录".into());
    }
    let mut last = None;
    for _ in 0..STABLE_ATTEMPTS {
        let first = fingerprint_tree(memory)?;
        let second = fingerprint_tree(memory)?;
        if first == second {
            let non_empty = !first.entries.is_empty();
            return Ok((first.digest, non_empty));
        }
        last = Some((first.digest, second.digest));
    }
    Err(format!(
        "目标 Memory 持续变化，无法生成确认 revision：{last:?}"
    ))
}

fn archive_file_sha256(path: &Path) -> Result<String, String> {
    let metadata = reject_link_or_reparse(path)?;
    if !metadata.is_file() {
        return Err("Memory 包不是普通文件".into());
    }
    if metadata.len() > MAX_MEMORY_ARCHIVE_BYTES {
        return Err("Memory 包物理大小超过 768 MiB 安全上限".into());
    }
    let file = File::open(path).map_err(|error| error.to_string())?;
    let opened_len = file.metadata().map_err(|error| error.to_string())?.len();
    if opened_len != metadata.len() {
        return Err("Memory 包在打开期间发生长度变化".into());
    }
    let mut reader = file.take(opened_len);
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "Memory 包 hash 计数溢出".to_string())?;
        hasher.update(&buffer[..read]);
    }
    if total != opened_len {
        return Err("Memory 包在 hash 期间被截断".into());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_memory_business(manifest: &MemoryManifest) -> Result<(usize, usize, u64), String> {
    if manifest.source_schema_version != CLAUDE_MEMORY_SCHEMA
        || manifest.source_agent_version != CLAUDE_MEMORY_VERSION_SENTINEL
    {
        return Err("Memory manifest schema 或 Agent version sentinel 不受支持".into());
    }
    let expected_slug = crate::catalog::claude_project_slug(&manifest.source_workspace)?;
    let expected_key: String = expected_slug.chars().flat_map(char::to_lowercase).collect();
    let actual_key: String = manifest
        .source_slug
        .chars()
        .flat_map(char::to_lowercase)
        .collect();
    if expected_key != actual_key {
        return Err("Memory manifest sourceSlug 与 sourceWorkspace 不一致".into());
    }
    if manifest.capabilities.as_slice() != [ArchiveCapability::FullTree] {
        return Err("Memory V1 capabilities 必须精确为 full-tree".into());
    }
    let entries: BTreeMap<_, _> = manifest
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    if entries
        .get(MEMORY_PAYLOAD_ROOT)
        .is_none_or(|entry| entry.kind != ArchiveEntryKind::Directory)
    {
        return Err("Memory 包缺少 payload/memory Directory 根".into());
    }
    let mut file_count = 0usize;
    let mut directory_count = 0usize;
    let mut total_bytes = 0u64;
    for (path, entry) in &entries {
        if *path != MEMORY_PAYLOAD_ROOT && !path.starts_with(&format!("{MEMORY_PAYLOAD_ROOT}/")) {
            return Err(format!("Memory 包含闭包外 entry：{path}"));
        }
        if *path != MEMORY_PAYLOAD_ROOT {
            let mut parent = path.rsplit_once('/').map(|(parent, _)| parent);
            while let Some(directory) = parent {
                if entries
                    .get(directory)
                    .is_none_or(|entry| entry.kind != ArchiveEntryKind::Directory)
                {
                    return Err(format!("Memory entry 缺少显式父目录：{directory}"));
                }
                if directory == MEMORY_PAYLOAD_ROOT {
                    break;
                }
                parent = directory.rsplit_once('/').map(|(next, _)| next);
            }
            match entry.kind {
                ArchiveEntryKind::File => {
                    file_count += 1;
                    total_bytes = total_bytes
                        .checked_add(entry.size)
                        .ok_or_else(|| "Memory manifest 总大小溢出".to_string())?;
                }
                ArchiveEntryKind::Directory => directory_count += 1,
            }
        }
    }
    Ok((file_count, directory_count, total_bytes))
}

fn validate_archive_stable(path: &Path) -> Result<ValidatedMemoryArchive, String> {
    let before = archive_file_sha256(path)?;
    let portable = validate_package(path, Some(MEMORY_FORMAT), ArchiveLimits::memory())?;
    let after = archive_file_sha256(path)?;
    if before != after {
        return Err("Memory 包在完整预检期间发生变化，请重新选择".into());
    }
    let PortableManifest::Memory(manifest) = portable else {
        return Err("包不是 Memory 包".into());
    };
    let (file_count, directory_count, total_bytes) = validate_memory_business(&manifest)?;
    Ok(ValidatedMemoryArchive {
        manifest,
        archive_sha256: after,
        file_count,
        directory_count,
        total_bytes,
    })
}

fn reject_archive_inside_target(archive: &Path, target: &Path) -> Result<(), String> {
    let archive = archive
        .canonicalize()
        .map_err(|error| format!("解析 Memory 包路径失败：{error}"))?;
    if let Ok(target) = target.canonicalize() {
        if archive == target || archive.starts_with(&target) {
            return Err("导入包位于将被整体替换的目标 memory 内，请先移到其他目录".into());
        }
    } else if archive.starts_with(target) {
        return Err("导入包位于未来目标 memory 内，请先移到其他目录".into());
    }
    Ok(())
}

fn reject_export_destination_in_source(destination: &Path, source: &Path) -> Result<(), String> {
    let requested = ensure_extension(destination, MEMORY_EXTENSION);
    let parent = requested
        .parent()
        .ok_or_else(|| "Memory 导出目标缺少父目录".to_string())?
        .canonicalize()
        .map_err(|error| format!("Memory 导出父目录无效：{error}"))?;
    let metadata = reject_link_or_reparse(&parent)?;
    if !metadata.is_dir() {
        return Err("Memory 导出父路径不是普通目录".into());
    }
    let source = source.canonicalize().map_err(|error| error.to_string())?;
    let file_name = requested
        .file_name()
        .ok_or_else(|| "Memory 导出目标缺少文件名".to_string())?;
    let final_path = parent.join(file_name);
    if final_path == source || final_path.starts_with(&source) || parent.starts_with(&source) {
        return Err("Memory 导出目标不能位于源 memory 目录内".into());
    }
    Ok(())
}

pub fn export_memory_archive(
    project_dir: &str,
    destination: &str,
) -> Result<MemoryExportResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户 home 目录".to_string())?;
    export_memory_archive_in(&home, project_dir, Path::new(destination))
}

fn export_memory_archive_in(
    home: &Path,
    project_dir: &str,
    destination: &Path,
) -> Result<MemoryExportResult, String> {
    let paths = resolve_claude_project_in_home(project_dir, home)?;
    if !paths.exists {
        return Err("当前工作区尚无 Claude project storage，不能导出 Memory".into());
    }
    let metadata = reject_link_or_reparse(&paths.memory_dir)
        .map_err(|error| format!("当前工作区尚无可导出的 Claude memory：{error}"))?;
    if !metadata.is_dir() {
        return Err("Claude memory 存在但不是普通目录".into());
    }
    reject_export_destination_in_source(destination, &paths.memory_dir)?;
    let snapshot = stable_source_snapshot(&paths.memory_dir, &paths.storage_dir)?;
    let mut sources = vec![PackageSource::Directory {
        archive_path: MEMORY_PAYLOAD_ROOT.into(),
    }];
    for entry in &snapshot.fingerprint.entries {
        let archive_path = format!("{MEMORY_PAYLOAD_ROOT}/{}", entry.relative);
        let source_path =
            entry
                .relative
                .split('/')
                .fold(snapshot.root.clone(), |mut path, component| {
                    path.push(component);
                    path
                });
        match entry.kind {
            TreeKind::Directory => sources.push(PackageSource::Directory { archive_path }),
            TreeKind::File => sources.push(PackageSource::File {
                archive_path,
                source_path,
            }),
        }
    }
    let exported_at_ms = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "系统时间早于 Unix epoch".to_string())?
            .as_millis(),
    )
    .map_err(|_| "系统时间超出 manifest 范围".to_string())?;
    let manifest = PortableManifest::Memory(MemoryManifest {
        version: PACKAGE_VERSION,
        kind: PackageKind::Memory,
        agent: ArchiveAgent::Claude,
        source_workspace: project_dir.into(),
        source_slug: paths.actual_slug,
        source_agent_version: CLAUDE_MEMORY_VERSION_SENTINEL.into(),
        source_schema_version: CLAUDE_MEMORY_SCHEMA.into(),
        exported_at_ms,
        capabilities: vec![ArchiveCapability::FullTree],
        entries: Vec::new(),
    });
    let PackageWriteResult { path, bytes, .. } = crate::portable_archive::write_package(
        destination,
        MEMORY_EXTENSION,
        manifest,
        sources,
        ArchiveLimits::memory(),
    )?;
    Ok(MemoryExportResult {
        path: path.to_string_lossy().into_owned(),
        bytes,
        file_count: snapshot.fingerprint.file_count,
        directory_count: snapshot.fingerprint.directory_count,
        warnings: memory_warnings(),
    })
}

pub fn inspect_memory_archive(
    project_dir: &str,
    archive_path: &str,
) -> Result<MemoryImportPreview, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户 home 目录".to_string())?;
    inspect_memory_archive_in(&home, project_dir, Path::new(archive_path))
}

fn inspect_memory_archive_in(
    home: &Path,
    project_dir: &str,
    archive_path: &Path,
) -> Result<MemoryImportPreview, String> {
    let paths = resolve_claude_project_in_home(project_dir, home)?;
    reject_archive_inside_target(archive_path, &paths.memory_dir)?;
    let archive = validate_archive_stable(archive_path)?;
    let (target_revision, target_non_empty) = stable_target_revision(&paths.memory_dir)?;
    Ok(MemoryImportPreview {
        source_workspace: archive.manifest.source_workspace,
        source_slug: archive.manifest.source_slug,
        source_agent_version: archive.manifest.source_agent_version,
        source_schema_version: archive.manifest.source_schema_version,
        exported_at_ms: archive.manifest.exported_at_ms,
        file_count: archive.file_count,
        directory_count: archive.directory_count,
        total_bytes: archive.total_bytes,
        target_non_empty,
        target_path: paths.memory_dir.to_string_lossy().into_owned(),
        archive_sha256: archive.archive_sha256,
        target_revision,
    })
}

fn ensure_plain_dirs_under(
    home: &Path,
    directory: &Path,
    created: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let relative = directory
        .strip_prefix(home)
        .map_err(|_| format!("Memory 目标父目录逃逸 home：{}", directory.display()))?;
    let mut current = home.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err("Memory 目标父目录含非法组件".into());
        };
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(_) => {
                let metadata = reject_link_or_reparse(&current)?;
                if !metadata.is_dir() {
                    return Err(format!("Memory 目标父路径不是目录：{}", current.display()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|error| {
                    format!("创建 Memory 目标父目录 {} 失败：{error}", current.display())
                })?;
                let metadata = reject_link_or_reparse(&current)?;
                if !metadata.is_dir() {
                    return Err("新建 Memory 父目录类型异常".into());
                }
                created.push(current.clone());
            }
            Err(error) => return Err(format!("检查 Memory 目标父目录失败：{error}")),
        }
    }
    Ok(())
}

fn cleanup_created_dirs(home: &Path, created: &[PathBuf]) -> Result<(), String> {
    let mut failures = Vec::new();
    for path in created.iter().rev() {
        if path.strip_prefix(home).is_err() {
            failures.push(format!("拒绝清理 home 外目录：{}", path.display()));
            continue;
        }
        match reject_link_or_reparse(path) {
            Ok(metadata) if metadata.is_dir() => {
                if let Err(error) = std::fs::remove_dir(path) {
                    if error.kind() != std::io::ErrorKind::DirectoryNotEmpty {
                        failures.push(format!("清理 Memory 空父目录失败：{error}"));
                    }
                }
            }
            Ok(_) => failures.push(format!("Memory 新建父目录类型异常：{}", path.display())),
            Err(error) => failures.push(error),
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("；"))
    }
}

fn unique_sibling(storage: &Path, prefix: &str) -> Result<PathBuf, String> {
    if prefix.to_ascii_lowercase().contains("memory") {
        return Err("Memory transport sibling 名称不得含 memory".into());
    }
    for _ in 0..100 {
        let counter = UNIQUE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = storage.join(format!("{prefix}{}-{counter}", std::process::id()));
        match std::fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => return Err(format!("检查唯一 transport 路径失败：{error}")),
            Ok(_) => continue,
        }
    }
    Err("无法分配唯一 Memory transport sibling".into())
}

fn fingerprint_from_manifest(manifest: &MemoryManifest) -> Result<TreeFingerprint, String> {
    let mut entries = Vec::new();
    for entry in &manifest.entries {
        if entry.path == MEMORY_PAYLOAD_ROOT {
            continue;
        }
        let relative = entry
            .path
            .strip_prefix(&format!("{MEMORY_PAYLOAD_ROOT}/"))
            .ok_or_else(|| "Memory manifest entry 逃逸 payload 根".to_string())?;
        entries.push(TreeEntry {
            relative: relative.into(),
            kind: match entry.kind {
                ArchiveEntryKind::File => TreeKind::File,
                ArchiveEntryKind::Directory => TreeKind::Directory,
            },
            size: entry.size,
            sha256: entry.sha256.clone(),
        });
    }
    finish_fingerprint(entries)
}

fn same_expected(value: &str, expected: &str, field: &str) -> Result<(), String> {
    if value != expected {
        Err(format!("{field} 已变化，请重新 inspect 并确认"))
    } else {
        Ok(())
    }
}

fn maybe_fault(actual: ImportFault, expected: ImportFault, label: &str) -> Result<(), String> {
    if actual == expected {
        Err(format!("测试故障注入：{label}"))
    } else {
        Ok(())
    }
}

struct RollbackReport {
    conflict_path: Option<PathBuf>,
}

fn rollback_replace(
    storage: &Path,
    target: &Path,
    old: Option<&Path>,
    new_installed: bool,
    incoming_revision: &str,
    stage: &Path,
) -> Result<RollbackReport, String> {
    let mut conflict_path = None;
    if std::fs::symlink_metadata(target).is_ok() {
        let target_fingerprint = new_installed
            .then(|| fingerprint_tree(target).ok())
            .flatten();
        if new_installed
            && target_fingerprint
                .as_ref()
                .is_some_and(|fingerprint| fingerprint.digest == incoming_revision)
        {
            let discarded = stage.join("failed-new");
            std::fs::rename(target, &discarded).map_err(|error| {
                format!(
                    "回滚时移走本轮新 Memory 失败 {} -> {}：{error}",
                    target.display(),
                    discarded.display()
                )
            })?;
        } else if old.is_some() || new_installed {
            let conflict = unique_sibling(storage, ".htybox-conflict-")?;
            std::fs::rename(target, &conflict).map_err(|error| {
                format!(
                    "回滚时保全外部冲突 Memory 失败 {} -> {}：{error}",
                    target.display(),
                    conflict.display()
                )
            })?;
            conflict_path = Some(conflict);
        }
    }
    if let Some(old) = old {
        if let Err(error) = std::fs::rename(old, target) {
            return Err(format!(
                "恢复旧 Memory 失败：target={} old={} conflict={} error={error}",
                target.display(),
                old.display(),
                conflict_path
                    .as_deref()
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "<none>".into())
            ));
        }
    }
    Ok(RollbackReport { conflict_path })
}

pub fn import_memory_archive(
    project_dir: &str,
    archive_path: &str,
    expected_archive_sha256: &str,
    expected_target_revision: &str,
) -> Result<MemoryImportResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户 home 目录".to_string())?;
    import_memory_archive_in(
        &home,
        project_dir,
        Path::new(archive_path),
        expected_archive_sha256,
        expected_target_revision,
        ImportFault::None,
        &|path| trash::delete(path).map_err(|error| error.to_string()),
    )
}

fn import_memory_archive_in(
    home: &Path,
    project_dir: &str,
    archive_path: &Path,
    expected_archive_sha256: &str,
    expected_target_revision: &str,
    fault: ImportFault,
    backup_cleaner: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<MemoryImportResult, String> {
    let lock = MEMORY_IMPORT_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "Memory 导入互斥锁已中毒，请重启 HtyBox".to_string())?;
    let initial_paths = resolve_claude_project_in_home(project_dir, home)?;
    reject_archive_inside_target(archive_path, &initial_paths.memory_dir)?;
    let archive = validate_archive_stable(archive_path)?;
    same_expected(
        &archive.archive_sha256,
        expected_archive_sha256,
        "archiveSha256",
    )?;
    let (initial_revision, _) = stable_target_revision(&initial_paths.memory_dir)?;
    same_expected(
        &initial_revision,
        expected_target_revision,
        "targetRevision",
    )?;

    let mut created_dirs = Vec::new();
    let result = (|| {
        ensure_plain_dirs_under(home, &initial_paths.projects_root, &mut created_dirs)?;
        ensure_plain_dirs_under(home, &initial_paths.storage_dir, &mut created_dirs)?;
        let paths = resolve_claude_project_in_home(project_dir, home)?;
        if paths.storage_dir != initial_paths.storage_dir {
            return Err("Claude project bucket 在创建期间发生大小写歧义/竞态".into());
        }
        let stage = tempfile::Builder::new()
            .prefix(".htybox-stage-")
            .tempdir_in(&paths.storage_dir)
            .map_err(|error| format!("创建同 parent Memory staging 失败：{error}"))?;
        let unpacked = stage.path().join("unpacked");
        let extracted = extract_package(
            archive_path,
            &unpacked,
            Some(MEMORY_FORMAT),
            ArchiveLimits::memory(),
        )?;
        let PortableManifest::Memory(extracted_manifest) = extracted else {
            return Err("解包结果不是 Memory 包".into());
        };
        if extracted_manifest != archive.manifest {
            return Err("validate/extract 得到不同 Memory manifest，拒绝 TOCTOU 导入".into());
        }
        same_expected(
            &archive_file_sha256(archive_path)?,
            expected_archive_sha256,
            "archiveSha256",
        )?;
        let staged_memory = unpacked.join(MEMORY_PAYLOAD_ROOT);
        let staged_fingerprint = fingerprint_tree(&staged_memory)?;
        let manifest_fingerprint = fingerprint_from_manifest(&archive.manifest)?;
        if staged_fingerprint != manifest_fingerprint {
            return Err("解包 Memory 树与 manifest fingerprint 不一致".into());
        }
        let (commit_revision, _) = stable_target_revision(&paths.memory_dir)?;
        same_expected(&commit_revision, expected_target_revision, "targetRevision")?;

        let old = match std::fs::symlink_metadata(&paths.memory_dir) {
            Ok(_) => {
                let metadata = reject_link_or_reparse(&paths.memory_dir)?;
                if !metadata.is_dir() {
                    return Err("提交前目标 memory 不再是普通目录".into());
                }
                let old = unique_sibling(&paths.storage_dir, ".htybox-old-")?;
                std::fs::rename(&paths.memory_dir, &old).map_err(|error| {
                    format!(
                        "移动旧 Memory 到 backup 失败 {} -> {}：{error}",
                        paths.memory_dir.display(),
                        old.display()
                    )
                })?;
                let moved_revision = match fingerprint_tree(&old) {
                    Ok(fingerprint) => fingerprint.digest,
                    Err(inspect_error) => {
                        if let Err(restore_error) = std::fs::rename(&old, &paths.memory_dir) {
                            return Err(format!(
                                "检查已移动旧 Memory 失败且恢复失败：target={} old={} inspect={inspect_error} restore={restore_error}",
                                paths.memory_dir.display(),
                                old.display()
                            ));
                        }
                        return Err(format!(
                            "检查已移动旧 Memory 失败，已恢复原目录：{inspect_error}"
                        ));
                    }
                };
                if moved_revision != expected_target_revision {
                    if let Err(error) = std::fs::rename(&old, &paths.memory_dir) {
                        return Err(format!(
                            "旧 Memory 在 commit 窗口发生变化且恢复失败：target={} old={} error={error}",
                            paths.memory_dir.display(),
                            old.display()
                        ));
                    }
                    return Err("targetRevision 在最终 rename 窗口发生变化，请重新 inspect".into());
                }
                Some(old)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if expected_target_revision != ABSENT_TARGET_REVISION {
                    return Err("targetRevision 在最终 rename 窗口变为 absent".into());
                }
                None
            }
            Err(error) => return Err(format!("提交前检查目标 Memory 失败：{error}")),
        };
        let mut new_installed = false;
        let commit: Result<(), String> = (|| {
            maybe_fault(fault, ImportFault::AfterOldMoved, "旧 Memory 移走后")?;
            maybe_fault(fault, ImportFault::BeforeNewInstall, "新 Memory 安装前")?;
            if fault == ImportFault::RecreateExternalBeforeNewInstall {
                std::fs::create_dir(&paths.memory_dir)
                    .map_err(|error| format!("测试外部重建 Memory 失败：{error}"))?;
                std::fs::write(paths.memory_dir.join("external.txt"), b"external")
                    .map_err(|error| error.to_string())?;
                return Err("测试故障注入：外部在提交窗口重建 memory".into());
            }
            std::fs::rename(&staged_memory, &paths.memory_dir).map_err(|error| {
                format!(
                    "安装新 Memory 失败 {} -> {}：{error}",
                    staged_memory.display(),
                    paths.memory_dir.display()
                )
            })?;
            new_installed = true;
            maybe_fault(fault, ImportFault::AfterNewInstall, "新 Memory 安装后")?;
            if fault == ImportFault::TamperAfterNewInstall {
                std::fs::write(
                    paths.memory_dir.join("tampered-after-install.txt"),
                    b"tampered",
                )
                .map_err(|error| error.to_string())?;
                return Err("测试故障注入：原目标 absent 且安装后被外部篡改".into());
            }
            let installed = fingerprint_tree(&paths.memory_dir)?;
            if installed != manifest_fingerprint {
                return Err("安装后的 Memory fingerprint 与包不一致".into());
            }
            Ok(())
        })();
        if let Err(error) = commit {
            return match rollback_replace(
                &paths.storage_dir,
                &paths.memory_dir,
                old.as_deref(),
                new_installed,
                &manifest_fingerprint.digest,
                stage.path(),
            ) {
                Ok(report) => Err(format!(
                    "{error}{}",
                    report
                        .conflict_path
                        .map(|path| format!("；外部冲突已保全：{}", path.display()))
                        .unwrap_or_default()
                )),
                Err(rollback) => Err(format!("{error}；并且回滚失败：{rollback}")),
            };
        }

        let mut warnings = memory_warnings();
        let mut retained_backup_path = None;
        if let Some(old) = old {
            if fault == ImportFault::MutateOldBeforeCleanup {
                std::fs::write(old.join("mutated-before-cleanup.txt"), b"external")
                    .map_err(|error| error.to_string())?;
            }
            let cleanup_result = (|| {
                let metadata = reject_link_or_reparse(&old)?;
                if !metadata.is_dir() {
                    return Err("旧 Memory backup 不再是普通目录".to_string());
                }
                let revision = fingerprint_tree(&old)?.digest;
                if revision != expected_target_revision {
                    return Err("旧 Memory backup revision 在清理前发生变化".to_string());
                }
                backup_cleaner(&old)
            })();
            if let Err(error) = cleanup_result {
                warnings.push(format!(
                    "新 Memory 已提交，但旧快照未清理并保留：{}（{error}）",
                    old.display()
                ));
                retained_backup_path = Some(old.to_string_lossy().into_owned());
            }
        }
        Ok(MemoryImportResult {
            status: "imported".into(),
            target_path: paths.memory_dir.to_string_lossy().into_owned(),
            file_count: archive.file_count,
            directory_count: archive.directory_count,
            total_bytes: archive.total_bytes,
            warnings,
            retained_backup_path,
        })
    })();
    if result.is_err() {
        if let Err(cleanup) = cleanup_created_dirs(home, &created_dirs) {
            return match result {
                Err(error) => Err(format!("{error}；清理本轮父目录失败：{cleanup}")),
                Ok(_) => unreachable!(),
            };
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portable_archive::{MemoryManifest, PackageSource};
    use std::fs;
    use std::sync::Mutex as TestMutex;
    use zip::{CompressionMethod, ZipArchive};

    struct Fixture {
        _root: TempDir,
        home: PathBuf,
        source_workspace: PathBuf,
        target_workspace: PathBuf,
        output: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().expect("fixture tempdir");
            let home = root.path().join("home");
            let source_workspace = root.path().join("Source_Workspace");
            let target_workspace = root.path().join("Target_Workspace");
            let output = root.path().join("output");
            for path in [&home, &source_workspace, &target_workspace, &output] {
                fs::create_dir(path).expect("create fixture directory");
            }
            Self {
                _root: root,
                home,
                source_workspace,
                target_workspace,
                output,
            }
        }

        fn text(&self, path: &Path) -> String {
            path.to_string_lossy().into_owned()
        }

        fn storage(&self, workspace: &Path) -> PathBuf {
            self.home
                .join(".claude/projects")
                .join(crate::catalog::claude_project_slug(&self.text(workspace)).unwrap())
        }

        fn memory(&self, workspace: &Path) -> PathBuf {
            self.storage(workspace).join("memory")
        }

        fn seed_source(&self) -> PathBuf {
            let memory = self.memory(&self.source_workspace);
            fs::create_dir_all(memory.join("group/nested")).unwrap();
            fs::create_dir_all(memory.join("empty")).unwrap();
            fs::create_dir_all(memory.join("Unicode-分组")).unwrap();
            fs::write(memory.join("MEMORY.md"), b"# root\n").unwrap();
            fs::write(memory.join("index_main.md"), b"index\n").unwrap();
            fs::write(memory.join("group/index.md"), b"group index\n").unwrap();
            fs::write(memory.join("group/nested/topic.md"), b"nested topic\n").unwrap();
            fs::write(memory.join("Unicode-分组/主题.md"), "你好\n".as_bytes()).unwrap();
            fs::write(memory.join("blob.bin"), [0xff, 0x00, 0xfe, 0x80]).unwrap();
            // Stored is required so a valid highly-compressible file is not
            // rejected by the generic anti-zip-bomb ratio.
            fs::write(memory.join("zeros.bin"), vec![0u8; 2 * 1024 * 1024]).unwrap();
            memory
        }

        fn export(&self) -> PathBuf {
            let destination = self.output.join("snapshot");
            export_memory_archive_in(&self.home, &self.text(&self.source_workspace), &destination)
                .expect("export memory")
                .path
                .into()
        }

        fn inspect(&self, archive: &Path) -> MemoryImportPreview {
            inspect_memory_archive_in(&self.home, &self.text(&self.target_workspace), archive)
                .expect("inspect memory")
        }

        fn import_with(
            &self,
            archive: &Path,
            preview: &MemoryImportPreview,
            fault: ImportFault,
            cleaner: &dyn Fn(&Path) -> Result<(), String>,
        ) -> Result<MemoryImportResult, String> {
            import_memory_archive_in(
                &self.home,
                &self.text(&self.target_workspace),
                archive,
                &preview.archive_sha256,
                &preview.target_revision,
                fault,
                cleaner,
            )
        }
    }

    fn remove_backup(path: &Path) -> Result<(), String> {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    }

    #[test]
    fn full_tree_roundtrip_preserves_nested_empty_unicode_binary_and_stored_bytes() {
        let fixture = Fixture::new();
        let source = fixture.seed_source();
        let archive = fixture.export();
        let file = File::open(&archive).unwrap();
        let mut zip = ZipArchive::new(file).unwrap();
        for index in 0..zip.len() {
            let entry = zip.by_index_raw(index).unwrap();
            assert_eq!(entry.compression(), CompressionMethod::Stored);
        }
        let preview = fixture.inspect(&archive);
        assert_eq!(preview.target_revision, ABSENT_TARGET_REVISION);
        assert!(!preview.target_non_empty);
        assert!(!fixture.storage(&fixture.target_workspace).exists());
        let result = fixture
            .import_with(&archive, &preview, ImportFault::None, &remove_backup)
            .expect("import memory");
        assert_eq!(result.status, "imported");
        assert_eq!(
            fingerprint_tree(&source).unwrap(),
            fingerprint_tree(&fixture.memory(&fixture.target_workspace)).unwrap()
        );
        assert!(fixture
            .memory(&fixture.target_workspace)
            .join("empty")
            .is_dir());
        assert_eq!(
            fs::read(fixture.memory(&fixture.target_workspace).join("blob.bin")).unwrap(),
            [0xff, 0x00, 0xfe, 0x80]
        );
        assert!(result.retained_backup_path.is_none());
    }

    #[test]
    fn nonempty_target_is_replaced_and_backup_cleaner_receives_old_snapshot() {
        let fixture = Fixture::new();
        fixture.seed_source();
        let archive = fixture.export();
        let target = fixture.memory(&fixture.target_workspace);
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("old.txt"), b"old").unwrap();
        let preview = fixture.inspect(&archive);
        assert!(preview.target_non_empty);
        let cleaned = TestMutex::new(Vec::new());
        let cleaner = |path: &Path| {
            cleaned.lock().unwrap().push(path.to_path_buf());
            remove_backup(path)
        };
        let result = fixture
            .import_with(&archive, &preview, ImportFault::None, &cleaner)
            .expect("replace target");
        assert!(!target.join("old.txt").exists());
        assert!(target.join("MEMORY.md").is_file());
        assert_eq!(cleaned.lock().unwrap().len(), 1);
        assert!(result.retained_backup_path.is_none());
    }

    #[test]
    fn backup_cleaner_failure_is_success_with_precise_retained_path_warning() {
        let fixture = Fixture::new();
        fixture.seed_source();
        let archive = fixture.export();
        let target = fixture.memory(&fixture.target_workspace);
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("old.txt"), b"old").unwrap();
        let preview = fixture.inspect(&archive);
        let result = fixture
            .import_with(&archive, &preview, ImportFault::None, &|_| {
                Err("trash unavailable".into())
            })
            .expect("cleanup failure must not undo successful commit");
        let retained = PathBuf::from(result.retained_backup_path.expect("retained path"));
        assert!(retained.is_dir());
        assert!(retained.join("old.txt").is_file());
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains(&retained.to_string_lossy().to_string())));
    }

    #[test]
    fn all_commit_fault_points_restore_old_tree_without_half_snapshot() {
        for fault in [
            ImportFault::AfterOldMoved,
            ImportFault::BeforeNewInstall,
            ImportFault::AfterNewInstall,
        ] {
            let fixture = Fixture::new();
            fixture.seed_source();
            let archive = fixture.export();
            let target = fixture.memory(&fixture.target_workspace);
            fs::create_dir_all(target.join("old-empty")).unwrap();
            fs::write(target.join("old.txt"), b"old").unwrap();
            let before = fingerprint_tree(&target).unwrap();
            let preview = fixture.inspect(&archive);
            let error = fixture
                .import_with(&archive, &preview, fault, &remove_backup)
                .expect_err("fault must fail import");
            assert!(error.contains("测试故障注入"));
            assert_eq!(fingerprint_tree(&target).unwrap(), before);
            let storage = fixture.storage(&fixture.target_workspace);
            assert!(fs::read_dir(storage).unwrap().all(|item| {
                let name = item.unwrap().file_name().to_string_lossy().into_owned();
                name == "memory" || !name.starts_with(".htybox-")
            }));
        }
    }

    #[test]
    fn external_recreation_is_preserved_as_conflict_before_old_is_restored() {
        let fixture = Fixture::new();
        fixture.seed_source();
        let archive = fixture.export();
        let target = fixture.memory(&fixture.target_workspace);
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("old.txt"), b"old").unwrap();
        let preview = fixture.inspect(&archive);
        let error = fixture
            .import_with(
                &archive,
                &preview,
                ImportFault::RecreateExternalBeforeNewInstall,
                &remove_backup,
            )
            .expect_err("external conflict fixture must fail");
        assert!(target.join("old.txt").is_file());
        assert!(error.contains("外部冲突已保全"));
        let conflict = fs::read_dir(fixture.storage(&fixture.target_workspace))
            .unwrap()
            .map(|item| item.unwrap().path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(".htybox-conflict-"))
            })
            .expect("conflict backup");
        assert_eq!(
            fs::read(conflict.join("external.txt")).unwrap(),
            b"external"
        );
    }

    #[test]
    fn stale_target_revision_rejects_without_mutation() {
        let fixture = Fixture::new();
        fixture.seed_source();
        let archive = fixture.export();
        let target = fixture.memory(&fixture.target_workspace);
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("old.txt"), b"old").unwrap();
        let preview = fixture.inspect(&archive);
        fs::write(target.join("concurrent.txt"), b"change").unwrap();
        let before = fingerprint_tree(&target).unwrap();
        let error = fixture
            .import_with(&archive, &preview, ImportFault::None, &remove_backup)
            .expect_err("stale revision must fail");
        assert!(error.contains("targetRevision"));
        assert_eq!(fingerprint_tree(&target).unwrap(), before);
    }

    #[test]
    fn archive_inside_source_or_replace_target_is_rejected() {
        let fixture = Fixture::new();
        let source = fixture.seed_source();
        let error = export_memory_archive_in(
            &fixture.home,
            &fixture.text(&fixture.source_workspace),
            &source.join("nested-export"),
        )
        .expect_err("export inside source must fail");
        assert!(error.contains("源 memory"));

        let archive = fixture.export();
        let target = fixture.memory(&fixture.target_workspace);
        fs::create_dir_all(&target).unwrap();
        let inside = target.join("inside.htybox-memory");
        fs::copy(&archive, &inside).unwrap();
        let error = inspect_memory_archive_in(
            &fixture.home,
            &fixture.text(&fixture.target_workspace),
            &inside,
        )
        .expect_err("archive inside target must fail");
        assert!(error.contains("整体替换"));
    }

    #[test]
    fn business_closure_rejects_extra_or_parentless_payload_and_slug_case_is_compatible() {
        let fixture = Fixture::new();
        let workspace = fixture.text(&fixture.source_workspace);
        let expected_slug = crate::catalog::claude_project_slug(&workspace).unwrap();
        let case_variant = expected_slug.to_uppercase();
        let manifest = PortableManifest::Memory(MemoryManifest {
            version: PACKAGE_VERSION,
            kind: PackageKind::Memory,
            agent: ArchiveAgent::Claude,
            source_workspace: workspace,
            source_slug: case_variant,
            source_agent_version: CLAUDE_MEMORY_VERSION_SENTINEL.into(),
            source_schema_version: CLAUDE_MEMORY_SCHEMA.into(),
            exported_at_ms: 1,
            capabilities: vec![ArchiveCapability::FullTree],
            entries: Vec::new(),
        });
        let malformed = crate::portable_archive::write_package(
            &fixture.output.join("malformed"),
            MEMORY_EXTENSION,
            manifest,
            vec![
                PackageSource::Directory {
                    archive_path: MEMORY_PAYLOAD_ROOT.into(),
                },
                PackageSource::Bytes {
                    archive_path: format!("{MEMORY_PAYLOAD_ROOT}/missing/file.bin"),
                    data: b"x".to_vec(),
                },
            ],
            ArchiveLimits::memory(),
        )
        .unwrap()
        .path;
        let error = inspect_memory_archive_in(
            &fixture.home,
            &fixture.text(&fixture.target_workspace),
            &malformed,
        )
        .expect_err("parentless payload must fail business closure");
        assert!(error.contains("显式父目录"));
    }

    #[test]
    fn existing_empty_target_differs_from_absent_but_needs_no_danger_confirmation() {
        let fixture = Fixture::new();
        fixture.seed_source();
        let archive = fixture.export();
        let target = fixture.memory(&fixture.target_workspace);
        fs::create_dir_all(&target).unwrap();
        let preview = fixture.inspect(&archive);
        assert!(!preview.target_non_empty);
        assert_ne!(preview.target_revision, ABSENT_TARGET_REVISION);
    }

    #[test]
    fn missing_memory_export_fails_without_creating_claude_directories() {
        let fixture = Fixture::new();
        let error = export_memory_archive_in(
            &fixture.home,
            &fixture.text(&fixture.source_workspace),
            &fixture.output.join("missing"),
        )
        .expect_err("missing memory must fail");
        assert!(error.contains("尚无"));
        assert!(!fixture.home.join(".claude").exists());
    }

    #[test]
    fn archive_changed_after_inspect_is_rejected_without_target_side_effects() {
        let fixture = Fixture::new();
        fixture.seed_source();
        let archive = fixture.export();
        let preview = fixture.inspect(&archive);
        fs::write(
            fixture
                .memory(&fixture.source_workspace)
                .join("new-after-inspect.md"),
            b"changed",
        )
        .unwrap();
        let replacement = export_memory_archive_in(
            &fixture.home,
            &fixture.text(&fixture.source_workspace),
            &fixture.output.join("replacement"),
        )
        .unwrap()
        .path;
        fs::copy(replacement, &archive).unwrap();
        let error = fixture
            .import_with(&archive, &preview, ImportFault::None, &remove_backup)
            .expect_err("changed archive hash must fail");
        assert!(error.contains("archiveSha256"));
        assert!(!fixture.storage(&fixture.target_workspace).exists());
    }

    #[test]
    fn absent_target_tampered_after_install_is_moved_to_conflict_and_target_returns_absent() {
        let fixture = Fixture::new();
        fixture.seed_source();
        let archive = fixture.export();
        let preview = fixture.inspect(&archive);
        assert_eq!(preview.target_revision, ABSENT_TARGET_REVISION);
        let error = fixture
            .import_with(
                &archive,
                &preview,
                ImportFault::TamperAfterNewInstall,
                &remove_backup,
            )
            .expect_err("tampered installed tree must roll back to absent");
        let target = fixture.memory(&fixture.target_workspace);
        assert!(!target.exists());
        assert!(error.contains("外部冲突已保全"));
        let conflict = fs::read_dir(fixture.storage(&fixture.target_workspace))
            .unwrap()
            .map(|item| item.unwrap().path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(".htybox-conflict-"))
            })
            .expect("tampered conflict retained");
        assert!(conflict.join("tampered-after-install.txt").is_file());
        assert!(conflict.join("MEMORY.md").is_file());
    }

    #[test]
    fn changed_old_backup_is_retained_without_calling_cleaner() {
        let fixture = Fixture::new();
        fixture.seed_source();
        let archive = fixture.export();
        let target = fixture.memory(&fixture.target_workspace);
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("old.txt"), b"old").unwrap();
        let preview = fixture.inspect(&archive);
        let cleaner_calls = TestMutex::new(0usize);
        let result = fixture
            .import_with(
                &archive,
                &preview,
                ImportFault::MutateOldBeforeCleanup,
                &|_| {
                    *cleaner_calls.lock().unwrap() += 1;
                    Ok(())
                },
            )
            .expect("new snapshot stays committed while changed backup is retained");
        assert_eq!(*cleaner_calls.lock().unwrap(), 0);
        let retained = PathBuf::from(result.retained_backup_path.expect("retained backup"));
        assert!(retained.join("old.txt").is_file());
        assert!(retained.join("mutated-before-cleanup.txt").is_file());
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("revision 在清理前发生变化")));
        assert!(target.join("MEMORY.md").is_file());
    }

    #[test]
    fn closed_manifest_rejects_payload_other_even_when_zip_is_otherwise_valid() {
        let fixture = Fixture::new();
        let workspace = fixture.text(&fixture.source_workspace);
        let manifest = PortableManifest::Memory(MemoryManifest {
            version: PACKAGE_VERSION,
            kind: PackageKind::Memory,
            agent: ArchiveAgent::Claude,
            source_workspace: workspace.clone(),
            source_slug: crate::catalog::claude_project_slug(&workspace).unwrap(),
            source_agent_version: CLAUDE_MEMORY_VERSION_SENTINEL.into(),
            source_schema_version: CLAUDE_MEMORY_SCHEMA.into(),
            exported_at_ms: 1,
            capabilities: vec![ArchiveCapability::FullTree],
            entries: Vec::new(),
        });
        let archive = crate::portable_archive::write_package(
            &fixture.output.join("outside-closure"),
            MEMORY_EXTENSION,
            manifest,
            vec![
                PackageSource::Directory {
                    archive_path: MEMORY_PAYLOAD_ROOT.into(),
                },
                PackageSource::Directory {
                    archive_path: "payload/other".into(),
                },
            ],
            ArchiveLimits::memory(),
        )
        .unwrap()
        .path;
        let error = inspect_memory_archive_in(
            &fixture.home,
            &fixture.text(&fixture.target_workspace),
            &archive,
        )
        .expect_err("payload/other must fail business closure");
        assert!(error.contains("闭包外"));
    }

    #[test]
    fn exporter_reuses_case_variant_native_bucket_and_its_package_inspects() {
        let fixture = Fixture::new();
        let expected =
            crate::catalog::claude_project_slug(&fixture.text(&fixture.source_workspace)).unwrap();
        let actual = expected.to_uppercase();
        let memory = fixture
            .home
            .join(".claude/projects")
            .join(&actual)
            .join("memory");
        fs::create_dir_all(&memory).unwrap();
        fs::write(memory.join("MEMORY.md"), b"case bucket").unwrap();
        let archive = export_memory_archive_in(
            &fixture.home,
            &fixture.text(&fixture.source_workspace),
            &fixture.output.join("case-bucket"),
        )
        .expect("export case-variant bucket")
        .path;
        let validated =
            validate_archive_stable(Path::new(&archive)).expect("inspect exported package");
        assert_eq!(validated.manifest.source_slug, actual);
    }

    #[test]
    fn continuously_mutating_source_exhausts_three_stability_attempts() {
        let fixture = Fixture::new();
        let memory = fixture.seed_source();
        let changing = memory.join("changing.bin");
        fs::write(&changing, b"start").unwrap();
        let attempts = TestMutex::new(0usize);
        let error = stable_source_snapshot_with_hook(
            &memory,
            &fixture.storage(&fixture.source_workspace),
            &mut |_, _| {
                *attempts.lock().unwrap() += 1;
                OpenOptions::new()
                    .append(true)
                    .open(&changing)
                    .unwrap()
                    .write_all(b"x")
                    .unwrap();
            },
        )
        .expect_err("continually changing tree must not produce a package snapshot");
        assert!(error.contains("连续 3 次"));
        assert_eq!(*attempts.lock().unwrap(), STABLE_ATTEMPTS);
    }
}
