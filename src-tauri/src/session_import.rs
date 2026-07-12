//! Strict, idempotent import of one portable Claude, Codex, or Cursor session.
//!
//! The archive layer establishes the ZIP/manifest boundary.  This module adds
//! the Agent-specific closed-world checks, a cwd-independent payload identity,
//! staging/commit/rollback, and native-index repair needed for a real resume.

use crate::portable_archive::{
    extract_package, reject_link_or_reparse, ArchiveAgent, ArchiveCapability, ArchiveEntryKind,
    ArchiveLimits, PortableManifest, SessionManifest, SESSION_FORMAT,
};
use crate::session_transfer::{
    backup_cursor_database, CLAUDE_HISTORY_ENTRY, CLAUDE_SUBAGENTS_ROOT, CLAUDE_TASKS_ROOT,
    CLAUDE_TOOL_RESULTS_ROOT, CLAUDE_TRANSCRIPT_ENTRY, CODEX_ROLLOUT_ENTRY, CURSOR_META_ENTRY,
    CURSOR_PROMPT_HISTORY_ENTRY, CURSOR_STORE_DB_ENTRY,
};
use crate::sessions::{
    cursor_bucket, list_claude_sessions_in, list_codex_sessions_in, list_cursor_sessions_in,
    locate_claude_session_in, locate_codex_session_in, locate_cursor_session_in,
    validate_codex_relative_path, validate_session_id, CLAUDE_SESSION_SCHEMA, CODEX_SESSION_SCHEMA,
    CURSOR_SESSION_SCHEMA,
};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::TempDir;
use walkdir::WalkDir;

const MAX_JSONL_LINE_BYTES: usize = 16 * 1024 * 1024;
const MAX_SMALL_JSON_BYTES: u64 = 4 * 1024 * 1024;
const MAX_NATIVE_INDEX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PENDING_APPEND_BYTES: usize = 32 * 1024 * 1024;
const MAX_PENDING_APPEND_LINES: usize = 100_000;
const MAX_EXISTING_SCAN_ENTRIES: usize = 100_000;
const HASH_CWD_SENTINEL: &str = "\u{1f}htybox-canonical-cwd-v1\u{1f}";

static SESSION_IMPORT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionImportResult {
    pub agent: String,
    pub id: String,
    pub label: Option<String>,
    pub status: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportFault {
    None,
    AfterPayloadCommit,
    BeforeIndexAppend,
    DuringIndexAppend,
    PartialAppendRollbackSyncFailure,
    PartialAppendRollbackRecoverySyncFailure,
    AfterIndexWriteBeforeSync,
    AfterIndexAppend,
    RollbackIndexSyncFailure,
    BeforeVisibilityCheck,
}

struct ImportContext<'a> {
    home: &'a Path,
    target_cwd: &'a str,
    fault: ImportFault,
}

#[derive(Debug, Clone)]
struct HashItem {
    archive_path: String,
    kind: ArchiveEntryKind,
    source: Option<PathBuf>,
}

#[derive(Debug)]
struct PreparedArchive {
    manifest: SessionManifest,
    extracted: PathBuf,
    canonical_hash: String,
}

#[derive(Debug)]
struct AppendReceipt {
    path: PathBuf,
    original_len: u64,
    original_sha256: [u8; 32],
    appended: Vec<u8>,
    inject_rollback_sync_failure: bool,
    inject_rollback_recovery_sync_failure: bool,
}

#[derive(Debug)]
enum AppendRollbackOutcome {
    RolledBack,
    RestoredVisible(String),
    UncertainAfterTruncate(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IndexSnapshot {
    existed: bool,
    len: u64,
    sha256: [u8; 32],
}

#[derive(Debug)]
struct PendingAppend {
    path: PathBuf,
    bytes: Vec<u8>,
    expected: IndexSnapshot,
}

#[derive(Debug)]
struct CommittedPath {
    path: PathBuf,
    fingerprint: String,
}

#[derive(Debug, Default)]
struct CommitReceipt {
    paths: Vec<CommittedPath>,
    created_dirs: Vec<PathBuf>,
    append: Option<AppendReceipt>,
}

pub fn import_session_archive(
    archive_path: &str,
    target_cwd: &str,
    target_project_dir: &str,
) -> Result<SessionImportResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户 home 目录".to_string())?;
    import_session_archive_in(
        &home,
        Path::new(archive_path),
        target_cwd,
        target_project_dir,
        ImportFault::None,
    )
}

fn import_session_archive_in(
    home: &Path,
    archive_path: &Path,
    target_cwd: &str,
    target_project_dir: &str,
    fault: ImportFault,
) -> Result<SessionImportResult, String> {
    let lock = SESSION_IMPORT_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "Session 导入互斥锁已中毒，请重启 HtyBox".to_string())?;
    let target_anchor = validate_target_identity(home, target_cwd, target_project_dir)?;
    let context = ImportContext {
        home,
        target_cwd: &target_anchor,
        fault,
    };

    // The first pass is read-only.  No Agent directory is created until the
    // strict archive and the complete Agent business closure both pass.
    let manifest = crate::portable_archive::validate_package(
        archive_path,
        Some(SESSION_FORMAT),
        ArchiveLimits::session(),
    )?;
    let PortableManifest::Session(preflight_manifest) = manifest else {
        return Err("包不是 Session 包".into());
    };
    validate_manifest_business(&preflight_manifest)?;

    let home_metadata = reject_link_or_reparse(home)?;
    if !home_metadata.is_dir() {
        return Err("用户 home 不是普通目录".into());
    }
    let workdir = tempfile::Builder::new()
        .prefix(".htybox-session-import-")
        .tempdir_in(home)
        .map_err(|error| format!("在 home 同卷创建 Session 导入 staging 失败：{error}"))?;
    let extracted = workdir.path().join("package");
    let extracted_manifest = extract_package(
        archive_path,
        &extracted,
        Some(SESSION_FORMAT),
        ArchiveLimits::session(),
    )?;
    let PortableManifest::Session(manifest) = extracted_manifest else {
        return Err("解包结果不是 Session 包".into());
    };
    if manifest != preflight_manifest {
        return Err("两次包预检得到不同 manifest，拒绝 TOCTOU 导入".into());
    }
    let prepared = prepare_archive(manifest, extracted)?;

    if let Some(existing) =
        find_existing_session(home, prepared.manifest.agent, &prepared.manifest.session_id)?
    {
        let existing_hash = canonical_hash_existing(
            home,
            prepared.manifest.agent,
            &prepared.manifest.session_id,
            &existing,
            workdir.path(),
        )?;
        if existing_hash == prepared.canonical_hash {
            return Ok(SessionImportResult {
                agent: agent_name(prepared.manifest.agent).into(),
                id: prepared.manifest.session_id,
                label: prepared.manifest.label,
                status: "alreadyPresent".into(),
                warnings: vec![
                    "同一 Agent 已存在相同 Session payload；未覆盖，也未在另一工作区创建副本。"
                        .into(),
                ],
            });
        }
        return Err(format!(
            "{} 已存在相同 Session ID 但 payload 不同，已拒绝覆盖（existing={} incoming={}）",
            agent_name(prepared.manifest.agent),
            existing_hash,
            prepared.canonical_hash
        ));
    }

    let result = commit_prepared(&context, prepared, &workdir);
    result
}

fn validate_target_identity(
    home: &Path,
    target_cwd: &str,
    target_project_dir: &str,
) -> Result<String, String> {
    reject_plain_absolute_path(Path::new(target_cwd), "targetCwd")?;
    reject_plain_absolute_path(Path::new(target_project_dir), "targetProjectDir")?;
    let home_meta = reject_link_or_reparse(home)?;
    if !home_meta.is_dir() {
        return Err("用户 home 必须是现存普通目录".into());
    }
    let cwd_meta = reject_link_or_reparse(Path::new(target_cwd))?;
    let project_meta = reject_link_or_reparse(Path::new(target_project_dir))?;
    if !cwd_meta.is_dir() || !project_meta.is_dir() {
        return Err("targetCwd 与 targetProjectDir 必须是现存普通目录".into());
    }
    let cwd = Path::new(target_cwd)
        .canonicalize()
        .map_err(|error| format!("解析 targetCwd 失败：{error}"))?;
    let project = Path::new(target_project_dir)
        .canonicalize()
        .map_err(|error| format!("解析 targetProjectDir 失败：{error}"))?;
    if cwd != project {
        return Err("targetCwd 与 targetProjectDir 必须指向同一规范工作区".into());
    }
    canonical_workspace_anchor(&cwd)
}

fn canonical_workspace_anchor(canonical: &Path) -> Result<String, String> {
    let value = canonical
        .to_str()
        .ok_or_else(|| "规范工作区路径不是 UTF-8".to_string())?;
    #[cfg(windows)]
    let value = if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(value).to_string()
    };
    #[cfg(not(windows))]
    let value = value.to_string();
    stable_workspace_anchor(&value)
}

fn stable_workspace_anchor(value: &str) -> Result<String, String> {
    #[cfg(windows)]
    let mut anchor = value.replace('/', "\\");
    #[cfg(not(windows))]
    let mut anchor = value.to_string();
    while anchor.ends_with('/') || anchor.ends_with('\\') {
        let candidate = &anchor[..anchor.len() - 1];
        if candidate.is_empty() || !Path::new(candidate).is_absolute() {
            break;
        }
        anchor.pop();
    }
    if anchor.is_empty() || !Path::new(&anchor).is_absolute() {
        return Err("targetCwd 无法形成稳定绝对路径 anchor".into());
    }
    Ok(anchor)
}

fn workspace_text_matches(value: &str, anchor: &str) -> bool {
    #[cfg(windows)]
    {
        fn normalize(value: &str) -> String {
            let mut normalized = value.replace('/', "\\");
            while normalized.ends_with('\\') {
                let candidate = &normalized[..normalized.len() - 1];
                if candidate.is_empty() || !Path::new(candidate).is_absolute() {
                    break;
                }
                normalized.pop();
            }
            normalized
        }
        normalize(value).eq_ignore_ascii_case(&normalize(anchor))
    }
    #[cfg(not(windows))]
    {
        value == anchor
    }
}

fn reject_plain_absolute_path(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(format!("{label} 必须是无 . 或 .. 的绝对路径"));
    }
    Ok(())
}

fn validate_manifest_business(manifest: &SessionManifest) -> Result<(), String> {
    validate_session_id(&manifest.session_id)?;
    reject_plain_absolute_path(Path::new(&manifest.source_cwd), "manifest sourceCwd")?;
    let expected_schema = match manifest.agent {
        ArchiveAgent::Claude => CLAUDE_SESSION_SCHEMA,
        ArchiveAgent::Codex => CODEX_SESSION_SCHEMA,
        ArchiveAgent::Cursor => CURSOR_SESSION_SCHEMA,
    };
    if manifest.source_schema_version != expected_schema {
        return Err(format!(
            "不支持的 {} Session schema：{}",
            agent_name(manifest.agent),
            manifest.source_schema_version
        ));
    }
    validate_business_closure(manifest)
}

fn validate_business_closure(manifest: &SessionManifest) -> Result<(), String> {
    let entries: BTreeMap<_, _> = manifest
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry.kind))
        .collect();
    let caps: HashSet<_> = manifest.capabilities.iter().copied().collect();
    let require_file = |path: &str| match entries.get(path) {
        Some(ArchiveEntryKind::File) => Ok(()),
        _ => Err(format!("Session payload 缺少必需文件：{path}")),
    };
    let require_root = |path: &str| match entries.get(path) {
        Some(ArchiveEntryKind::Directory) => Ok(()),
        _ => Err(format!("Session capability 缺少目录根 entry：{path}")),
    };
    match manifest.agent {
        ArchiveAgent::Claude => {
            require_file(CLAUDE_TRANSCRIPT_ENTRY)?;
            require_file(CLAUDE_HISTORY_ENTRY)?;
            if manifest.native_relative_path.is_some() {
                return Err("Claude Session 不允许 nativeRelativePath".into());
            }
            for (capability, root) in [
                (ArchiveCapability::Subagents, CLAUDE_SUBAGENTS_ROOT),
                (ArchiveCapability::ToolResults, CLAUDE_TOOL_RESULTS_ROOT),
                (ArchiveCapability::Tasks, CLAUDE_TASKS_ROOT),
            ] {
                if caps.contains(&capability) {
                    require_root(root)?;
                }
            }
            for (path, kind) in &entries {
                let allowed = (*path == CLAUDE_TRANSCRIPT_ENTRY || *path == CLAUDE_HISTORY_ENTRY)
                    && *kind == ArchiveEntryKind::File
                    || [
                        (ArchiveCapability::Subagents, CLAUDE_SUBAGENTS_ROOT),
                        (ArchiveCapability::ToolResults, CLAUDE_TOOL_RESULTS_ROOT),
                        (ArchiveCapability::Tasks, CLAUDE_TASKS_ROOT),
                    ]
                    .iter()
                    .any(|(cap, root)| {
                        caps.contains(cap)
                            && (*path == *root || path.starts_with(&format!("{root}/")))
                    });
                if !allowed {
                    return Err(format!("Claude Session 含未声明业务 payload：{path}"));
                }
                for root in [
                    CLAUDE_SUBAGENTS_ROOT,
                    CLAUDE_TOOL_RESULTS_ROOT,
                    CLAUDE_TASKS_ROOT,
                ] {
                    if *path != root && path.starts_with(&format!("{root}/")) {
                        let mut parent = path.rsplit_once('/').map(|(parent, _)| parent);
                        while let Some(directory) = parent {
                            if entries.get(directory) != Some(&ArchiveEntryKind::Directory) {
                                return Err(format!(
                                    "Claude Session 子 entry 缺少显式父目录：{directory}"
                                ));
                            }
                            if directory == root {
                                break;
                            }
                            parent = directory.rsplit_once('/').map(|(next, _)| next);
                        }
                    }
                }
            }
        }
        ArchiveAgent::Codex => {
            require_file(CODEX_ROLLOUT_ENTRY)?;
            if entries.len() != 1 {
                return Err("Codex Session V1 只能包含一个 rollout 文件".into());
            }
            let relative = manifest
                .native_relative_path
                .as_deref()
                .ok_or_else(|| "Codex Session 缺少 nativeRelativePath".to_string())?;
            validate_codex_relative_path(Path::new(relative), &manifest.session_id)?;
            let has_title = caps.contains(&ArchiveCapability::NativeTitle);
            if has_title
                != manifest
                    .label
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
            {
                return Err("Codex NativeTitle capability 与 label 必须同时存在或同时缺失".into());
            }
        }
        ArchiveAgent::Cursor => {
            require_file(CURSOR_META_ENTRY)?;
            require_file(CURSOR_STORE_DB_ENTRY)?;
            if manifest.native_relative_path.is_some() {
                return Err("Cursor Session 不允许 nativeRelativePath".into());
            }
            let prompt = caps.contains(&ArchiveCapability::PromptHistory);
            if prompt {
                require_file(CURSOR_PROMPT_HISTORY_ENTRY)?;
            }
            let allowed: HashSet<&str> = if prompt {
                [
                    CURSOR_META_ENTRY,
                    CURSOR_STORE_DB_ENTRY,
                    CURSOR_PROMPT_HISTORY_ENTRY,
                ]
                .into_iter()
                .collect()
            } else {
                [CURSOR_META_ENTRY, CURSOR_STORE_DB_ENTRY]
                    .into_iter()
                    .collect()
            };
            if entries.len() != allowed.len()
                || entries
                    .iter()
                    .any(|(path, kind)| *kind != ArchiveEntryKind::File || !allowed.contains(path))
            {
                return Err("Cursor Session payload 闭包不完整或含额外 entry".into());
            }
        }
    }
    Ok(())
}

fn prepare_archive(
    manifest: SessionManifest,
    extracted: PathBuf,
) -> Result<PreparedArchive, String> {
    validate_manifest_business(&manifest)?;
    let items = manifest_items(&manifest, &extracted)?;
    validate_agent_payload(&manifest, &extracted)?;
    let canonical_hash = canonical_payload_hash(&manifest, &items)?;
    Ok(PreparedArchive {
        manifest,
        extracted,
        canonical_hash,
    })
}

fn manifest_items(manifest: &SessionManifest, root: &Path) -> Result<Vec<HashItem>, String> {
    manifest
        .entries
        .iter()
        .map(|entry| {
            let source = entry
                .path
                .split('/')
                .fold(root.to_path_buf(), |mut path, part| {
                    path.push(part);
                    path
                });
            let metadata = reject_link_or_reparse(&source)?;
            if (entry.kind == ArchiveEntryKind::File && !metadata.is_file())
                || (entry.kind == ArchiveEntryKind::Directory && !metadata.is_dir())
            {
                return Err(format!("Session staging entry 类型错误：{}", entry.path));
            }
            Ok(HashItem {
                archive_path: entry.path.clone(),
                kind: entry.kind,
                source: (entry.kind == ArchiveEntryKind::File).then_some(source),
            })
        })
        .collect()
}

fn agent_name(agent: ArchiveAgent) -> &'static str {
    match agent {
        ArchiveAgent::Claude => "claude",
        ArchiveAgent::Codex => "codex",
        ArchiveAgent::Cursor => "cursor",
    }
}

fn visit_jsonl(
    path: &Path,
    label: &str,
    mut visit: impl FnMut(usize, &mut Value) -> Result<(), String>,
) -> Result<usize, String> {
    let metadata = reject_link_or_reparse(path)?;
    if !metadata.is_file() {
        return Err(format!("{label} 不是普通文件"));
    }
    let file = File::open(path).map_err(|error| format!("打开 {label} 失败：{error}"))?;
    let mut reader = file.take(metadata.len());
    let mut pending = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    let mut count = 0usize;
    let mut total_read = 0u64;
    loop {
        let read = reader
            .read(&mut chunk)
            .map_err(|error| format!("读取 {label} 失败：{error}"))?;
        if read == 0 {
            break;
        }
        total_read = total_read
            .checked_add(read as u64)
            .ok_or_else(|| format!("{label} 读取计数溢出"))?;
        let mut start = 0usize;
        for (index, byte) in chunk[..read].iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            let segment = &chunk[start..index];
            if pending.len().saturating_add(segment.len()) > MAX_JSONL_LINE_BYTES {
                return Err(format!("{label} 单行超过 16 MiB"));
            }
            pending.extend_from_slice(segment);
            if pending.last() == Some(&b'\r') {
                pending.pop();
            }
            if pending.is_empty() {
                return Err(format!("{label} 含空行"));
            }
            let mut value: Value = serde_json::from_slice(&pending)
                .map_err(|error| format!("{label} 第 {} 行 JSON 无效：{error}", count + 1))?;
            if !value.is_object() {
                return Err(format!("{label} 第 {} 行根不是 object", count + 1));
            }
            visit(count, &mut value)?;
            count += 1;
            pending.clear();
            start = index + 1;
        }
        let tail = &chunk[start..read];
        if pending.len().saturating_add(tail.len()) > MAX_JSONL_LINE_BYTES {
            return Err(format!("{label} 单行超过 16 MiB"));
        }
        pending.extend_from_slice(tail);
    }
    if !pending.is_empty() {
        return Err(format!("{label} 含不完整尾行"));
    }
    if total_read != metadata.len() {
        return Err(format!("{label} 在固定长度读取中被截断"));
    }
    if count == 0 {
        return Err(format!("{label} 为空"));
    }
    Ok(count)
}

fn validate_agent_payload(manifest: &SessionManifest, root: &Path) -> Result<(), String> {
    match manifest.agent {
        ArchiveAgent::Claude => validate_claude_payload(manifest, root),
        ArchiveAgent::Codex => validate_codex_payload(manifest, root),
        ArchiveAgent::Cursor => validate_cursor_payload(manifest, root),
    }
}

fn validate_claude_payload(manifest: &SessionManifest, root: &Path) -> Result<(), String> {
    let transcript = root.join(CLAUDE_TRANSCRIPT_ENTRY);
    let mut authoritative = 0usize;
    let mut last_authoritative_version = None;
    visit_jsonl(&transcript, "Claude transcript", |_, value| {
        if value
            .get("sessionId")
            .is_some_and(|item| item.as_str() != Some(&manifest.session_id))
        {
            return Err("Claude transcript 内 sessionId 冲突".into());
        }
        if value.get("cwd").is_some_and(|item| !item.is_string()) {
            return Err("Claude transcript 顶层 cwd 必须是 string".into());
        }
        if matches!(
            value.get("type").and_then(Value::as_str),
            Some("user" | "assistant" | "system" | "attachment")
        ) && value.get("sessionId").and_then(Value::as_str) == Some(&manifest.session_id)
            && value
                .get("cwd")
                .and_then(Value::as_str)
                .is_some_and(|cwd| workspace_text_matches(cwd, &manifest.source_cwd))
        {
            authoritative += 1;
            if let Some(version) = value
                .get("version")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|version| !version.is_empty())
            {
                last_authoritative_version = Some(version.to_string());
            }
        }
        Ok(())
    })?;
    if authoritative == 0 {
        return Err("Claude transcript 缺少 sourceCwd 对应的权威正文".into());
    }
    if last_authoritative_version.as_deref() != Some(manifest.source_agent_version.as_str()) {
        return Err("Claude transcript 最后一条有效权威 version 与 manifest 不一致".into());
    }
    visit_jsonl(
        &root.join(CLAUDE_HISTORY_ENTRY),
        "Claude history",
        |_, value| {
            if value.get("sessionId").and_then(Value::as_str) != Some(&manifest.session_id) {
                return Err("Claude history 含其他 Session ID".into());
            }
            if !value
                .get("project")
                .and_then(Value::as_str)
                .is_some_and(|project| workspace_text_matches(project, &manifest.source_cwd))
            {
                return Err("Claude history project 必须与 manifest sourceCwd 语义一致".into());
            }
            Ok(())
        },
    )?;
    Ok(())
}

fn validate_codex_payload(manifest: &SessionManifest, root: &Path) -> Result<(), String> {
    visit_jsonl(
        &root.join(CODEX_ROLLOUT_ENTRY),
        "Codex rollout",
        |index, value| {
            let record_type = value.get("type").and_then(Value::as_str);
            if index == 0 {
                if record_type != Some("session_meta") {
                    return Err("Codex rollout 首行不是 session_meta".into());
                }
                let payload = value
                    .get("payload")
                    .and_then(Value::as_object)
                    .ok_or_else(|| "Codex session_meta 缺少 payload".to_string())?;
                if payload.get("id").and_then(Value::as_str) != Some(&manifest.session_id)
                    || !payload
                        .get("cwd")
                        .and_then(Value::as_str)
                        .is_some_and(|cwd| workspace_text_matches(cwd, &manifest.source_cwd))
                    || payload.get("cli_version").and_then(Value::as_str)
                        != Some(&manifest.source_agent_version)
                {
                    return Err("Codex session_meta 与 manifest 身份/cwd/version 不一致".into());
                }
            } else if record_type == Some("session_meta") {
                return Err("Codex rollout 只能在首行含 session_meta".into());
            }
            if record_type == Some("turn_context") {
                let payload = value
                    .get("payload")
                    .and_then(Value::as_object)
                    .ok_or_else(|| "Codex turn_context 缺少 payload".to_string())?;
                if payload
                    .get("cwd")
                    .is_some_and(|cwd| cwd.as_str().is_none_or(str::is_empty))
                {
                    return Err("Codex turn_context.payload.cwd 类型无效".into());
                }
            }
            Ok(())
        },
    )?;
    Ok(())
}

fn read_small_json(path: &Path, label: &str) -> Result<Value, String> {
    let metadata = reject_link_or_reparse(path)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_SMALL_JSON_BYTES {
        return Err(format!("{label} 为空、不是普通文件或超过 4 MiB"));
    }
    let bytes = std::fs::read(path).map_err(|error| format!("读取 {label} 失败：{error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{label} JSON 无效：{error}"))
}

fn validate_cursor_payload(manifest: &SessionManifest, root: &Path) -> Result<(), String> {
    let meta = read_small_json(&root.join(CURSOR_META_ENTRY), "Cursor meta.json")?;
    let object = meta
        .as_object()
        .ok_or_else(|| "Cursor meta.json 根必须是 object".to_string())?;
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || !object
            .get("cwd")
            .and_then(Value::as_str)
            .is_some_and(|cwd| workspace_text_matches(cwd, &manifest.source_cwd))
        || object
            .get("id")
            .is_some_and(|id| id.as_str() != Some(&manifest.session_id))
        || object.get("hasConversation").and_then(Value::as_bool) != Some(true)
    {
        return Err("Cursor meta.json schema/cwd/id/conversation 与 manifest 不一致".into());
    }
    for field in ["createdAtMs", "updatedAtMs"] {
        if object
            .get(field)
            .and_then(Value::as_i64)
            .is_none_or(|value| value < 0)
        {
            return Err(format!("Cursor meta.json {field} 必须是非负整数"));
        }
    }
    if object
        .get("title")
        .is_some_and(|title| !title.is_null() && !title.is_string())
    {
        return Err("Cursor meta.json title 类型无效".into());
    }
    let native_title = object
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty());
    if manifest.label.as_deref() != native_title {
        return Err("Cursor manifest label 与 meta.json title 不一致".into());
    }
    if manifest
        .capabilities
        .contains(&ArchiveCapability::PromptHistory)
    {
        let prompt = read_small_json(
            &root.join(CURSOR_PROMPT_HISTORY_ENTRY),
            "Cursor prompt_history.json",
        )?;
        if prompt
            .as_array()
            .is_none_or(|items| items.iter().any(|item| !item.is_string()))
        {
            return Err("Cursor prompt_history.json 必须是字符串数组".into());
        }
    }
    sqlite_integrity(&root.join(CURSOR_STORE_DB_ENTRY))
}

fn sqlite_integrity(path: &Path) -> Result<(), String> {
    let metadata = reject_link_or_reparse(path)?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("Cursor store.db 为空或不是普通文件".into());
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        if PathBuf::from(format!("{}{suffix}", path.to_string_lossy())).exists() {
            return Err("Cursor store.db staging 不允许 SQLite sidecar".into());
        }
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("只读打开 Cursor store.db 失败：{error}"))?;
    connection
        .execute_batch("PRAGMA query_only=ON;")
        .map_err(|error| format!("设置 Cursor DB query_only 失败：{error}"))?;
    let mut statement = connection
        .prepare("PRAGMA integrity_check")
        .map_err(|error| format!("准备 Cursor DB integrity_check 失败：{error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("执行 Cursor DB integrity_check 失败：{error}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取 Cursor DB integrity_check 失败：{error}"))?;
    if rows.as_slice() != ["ok"] {
        return Err(format!(
            "Cursor store.db integrity_check 失败：{}",
            rows.join("; ")
        ));
    }
    Ok(())
}

fn capability_name(capability: ArchiveCapability) -> &'static str {
    match capability {
        ArchiveCapability::FullTree => "full-tree",
        ArchiveCapability::Transcript => "transcript",
        ArchiveCapability::History => "history",
        ArchiveCapability::Subagents => "subagents",
        ArchiveCapability::ToolResults => "tool-results",
        ArchiveCapability::Tasks => "tasks",
        ArchiveCapability::Rollout => "rollout",
        ArchiveCapability::NativeTitle => "native-title",
        ArchiveCapability::Metadata => "metadata",
        ArchiveCapability::PromptHistory => "prompt-history",
        ArchiveCapability::StoreDb => "store-db",
    }
}

fn hash_frame(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_json).collect()),
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort_unstable();
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), canonicalize_json(&object[key]));
            }
            Value::Object(sorted)
        }
        value => value.clone(),
    }
}

fn replace_top_level(value: &mut Value, field: &str, anchor: &str, replacement: &str) {
    if let Some(object) = value.as_object_mut() {
        if object
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| workspace_text_matches(value, anchor))
        {
            object.insert(field.into(), Value::String(replacement.into()));
        }
    }
}

fn replace_workspace_top_level(value: &mut Value, field: &str, anchor: &str, replacement: &str) {
    if let Some(object) = value.as_object_mut() {
        if object
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| workspace_text_matches(value, anchor))
        {
            object.insert(field.into(), Value::String(replacement.into()));
        }
    }
}

fn replace_payload_field(value: &mut Value, field: &str, anchor: &str, replacement: &str) {
    if let Some(payload) = value.get_mut("payload").and_then(Value::as_object_mut) {
        if payload
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| workspace_text_matches(value, anchor))
        {
            payload.insert(field.into(), Value::String(replacement.into()));
        }
    }
}

fn hash_canonical_jsonl(
    hasher: &mut Sha256,
    path: &Path,
    manifest: &SessionManifest,
    archive_path: &str,
) -> Result<(), String> {
    visit_jsonl(path, "canonical JSONL", |index, value| {
        match manifest.agent {
            ArchiveAgent::Claude if archive_path == CLAUDE_TRANSCRIPT_ENTRY => {
                replace_workspace_top_level(value, "cwd", &manifest.source_cwd, HASH_CWD_SENTINEL);
            }
            ArchiveAgent::Claude if archive_path == CLAUDE_HISTORY_ENTRY => {
                replace_workspace_top_level(
                    value,
                    "project",
                    &manifest.source_cwd,
                    HASH_CWD_SENTINEL,
                );
            }
            ArchiveAgent::Codex => {
                let record_type = value.get("type").and_then(Value::as_str);
                if index == 0 && record_type == Some("session_meta")
                    || record_type == Some("turn_context")
                {
                    replace_payload_field(value, "cwd", &manifest.source_cwd, HASH_CWD_SENTINEL);
                }
            }
            _ => {}
        }
        let bytes = serde_json::to_vec(&canonicalize_json(value))
            .map_err(|error| format!("序列化 canonical JSON 失败：{error}"))?;
        hash_frame(hasher, &bytes);
        Ok(())
    })?;
    Ok(())
}

fn hash_json_file(
    hasher: &mut Sha256,
    path: &Path,
    manifest: &SessionManifest,
    replace_cwd: bool,
) -> Result<(), String> {
    let mut value = read_small_json(path, "canonical JSON")?;
    if replace_cwd {
        replace_top_level(&mut value, "cwd", &manifest.source_cwd, HASH_CWD_SENTINEL);
    }
    let bytes = serde_json::to_vec(&canonicalize_json(&value))
        .map_err(|error| format!("序列化 canonical JSON 失败：{error}"))?;
    hash_frame(hasher, &bytes);
    Ok(())
}

fn hash_raw_file(hasher: &mut Sha256, path: &Path) -> Result<(), String> {
    let metadata = reject_link_or_reparse(path)?;
    if !metadata.is_file() {
        return Err(format!("payload hash 来源不是普通文件：{}", path.display()));
    }
    hash_frame(hasher, &metadata.len().to_le_bytes());
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut remaining = metadata.len();
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let wanted = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let read = file
            .read(&mut buffer[..wanted])
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("payload hash 读取时文件被截断".into());
        }
        hasher.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(())
}

fn hash_canonical_sqlite_file(hasher: &mut Sha256, path: &Path) -> Result<(), String> {
    let metadata = reject_link_or_reparse(path)?;
    if !metadata.is_file() {
        return Err(format!(
            "SQLite payload hash 来源不是普通文件：{}",
            path.display()
        ));
    }
    hash_frame(hasher, &metadata.len().to_le_bytes());
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut remaining = metadata.len();
    let mut offset = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let wanted = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let read = file
            .read(&mut buffer[..wanted])
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("SQLite payload hash 读取时文件被截断".into());
        }
        for (index, byte) in buffer[..read].iter_mut().enumerate() {
            let absolute = offset + index as u64;
            // SQLite header change-counter and version-valid-for are volatile
            // transaction metadata. Online backups of the same logical DB can
            // differ only in these counters after a clean WAL/DELETE transition.
            if (24..28).contains(&absolute) || (92..96).contains(&absolute) {
                *byte = 0;
            }
        }
        hasher.update(&buffer[..read]);
        offset += read as u64;
        remaining -= read as u64;
    }
    Ok(())
}

fn canonical_payload_hash(
    manifest: &SessionManifest,
    items: &[HashItem],
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hash_frame(&mut hasher, b"htybox-session-payload-v1");
    hash_frame(&mut hasher, agent_name(manifest.agent).as_bytes());
    hash_frame(&mut hasher, manifest.session_id.as_bytes());
    hash_frame(&mut hasher, manifest.source_schema_version.as_bytes());
    let mut capabilities: Vec<_> = manifest
        .capabilities
        .iter()
        .map(|value| capability_name(*value))
        .collect();
    capabilities.sort_unstable();
    for capability in capabilities {
        hash_frame(&mut hasher, capability.as_bytes());
    }
    if manifest
        .capabilities
        .contains(&ArchiveCapability::NativeTitle)
    {
        hash_frame(
            &mut hasher,
            manifest.label.as_deref().unwrap_or_default().as_bytes(),
        );
    }
    hash_frame(
        &mut hasher,
        manifest
            .native_relative_path
            .as_deref()
            .unwrap_or_default()
            .as_bytes(),
    );

    let mut sorted: Vec<_> = items.iter().collect();
    sorted.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));
    for item in sorted {
        hash_frame(&mut hasher, item.archive_path.as_bytes());
        hash_frame(
            &mut hasher,
            if item.kind == ArchiveEntryKind::Directory {
                b"directory"
            } else {
                b"file"
            },
        );
        let Some(path) = &item.source else {
            continue;
        };
        match (manifest.agent, item.archive_path.as_str()) {
            (ArchiveAgent::Claude, CLAUDE_TRANSCRIPT_ENTRY | CLAUDE_HISTORY_ENTRY)
            | (ArchiveAgent::Codex, CODEX_ROLLOUT_ENTRY) => {
                hash_canonical_jsonl(&mut hasher, path, manifest, &item.archive_path)?;
            }
            (ArchiveAgent::Cursor, CURSOR_META_ENTRY) => {
                hash_json_file(&mut hasher, path, manifest, true)?;
            }
            (ArchiveAgent::Cursor, CURSOR_PROMPT_HISTORY_ENTRY) => {
                hash_json_file(&mut hasher, path, manifest, false)?;
            }
            (ArchiveAgent::Cursor, CURSOR_STORE_DB_ENTRY) => {
                hash_canonical_sqlite_file(&mut hasher, path)?;
            }
            _ => hash_raw_file(&mut hasher, path)?,
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn optional_plain_directory(path: &Path, label: &str) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {
            let metadata = reject_link_or_reparse(path)?;
            if !metadata.is_dir() {
                return Err(format!("{label} 存在但不是目录"));
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("检查 {label} 失败：{error}")),
    }
}

fn find_existing_session(
    home: &Path,
    agent: ArchiveAgent,
    id: &str,
) -> Result<Option<PathBuf>, String> {
    validate_session_id(id)?;
    let mut matches = Vec::new();
    match agent {
        ArchiveAgent::Claude => {
            let root = home.join(".claude").join("projects");
            if optional_plain_directory(&root, "Claude projects 根")? {
                let mut scanned = 0usize;
                for entry in std::fs::read_dir(&root).map_err(|error| error.to_string())? {
                    scanned += 1;
                    if scanned > MAX_EXISTING_SCAN_ENTRIES {
                        return Err("Claude projects 扫描超过 100,000 entry 上限".into());
                    }
                    let entry = entry.map_err(|error| error.to_string())?;
                    let project = entry.path();
                    let metadata = reject_link_or_reparse(&project)?;
                    if !metadata.is_dir() {
                        continue;
                    }
                    let candidate = project.join(format!("{id}.jsonl"));
                    match std::fs::symlink_metadata(&candidate) {
                        Ok(_) => {
                            let metadata = reject_link_or_reparse(&candidate)?;
                            if !metadata.is_file() {
                                return Err("Claude 同 ID 候选不是普通 transcript 文件".into());
                            }
                            matches.push(candidate);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(format!("检查 Claude 同 ID 候选失败：{error}")),
                    }
                }
            }
        }
        ArchiveAgent::Codex => {
            let root = home.join(".codex").join("sessions");
            if optional_plain_directory(&root, "Codex sessions 根")? {
                let suffix = format!("-{id}.jsonl");
                let zst_suffix = format!("-{id}.jsonl.zst");
                let mut scanned = 0usize;
                for item in WalkDir::new(&root).max_depth(5).follow_links(false) {
                    scanned += 1;
                    if scanned > MAX_EXISTING_SCAN_ENTRIES {
                        return Err("Codex sessions 扫描超过 100,000 entry 上限".into());
                    }
                    let item = item.map_err(|error| format!("扫描 Codex 同 ID 失败：{error}"))?;
                    if !item.file_type().is_file() {
                        continue;
                    }
                    let Some(name) = item.file_name().to_str() else {
                        continue;
                    };
                    if name.ends_with(&zst_suffix) {
                        return Err("Codex 已存在同 ID 的 .jsonl.zst，V1 无法安全判定冲突".into());
                    }
                    if name.starts_with("rollout-") && name.ends_with(&suffix) {
                        reject_link_or_reparse(item.path())?;
                        matches.push(item.path().to_path_buf());
                    }
                }
            }
        }
        ArchiveAgent::Cursor => {
            let root = home.join(".cursor").join("chats");
            if optional_plain_directory(&root, "Cursor chats 根")? {
                let mut scanned = 0usize;
                for entry in std::fs::read_dir(&root).map_err(|error| error.to_string())? {
                    scanned += 1;
                    if scanned > MAX_EXISTING_SCAN_ENTRIES {
                        return Err("Cursor chats 扫描超过 100,000 entry 上限".into());
                    }
                    let entry = entry.map_err(|error| error.to_string())?;
                    let bucket = entry.path();
                    let metadata = reject_link_or_reparse(&bucket)?;
                    if !metadata.is_dir() {
                        continue;
                    }
                    let candidate = bucket.join(id);
                    match std::fs::symlink_metadata(&candidate) {
                        Ok(_) => {
                            let metadata = reject_link_or_reparse(&candidate)?;
                            if !metadata.is_dir() {
                                return Err("Cursor 同 ID 候选不是普通 chat 目录".into());
                            }
                            matches.push(candidate);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(format!("检查 Cursor 同 ID 候选失败：{error}")),
                    }
                }
            }
        }
    }
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.pop()),
        count => Err(format!(
            "{} 全局存在 {count} 个相同 Session ID，拒绝选择任意一个",
            agent_name(agent)
        )),
    }
}

fn append_native_tree_items(
    root: &Path,
    archive_root: &str,
    items: &mut Vec<HashItem>,
    total_bytes: &mut u64,
) -> Result<(), String> {
    let limits = ArchiveLimits::session();
    let metadata = reject_link_or_reparse(root)?;
    if !metadata.is_dir() {
        return Err(format!("Session 原生树根不是目录：{}", root.display()));
    }
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let mut iterator = WalkDir::new(root).follow_links(false).into_iter();
    while let Some(item) = iterator.next() {
        let item = item.map_err(|error| format!("扫描 Session 原生树失败：{error}"))?;
        let metadata = reject_link_or_reparse(item.path())?;
        if item.depth() > 0 && is_runtime_only(item.path()) {
            if metadata.is_dir() {
                iterator.skip_current_dir();
            }
            continue;
        }
        let canonical = item
            .path()
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let relative = canonical
            .strip_prefix(&canonical_root)
            .map_err(|_| "Session 原生树 entry 逃逸根目录".to_string())?;
        let suffix = relative_path_string(relative)?;
        let archive_path = if suffix.is_empty() {
            archive_root.to_string()
        } else {
            format!("{archive_root}/{suffix}")
        };
        if items.len() >= limits.max_entries {
            return Err("现有 Claude Session entry 数超过导入业务上限".into());
        }
        if metadata.is_dir() {
            items.push(HashItem {
                archive_path,
                kind: ArchiveEntryKind::Directory,
                source: None,
            });
        } else if metadata.is_file() {
            if metadata.len() > limits.max_file_bytes {
                return Err("现有 Claude Session 文件超过单文件业务上限".into());
            }
            *total_bytes = total_bytes
                .checked_add(metadata.len())
                .ok_or_else(|| "现有 Claude Session 总量溢出".to_string())?;
            if *total_bytes > limits.max_total_bytes {
                return Err("现有 Claude Session 总量超过导入业务上限".into());
            }
            items.push(HashItem {
                archive_path,
                kind: ArchiveEntryKind::File,
                source: Some(canonical),
            });
        } else {
            return Err("Session 原生树只允许普通文件/目录".into());
        }
    }
    Ok(())
}

fn is_runtime_only(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    name == ".lock"
        || name.ends_with(".lock")
        || name == "pid"
        || name.ends_with(".pid")
        || name == "session-env"
}

fn relative_path_string(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(
                value
                    .to_str()
                    .ok_or_else(|| "原生 Session 相对路径不是 UTF-8".to_string())?,
            ),
            _ => return Err("原生 Session 路径含非法组件".into()),
        }
    }
    Ok(parts.join("/"))
}

fn canonical_hash_existing(
    home: &Path,
    agent: ArchiveAgent,
    id: &str,
    existing: &Path,
    scratch: &Path,
) -> Result<String, String> {
    match agent {
        ArchiveAgent::Claude => canonical_hash_existing_claude(home, id, existing, scratch),
        ArchiveAgent::Codex => canonical_hash_existing_codex(home, id, existing),
        ArchiveAgent::Cursor => canonical_hash_existing_cursor(home, id, existing, scratch),
    }
}

fn canonical_hash_existing_claude(
    home: &Path,
    id: &str,
    transcript: &Path,
    scratch: &Path,
) -> Result<String, String> {
    let bucket = transcript
        .parent()
        .ok_or_else(|| "Claude transcript 缺少 project bucket".to_string())?;
    let bucket_name = bucket
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Claude project bucket 不是 UTF-8".to_string())?;
    let mut anchor: Option<String> = None;
    let mut version = None;
    visit_jsonl(transcript, "现有 Claude transcript", |_, value| {
        if value
            .get("sessionId")
            .is_some_and(|value| value.as_str() != Some(id))
        {
            return Err("现有 Claude transcript 内 sessionId 冲突".into());
        }
        if matches!(
            value.get("type").and_then(Value::as_str),
            Some("user" | "assistant" | "system" | "attachment")
        ) && value.get("sessionId").and_then(Value::as_str) == Some(id)
        {
            let Some(cwd) = value.get("cwd").and_then(Value::as_str) else {
                return Ok(());
            };
            if crate::catalog::claude_project_slug(cwd)
                .is_ok_and(|slug| slug.eq_ignore_ascii_case(bucket_name))
            {
                if anchor
                    .as_deref()
                    .is_some_and(|current| !workspace_text_matches(current, cwd))
                {
                    return Err("现有 Claude transcript 含互不等价的 project anchor cwd".into());
                }
                if anchor.is_none() {
                    anchor = Some(cwd.to_string());
                }
                if let Some(found) = value
                    .get("version")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                {
                    version = Some(found.to_string());
                }
            }
        }
        Ok(())
    })?;
    let anchor =
        anchor.ok_or_else(|| "现有 Claude transcript 无法恢复 project anchor cwd".to_string())?;
    let history_source = home.join(".claude").join("history.jsonl");
    let history_target = scratch.join("existing-claude-history.jsonl");
    let mut output = File::create(&history_target).map_err(|error| error.to_string())?;
    let mut included = 0usize;
    visit_jsonl(&history_source, "现有 Claude history", |_, value| {
        if value.get("sessionId").and_then(Value::as_str) == Some(id)
            && value
                .get("project")
                .and_then(Value::as_str)
                .is_some_and(|project| workspace_text_matches(project, &anchor))
        {
            output
                .write_all(
                    &serde_json::to_vec(&canonicalize_json(value))
                        .map_err(|error| error.to_string())?,
                )
                .map_err(|error| error.to_string())?;
            output.write_all(b"\n").map_err(|error| error.to_string())?;
            included += 1;
        }
        Ok(())
    })?;
    output.sync_all().map_err(|error| error.to_string())?;
    if included == 0 {
        return Err("现有 Claude Session 缺少对应 history".into());
    }
    let limits = ArchiveLimits::session();
    let transcript_len = reject_link_or_reparse(transcript)?.len();
    let history_len = reject_link_or_reparse(&history_target)?.len();
    if transcript_len > limits.max_file_bytes || history_len > limits.max_file_bytes {
        return Err("现有 Claude transcript/history 超过单文件业务上限".into());
    }
    let mut total_bytes = transcript_len
        .checked_add(history_len)
        .ok_or_else(|| "现有 Claude Session 总量溢出".to_string())?;
    if total_bytes > limits.max_total_bytes {
        return Err("现有 Claude Session 总量超过导入业务上限".into());
    }
    let mut capabilities = vec![ArchiveCapability::Transcript, ArchiveCapability::History];
    let mut items = vec![
        HashItem {
            archive_path: CLAUDE_TRANSCRIPT_ENTRY.into(),
            kind: ArchiveEntryKind::File,
            source: Some(transcript.to_path_buf()),
        },
        HashItem {
            archive_path: CLAUDE_HISTORY_ENTRY.into(),
            kind: ArchiveEntryKind::File,
            source: Some(history_target),
        },
    ];
    let sidecar = bucket.join(id);
    for (capability, native, archive_root) in [
        (
            ArchiveCapability::Subagents,
            sidecar.join("subagents"),
            CLAUDE_SUBAGENTS_ROOT,
        ),
        (
            ArchiveCapability::ToolResults,
            sidecar.join("tool-results"),
            CLAUDE_TOOL_RESULTS_ROOT,
        ),
        (
            ArchiveCapability::Tasks,
            home.join(".claude").join("tasks").join(id),
            CLAUDE_TASKS_ROOT,
        ),
    ] {
        if optional_plain_directory(&native, "Claude 可选恢复树")? {
            capabilities.push(capability);
            append_native_tree_items(&native, archive_root, &mut items, &mut total_bytes)?;
        }
    }
    let manifest = SessionManifest {
        version: crate::portable_archive::PACKAGE_VERSION,
        kind: crate::portable_archive::PackageKind::Session,
        agent: ArchiveAgent::Claude,
        session_id: id.into(),
        source_cwd: anchor,
        source_agent_version: version
            .ok_or_else(|| "现有 Claude Session 缺少 version".to_string())?,
        source_schema_version: CLAUDE_SESSION_SCHEMA.into(),
        exported_at_ms: 0,
        label: None,
        native_relative_path: None,
        capabilities,
        entries: Vec::new(),
    };
    canonical_payload_hash(&manifest, &items)
}

fn first_codex_meta(path: &Path, id: &str) -> Result<(String, String), String> {
    let mut result = None;
    visit_jsonl(path, "现有 Codex rollout", |index, value| {
        if index == 0 {
            if value.get("type").and_then(Value::as_str) != Some("session_meta") {
                return Err("现有 Codex rollout 首行不是 session_meta".into());
            }
            let payload = value
                .get("payload")
                .and_then(Value::as_object)
                .ok_or_else(|| "现有 Codex session_meta 缺少 payload".to_string())?;
            if payload.get("id").and_then(Value::as_str) != Some(id) {
                return Err("现有 Codex session_meta ID 不一致".into());
            }
            let cwd = payload
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "现有 Codex session_meta 缺少 cwd".to_string())?;
            let version = payload
                .get("cli_version")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "现有 Codex session_meta 缺少 cli_version".to_string())?;
            result = Some((cwd.into(), version.into()));
        } else if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            return Err("现有 Codex rollout 含重复 session_meta".into());
        }
        Ok(())
    })?;
    result.ok_or_else(|| "现有 Codex rollout 缺少 session_meta".into())
}

fn latest_codex_title(home: &Path, id: &str) -> Result<Option<String>, String> {
    let path = home.join(".codex").join("session_index.jsonl");
    let mut title = None;
    visit_index_lines(&path, "Codex session_index.jsonl", |line| {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return Ok(());
        };
        if value.get("id").and_then(Value::as_str) != Some(id) {
            return Ok(());
        }
        if let Some(next) = value
            .get("thread_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            title = Some(next.to_string());
        }
        Ok(())
    })?;
    Ok(title)
}

fn canonical_hash_existing_codex(home: &Path, id: &str, rollout: &Path) -> Result<String, String> {
    let root = home.join(".codex").join("sessions");
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let rollout = rollout.canonicalize().map_err(|error| error.to_string())?;
    let relative = rollout
        .strip_prefix(&root)
        .map_err(|_| "现有 Codex rollout 逃逸 sessions 根".to_string())?;
    validate_codex_relative_path(relative, id)?;
    let (anchor, version) = first_codex_meta(&rollout, id)?;
    let title = latest_codex_title(home, id)?;
    let mut capabilities = vec![ArchiveCapability::Rollout];
    if title.is_some() {
        capabilities.push(ArchiveCapability::NativeTitle);
    }
    let manifest = SessionManifest {
        version: crate::portable_archive::PACKAGE_VERSION,
        kind: crate::portable_archive::PackageKind::Session,
        agent: ArchiveAgent::Codex,
        session_id: id.into(),
        source_cwd: anchor,
        source_agent_version: version,
        source_schema_version: CODEX_SESSION_SCHEMA.into(),
        exported_at_ms: 0,
        label: title,
        native_relative_path: Some(relative_path_string(relative)?),
        capabilities,
        entries: Vec::new(),
    };
    canonical_payload_hash(
        &manifest,
        &[HashItem {
            archive_path: CODEX_ROLLOUT_ENTRY.into(),
            kind: ArchiveEntryKind::File,
            source: Some(rollout),
        }],
    )
}

fn canonical_hash_existing_cursor(
    _home: &Path,
    id: &str,
    chat_dir: &Path,
    scratch: &Path,
) -> Result<String, String> {
    let meta_path = chat_dir.join("meta.json");
    let meta = read_small_json(&meta_path, "现有 Cursor meta.json")?;
    let object = meta
        .as_object()
        .ok_or_else(|| "现有 Cursor meta.json 根不是 object".to_string())?;
    let anchor = object
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "现有 Cursor meta.json 缺少 cwd".to_string())?
        .to_string();
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || object
            .get("id")
            .is_some_and(|value| value.as_str() != Some(id))
        || object.get("hasConversation").and_then(Value::as_bool) != Some(true)
    {
        return Err("现有 Cursor meta.json schema/id/conversation 无效".into());
    }
    let bucket = chat_dir
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .ok_or_else(|| "现有 Cursor chat 缺少 bucket".to_string())?;
    if bucket != cursor_bucket(&anchor) {
        return Err("现有 Cursor chat bucket 与 meta.cwd MD5 不一致".into());
    }
    let title = object
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let prompt = chat_dir.join("prompt_history.json");
    let has_prompt = match std::fs::symlink_metadata(&prompt) {
        Ok(_) => {
            reject_link_or_reparse(&prompt)?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("检查现有 Cursor prompt history 失败：{error}")),
    };
    let store = chat_dir.join("store.db");
    // The archive exporter always produces a normalized online-backup image in
    // DELETE mode.  Hash the existing DB through the same path even when no WAL
    // sidecar is currently present; SQLite file headers may otherwise differ.
    let hash_store = scratch.join("existing-cursor-store.db");
    backup_cursor_database(&store, &hash_store)?;
    sqlite_integrity(&hash_store)?;
    let mut capabilities = vec![ArchiveCapability::Metadata, ArchiveCapability::StoreDb];
    let mut items = vec![
        HashItem {
            archive_path: CURSOR_META_ENTRY.into(),
            kind: ArchiveEntryKind::File,
            source: Some(meta_path),
        },
        HashItem {
            archive_path: CURSOR_STORE_DB_ENTRY.into(),
            kind: ArchiveEntryKind::File,
            source: Some(hash_store),
        },
    ];
    if has_prompt {
        capabilities.push(ArchiveCapability::PromptHistory);
        items.push(HashItem {
            archive_path: CURSOR_PROMPT_HISTORY_ENTRY.into(),
            kind: ArchiveEntryKind::File,
            source: Some(prompt),
        });
    }
    let manifest = SessionManifest {
        version: crate::portable_archive::PACKAGE_VERSION,
        kind: crate::portable_archive::PackageKind::Session,
        agent: ArchiveAgent::Cursor,
        session_id: id.into(),
        source_cwd: anchor,
        source_agent_version: "ignored-by-payload-hash".into(),
        source_schema_version: CURSOR_SESSION_SCHEMA.into(),
        exported_at_ms: 0,
        label: title,
        native_relative_path: None,
        capabilities,
        entries: Vec::new(),
    };
    canonical_payload_hash(&manifest, &items)
}

fn rewrite_jsonl_to(
    source: &Path,
    destination: &Path,
    label: &str,
    mut transform: impl FnMut(usize, &mut Value) -> Result<(), String>,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建 {label} staging 父目录失败：{error}"))?;
    }
    let mut output =
        File::create(destination).map_err(|error| format!("创建 {label} staging 失败：{error}"))?;
    visit_jsonl(source, label, |index, value| {
        transform(index, value)?;
        serde_json::to_writer(&mut output, value)
            .map_err(|error| format!("写入 {label} staging 失败：{error}"))?;
        output
            .write_all(b"\n")
            .map_err(|error| format!("写入 {label} 换行失败：{error}"))
    })?;
    output
        .sync_all()
        .map_err(|error| format!("同步 {label} staging 失败：{error}"))
}

fn copy_plain_file(source: &Path, destination: &Path, label: &str) -> Result<(), String> {
    let metadata = reject_link_or_reparse(source)?;
    if !metadata.is_file() {
        return Err(format!("{label} 来源不是普通文件"));
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let input = File::open(source).map_err(|error| error.to_string())?;
    let mut output = File::create(destination).map_err(|error| error.to_string())?;
    let copied = std::io::copy(&mut input.take(metadata.len()), &mut output)
        .map_err(|error| format!("复制 {label} 失败：{error}"))?;
    if copied != metadata.len() {
        return Err(format!("{label} 复制中来源被截断"));
    }
    output
        .sync_all()
        .map_err(|error| format!("同步 {label} 失败：{error}"))
}

fn prepare_ready_payload(
    prepared: &PreparedArchive,
    target_cwd: &str,
    ready: &Path,
) -> Result<(), String> {
    std::fs::create_dir(ready).map_err(|error| format!("创建 ready staging 失败：{error}"))?;
    match prepared.manifest.agent {
        ArchiveAgent::Claude => {
            rewrite_jsonl_to(
                &prepared.extracted.join(CLAUDE_TRANSCRIPT_ENTRY),
                &ready.join("transcript.jsonl"),
                "Claude transcript",
                |_, value| {
                    replace_workspace_top_level(
                        value,
                        "cwd",
                        &prepared.manifest.source_cwd,
                        target_cwd,
                    );
                    Ok(())
                },
            )?;
            rewrite_jsonl_to(
                &prepared.extracted.join(CLAUDE_HISTORY_ENTRY),
                &ready.join("history.jsonl"),
                "Claude history",
                |_, value| {
                    replace_workspace_top_level(
                        value,
                        "project",
                        &prepared.manifest.source_cwd,
                        target_cwd,
                    );
                    *value = canonicalize_json(value);
                    Ok(())
                },
            )?;
            let caps: HashSet<_> = prepared.manifest.capabilities.iter().copied().collect();
            let sidecar = ready.join("sidecar");
            if caps.contains(&ArchiveCapability::Subagents)
                || caps.contains(&ArchiveCapability::ToolResults)
            {
                std::fs::create_dir(&sidecar).map_err(|error| error.to_string())?;
            }
            for (capability, archive_root, native_name) in [
                (
                    ArchiveCapability::Subagents,
                    CLAUDE_SUBAGENTS_ROOT,
                    "subagents",
                ),
                (
                    ArchiveCapability::ToolResults,
                    CLAUDE_TOOL_RESULTS_ROOT,
                    "tool-results",
                ),
            ] {
                if caps.contains(&capability) {
                    std::fs::rename(
                        prepared.extracted.join(archive_root),
                        sidecar.join(native_name),
                    )
                    .map_err(|error| format!("组装 Claude {native_name} staging 失败：{error}"))?;
                }
            }
            if caps.contains(&ArchiveCapability::Tasks) {
                std::fs::rename(
                    prepared.extracted.join(CLAUDE_TASKS_ROOT),
                    ready.join("tasks"),
                )
                .map_err(|error| format!("组装 Claude tasks staging 失败：{error}"))?;
            }
        }
        ArchiveAgent::Codex => {
            rewrite_jsonl_to(
                &prepared.extracted.join(CODEX_ROLLOUT_ENTRY),
                &ready.join("rollout.jsonl"),
                "Codex rollout",
                |index, value| {
                    let record_type = value.get("type").and_then(Value::as_str);
                    if index == 0 && record_type == Some("session_meta")
                        || record_type == Some("turn_context")
                    {
                        replace_payload_field(
                            value,
                            "cwd",
                            &prepared.manifest.source_cwd,
                            target_cwd,
                        );
                    }
                    Ok(())
                },
            )?;
        }
        ArchiveAgent::Cursor => {
            let mut meta = read_small_json(
                &prepared.extracted.join(CURSOR_META_ENTRY),
                "Cursor meta.json",
            )?;
            replace_top_level(&mut meta, "cwd", &prepared.manifest.source_cwd, target_cwd);
            let meta_path = ready.join("chat").join("meta.json");
            std::fs::create_dir_all(meta_path.parent().expect("meta has parent"))
                .map_err(|error| error.to_string())?;
            let mut meta_file = File::create(&meta_path).map_err(|error| error.to_string())?;
            serde_json::to_writer(&mut meta_file, &meta).map_err(|error| error.to_string())?;
            meta_file.sync_all().map_err(|error| error.to_string())?;
            if prepared
                .manifest
                .capabilities
                .contains(&ArchiveCapability::PromptHistory)
            {
                copy_plain_file(
                    &prepared.extracted.join(CURSOR_PROMPT_HISTORY_ENTRY),
                    &ready.join("chat").join("prompt_history.json"),
                    "Cursor prompt_history.json",
                )?;
            }
            copy_plain_file(
                &prepared.extracted.join(CURSOR_STORE_DB_ENTRY),
                &ready.join("chat").join("store.db"),
                "Cursor store.db",
            )?;
            sqlite_integrity(&ready.join("chat").join("store.db"))?;
        }
    }
    Ok(())
}

fn ensure_plain_dirs_under(
    home: &Path,
    directory: &Path,
    receipt: &mut CommitReceipt,
) -> Result<(), String> {
    let relative = directory
        .strip_prefix(home)
        .map_err(|_| format!("目标目录逃逸 home：{}", directory.display()))?;
    let mut current = home.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err("目标目录含非法组件".into());
        };
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(_) => {
                let metadata = reject_link_or_reparse(&current)?;
                if !metadata.is_dir() {
                    return Err(format!("目标父路径不是目录：{}", current.display()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)
                    .map_err(|error| format!("创建目标目录失败 {}：{error}", current.display()))?;
                let metadata = reject_link_or_reparse(&current)?;
                if !metadata.is_dir() {
                    return Err("新建目标目录类型异常".into());
                }
                receipt.created_dirs.push(current.clone());
            }
            Err(error) => return Err(format!("检查目标目录失败：{error}")),
        }
    }
    Ok(())
}

fn require_destination_absent(path: &Path, label: &str) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(format!("{label} 已存在，拒绝覆盖：{}", path.display())),
        Err(error) => Err(format!("检查 {label} 失败：{error}")),
    }
}

#[cfg(windows)]
fn hash_filesystem_identity(
    hasher: &mut Sha256,
    metadata: &std::fs::Metadata,
) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    // Stable Rust does not expose the Windows file index. Creation time is
    // preserved by same-volume rename and, combined with path/type/content
    // fingerprinting plus a second pre-delete recheck, detects ordinary path
    // replacement without requiring nightly or a new Win32 dependency.
    hash_frame(hasher, &metadata.creation_time().to_le_bytes());
    hash_frame(hasher, &metadata.file_attributes().to_le_bytes());
    Ok(())
}

#[cfg(unix)]
fn hash_filesystem_identity(
    hasher: &mut Sha256,
    metadata: &std::fs::Metadata,
) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    hash_frame(hasher, &metadata.dev().to_le_bytes());
    hash_frame(hasher, &metadata.ino().to_le_bytes());
    Ok(())
}

#[cfg(not(any(windows, unix)))]
fn hash_filesystem_identity(
    _hasher: &mut Sha256,
    _metadata: &std::fs::Metadata,
) -> Result<(), String> {
    Err("当前平台不支持可靠的 payload 文件身份".into())
}

fn raw_path_fingerprint(root: &Path) -> Result<String, String> {
    let root_metadata = reject_link_or_reparse(root)?;
    let limits = ArchiveLimits::session();
    let mut entries = Vec::new();
    if root_metadata.is_file() {
        entries.push((String::new(), root.to_path_buf(), false));
    } else if root_metadata.is_dir() {
        for entry in WalkDir::new(root).follow_links(false) {
            let entry = entry.map_err(|error| format!("枚举 payload 指纹失败：{error}"))?;
            let path = entry.path();
            let metadata = reject_link_or_reparse(path)?;
            if !metadata.is_file() && !metadata.is_dir() {
                return Err("payload 指纹只允许普通文件/目录".into());
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "payload 指纹路径逃逸".to_string())?;
            entries.push((
                relative_path_string(relative)?,
                path.to_path_buf(),
                metadata.is_dir(),
            ));
            if entries.len() > limits.max_entries {
                return Err("payload 指纹 entry 数超过 Session 上限".into());
            }
        }
    } else {
        return Err("payload 指纹目标不是普通文件/目录".into());
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    hash_frame(&mut hasher, b"htybox-rollback-payload-v1");
    let mut total = 0u64;
    for (relative, path, is_dir) in entries {
        hash_frame(&mut hasher, relative.as_bytes());
        hash_frame(&mut hasher, if is_dir { b"directory" } else { b"file" });
        let metadata = reject_link_or_reparse(&path)?;
        hash_filesystem_identity(&mut hasher, &metadata)?;
        if !is_dir {
            let len = metadata.len();
            if len > limits.max_file_bytes {
                return Err("payload 指纹文件超过 Session 上限".into());
            }
            total = total
                .checked_add(len)
                .ok_or_else(|| "payload 指纹总量溢出".to_string())?;
            if total > limits.max_total_bytes {
                return Err("payload 指纹总量超过 Session 上限".into());
            }
            hash_raw_file(&mut hasher, &path)?;
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn rename_commit(
    source: &Path,
    destination: &Path,
    receipt: &mut CommitReceipt,
) -> Result<(), String> {
    require_destination_absent(destination, "Session payload 目标")?;
    let fingerprint = raw_path_fingerprint(source)?;
    std::fs::rename(source, destination).map_err(|error| {
        format!(
            "原子提交 Session payload 失败 {} -> {}：{error}",
            source.display(),
            destination.display()
        )
    })?;
    receipt.paths.push(CommittedPath {
        path: destination.to_path_buf(),
        fingerprint,
    });
    Ok(())
}

fn empty_sha256() -> [u8; 32] {
    Sha256::digest([]).into()
}

fn visit_index_reader(
    reader: &mut impl Read,
    length: u64,
    label: &str,
    mut visit: impl FnMut(&[u8]) -> Result<(), String>,
) -> Result<[u8; 32], String> {
    if length > MAX_NATIVE_INDEX_BYTES {
        return Err(format!(
            "{label} 超过 {} MiB 业务上限",
            MAX_NATIVE_INDEX_BYTES / 1024 / 1024
        ));
    }
    let mut limited = reader.take(length);
    let mut hasher = Sha256::new();
    let mut pending = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = limited
            .read(&mut chunk)
            .map_err(|error| format!("读取 {label} 失败：{error}"))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| format!("{label} 读取计数溢出"))?;
        hasher.update(&chunk[..read]);
        let mut start = 0usize;
        for (index, byte) in chunk[..read].iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            let segment = &chunk[start..index];
            if pending.len().saturating_add(segment.len()) > MAX_JSONL_LINE_BYTES {
                return Err(format!("{label} 单行超过 16 MiB"));
            }
            pending.extend_from_slice(segment);
            if !pending.is_empty() {
                visit(&pending)?;
            }
            pending.clear();
            start = index + 1;
        }
        let tail = &chunk[start..read];
        if pending.len().saturating_add(tail.len()) > MAX_JSONL_LINE_BYTES {
            return Err(format!("{label} 单行超过 16 MiB"));
        }
        pending.extend_from_slice(tail);
    }
    if total != length {
        return Err(format!("{label} 在固定长度读取中被截断"));
    }
    if !pending.is_empty() {
        return Err(format!("{label} 含不完整尾行，拒绝拼接"));
    }
    Ok(hasher.finalize().into())
}

fn visit_index_lines(
    path: &Path,
    label: &str,
    visit: impl FnMut(&[u8]) -> Result<(), String>,
) -> Result<IndexSnapshot, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(IndexSnapshot {
                existed: false,
                len: 0,
                sha256: empty_sha256(),
            });
        }
        Err(error) => return Err(format!("检查 {label} 失败：{error}")),
        Ok(_) => reject_link_or_reparse(path)?,
    };
    if !metadata.is_file() {
        return Err(format!("{label} 不是普通文件"));
    }
    let mut file = File::open(path).map_err(|error| format!("打开 {label} 失败：{error}"))?;
    let sha256 = visit_index_reader(&mut file, metadata.len(), label, visit)?;
    Ok(IndexSnapshot {
        existed: true,
        len: metadata.len(),
        sha256,
    })
}

fn pending_append(
    path: PathBuf,
    bytes: Vec<u8>,
    expected: IndexSnapshot,
) -> Result<PendingAppend, String> {
    let final_len = expected
        .len
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| "append 后索引长度溢出".to_string())?;
    if final_len > MAX_NATIVE_INDEX_BYTES {
        return Err(format!(
            "append 后原生索引将超过 {} MiB 业务上限",
            MAX_NATIVE_INDEX_BYTES / 1024 / 1024
        ));
    }
    Ok(PendingAppend {
        path,
        bytes,
        expected,
    })
}

fn prepare_claude_history_append(home: &Path, staged: &Path) -> Result<PendingAppend, String> {
    let target = home.join(".claude").join("history.jsonl");
    let mut candidates = Vec::new();
    let mut unique = HashSet::new();
    let mut pending_size = 0usize;
    visit_jsonl(staged, "staged Claude history", |_, value| {
        let canonical =
            serde_json::to_vec(&canonicalize_json(value)).map_err(|error| error.to_string())?;
        if unique.insert(canonical.clone()) {
            pending_size = pending_size
                .checked_add(canonical.len() + 1)
                .ok_or_else(|| "Claude history pending append 大小溢出".to_string())?;
            if candidates.len() >= MAX_PENDING_APPEND_LINES
                || pending_size > MAX_PENDING_APPEND_BYTES
            {
                return Err("Claude history pending append 超过 100,000 行或 32 MiB 上限".into());
            }
            candidates.push(canonical);
        }
        Ok(())
    })?;
    let mut already_present = HashSet::new();
    let snapshot = visit_index_lines(&target, "Claude history 索引", |line| {
        if let Ok(value) = serde_json::from_slice::<Value>(line) {
            if let Ok(canonical) = serde_json::to_vec(&canonicalize_json(&value)) {
                if unique.contains(&canonical) {
                    already_present.insert(canonical);
                }
            }
        }
        Ok(())
    })?;
    let mut bytes = Vec::with_capacity(pending_size);
    for canonical in candidates {
        if !already_present.contains(&canonical) {
            bytes.extend_from_slice(&canonical);
            bytes.push(b'\n');
        }
    }
    pending_append(target, bytes, snapshot)
}

fn utc_timestamp_now() -> Result<String, String> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间早于 Unix epoch".to_string())?
        .as_secs();
    let days = i64::try_from(seconds / 86_400).map_err(|_| "UTC 日期溢出".to_string())?;
    let day_seconds = seconds % 86_400;
    // Howard Hinnant's civil_from_days, with Unix epoch offset.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let hour = day_seconds / 3_600;
    let minute = day_seconds % 3_600 / 60;
    let second = day_seconds % 60;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
    ))
}

fn prepare_codex_title_append(
    home: &Path,
    manifest: &SessionManifest,
) -> Result<Option<PendingAppend>, String> {
    let Some(title) = manifest.label.as_deref() else {
        return Ok(None);
    };
    let target = home.join(".codex").join("session_index.jsonl");
    let mut latest = None;
    let snapshot = visit_index_lines(&target, "Codex session_index.jsonl", |line| {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return Ok(());
        };
        if value.get("id").and_then(Value::as_str) == Some(&manifest.session_id) {
            if let Some(next) = value
                .get("thread_name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                latest = Some(next.to_string());
            }
        }
        Ok(())
    })?;
    let mut bytes = Vec::new();
    if latest.as_deref() != Some(title) {
        bytes = serde_json::to_vec(&serde_json::json!({
            "id": manifest.session_id,
            "thread_name": title,
            "updated_at": utc_timestamp_now()?,
        }))
        .map_err(|error| error.to_string())?;
        bytes.push(b'\n');
    }
    Ok(Some(pending_append(target, bytes, snapshot)?))
}

fn prepare_native_append(
    home: &Path,
    manifest: &SessionManifest,
    ready: &Path,
) -> Result<Option<PendingAppend>, String> {
    match manifest.agent {
        ArchiveAgent::Claude => Ok(Some(prepare_claude_history_append(
            home,
            &ready.join("history.jsonl"),
        )?)),
        ArchiveAgent::Codex => prepare_codex_title_append(home, manifest),
        ArchiveAgent::Cursor => Ok(None),
    }
}

fn apply_append(
    pending: &PendingAppend,
    receipt: &mut Option<AppendReceipt>,
    fault: ImportFault,
) -> Result<(), String> {
    if pending.bytes.is_empty() {
        return Ok(());
    }
    let parent = pending
        .path
        .parent()
        .ok_or_else(|| "append 索引缺少父目录".to_string())?;
    let parent_metadata = reject_link_or_reparse(parent)?;
    if !parent_metadata.is_dir() {
        return Err("append 索引父路径不是普通目录".into());
    }

    let mut file = if pending.expected.existed {
        reject_link_or_reparse(&pending.path)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .append(true)
            .open(&pending.path)
            .map_err(|error| format!("打开 append 索引失败：{error}"))?;
        reject_link_or_reparse(&pending.path)?;
        file
    } else {
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .append(true)
            .open(&pending.path)
            .map_err(|error| format!("create_new append 索引失败：{error}"))?;
        *receipt = Some(AppendReceipt {
            path: pending.path.clone(),
            original_len: 0,
            original_sha256: empty_sha256(),
            appended: pending.bytes.clone(),
            inject_rollback_sync_failure: matches!(
                fault,
                ImportFault::RollbackIndexSyncFailure
                    | ImportFault::PartialAppendRollbackSyncFailure
                    | ImportFault::PartialAppendRollbackRecoverySyncFailure
            ),
            inject_rollback_recovery_sync_failure: matches!(
                fault,
                ImportFault::PartialAppendRollbackRecoverySyncFailure
            ),
        });
        file
    };
    file.try_lock()
        .map_err(|error| format!("原生索引正被其他进程写入，拒绝 append：{error}"))?;

    let original_len = file.metadata().map_err(|error| error.to_string())?.len();
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let original_sha256 =
        visit_index_reader(&mut file, original_len, "append 索引提交复核", |_| {
            Ok(())
        })?;
    let current = IndexSnapshot {
        existed: pending.expected.existed,
        len: original_len,
        sha256: original_sha256,
    };
    if current != pending.expected {
        return Err("append 索引在预检与提交之间发生变化，拒绝写入".into());
    }
    *receipt = Some(AppendReceipt {
        path: pending.path.clone(),
        original_len,
        original_sha256,
        appended: pending.bytes.clone(),
        inject_rollback_sync_failure: matches!(
            fault,
            ImportFault::RollbackIndexSyncFailure
                | ImportFault::PartialAppendRollbackSyncFailure
                | ImportFault::PartialAppendRollbackRecoverySyncFailure
        ),
        inject_rollback_recovery_sync_failure: matches!(
            fault,
            ImportFault::PartialAppendRollbackRecoverySyncFailure
        ),
    });
    file.seek(SeekFrom::End(0))
        .map_err(|error| error.to_string())?;

    if matches!(
        fault,
        ImportFault::DuringIndexAppend
            | ImportFault::PartialAppendRollbackSyncFailure
            | ImportFault::PartialAppendRollbackRecoverySyncFailure
    ) {
        let prefix = (pending.bytes.len() / 2).max(1);
        file.write_all(&pending.bytes[..prefix])
            .map_err(|error| format!("注入 partial append 时写入失败：{error}"))?;
        return Err("测试故障注入：原生索引 partial append".into());
    }
    file.write_all(&pending.bytes)
        .map_err(|error| format!("append 原生索引失败：{error}"))?;
    if fault == ImportFault::AfterIndexWriteBeforeSync {
        return Err("测试故障注入：原生索引写后 sync 前".into());
    }
    file.sync_all()
        .map_err(|error| format!("同步原生索引失败：{error}"))?;
    Ok(())
}

fn rollback_append(receipt: &AppendReceipt) -> Result<AppendRollbackOutcome, String> {
    let metadata = match std::fs::symlink_metadata(&receipt.path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && receipt.original_len == 0 => {
            return Ok(AppendRollbackOutcome::RolledBack)
        }
        Err(error) => return Err(format!("检查回滚索引失败：{error}")),
        Ok(_) => reject_link_or_reparse(&receipt.path)?,
    };
    if !metadata.is_file() {
        return Err("回滚索引不再是普通文件".into());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&receipt.path)
        .map_err(|error| format!("打开回滚索引失败：{error}"))?;
    file.try_lock()
        .map_err(|error| format!("原生索引正被其他进程写入，无法安全回滚：{error}"))?;
    reject_link_or_reparse(&receipt.path)?;
    let current_len = file.metadata().map_err(|error| error.to_string())?.len();
    if current_len < receipt.original_len {
        return Err("索引长度短于 append 前长度，无法证明安全回滚".into());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let original_sha256 = {
        let mut prefix = (&mut file).take(receipt.original_len);
        let mut hasher = Sha256::new();
        let mut copied = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = prefix
                .read(&mut buffer)
                .map_err(|error| format!("读取回滚索引原前缀失败：{error}"))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            copied += read as u64;
        }
        if copied != receipt.original_len {
            return Err("回滚索引原前缀读取被截断".into());
        }
        <[u8; 32]>::from(hasher.finalize())
    };
    if original_sha256 != receipt.original_sha256 {
        return Err("索引原前缀已被替换或修改，拒绝截断".into());
    }
    let suffix_len = current_len - receipt.original_len;
    if suffix_len > receipt.appended.len() as u64 {
        return Err("索引在导入后被外部追加，无法安全截断本轮 receipt".into());
    }
    file.seek(SeekFrom::Start(receipt.original_len))
        .map_err(|error| error.to_string())?;
    let mut tail = vec![0u8; suffix_len as usize];
    file.read_exact(&mut tail)
        .map_err(|error| error.to_string())?;
    if tail != receipt.appended[..suffix_len as usize] {
        return Err("索引尾部不再匹配本轮 append receipt，拒绝截断".into());
    }
    file.set_len(receipt.original_len)
        .map_err(|error| format!("截断回滚索引失败：{error}"))?;
    let sync_error = if receipt.inject_rollback_sync_failure {
        Some("测试故障注入：索引 truncate 后 sync 失败".to_string())
    } else {
        file.sync_all().err().map(|error| error.to_string())
    };
    if let Some(sync_error) = sync_error {
        if let Err(error) = file.seek(SeekFrom::End(0)) {
            return Ok(AppendRollbackOutcome::UncertainAfterTruncate(format!(
                "索引已截断但持久化同步失败：{sync_error}；定位恢复点失败：{error}"
            )));
        }
        if let Err(error) = file.write_all(&receipt.appended) {
            return Ok(AppendRollbackOutcome::UncertainAfterTruncate(format!(
                "索引已截断但持久化同步失败：{sync_error}；恢复完整业务 append 失败：{error}"
            )));
        }
        let recovery_sync_error = if receipt.inject_rollback_recovery_sync_failure {
            Some("测试故障注入：完整 append 恢复后的 sync 失败".to_string())
        } else {
            file.sync_all().err().map(|error| error.to_string())
        };
        return Ok(AppendRollbackOutcome::RestoredVisible(match recovery_sync_error {
            Some(error) => format!(
                "索引已截断但持久化同步失败：{sync_error}；完整业务 append 已写回，但恢复 sync 失败：{error}"
            ),
            None => format!(
                "索引已截断但持久化同步失败：{sync_error}；已恢复完整业务 append"
            ),
        }));
    }
    // Keep a newly-created zero-length index rather than unlinking by pathname:
    // an external actor could replace that path between close and remove.
    Ok(AppendRollbackOutcome::RolledBack)
}

fn restore_held_payloads(held: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut failures = Vec::new();
    for (original, staged) in held.iter().rev() {
        match std::fs::symlink_metadata(staged) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                failures.push(format!(
                    "隔离 payload 已缺失，无法声明恢复成功：{}",
                    staged.display()
                ));
                continue;
            }
            Err(error) => {
                failures.push(format!(
                    "检查隔离 payload 失败 {}：{error}",
                    staged.display()
                ));
                continue;
            }
            Ok(_) => {
                if let Err(error) = reject_link_or_reparse(staged) {
                    failures.push(error);
                    continue;
                }
            }
        }
        match std::fs::symlink_metadata(original) {
            Ok(_) => {
                failures.push(format!(
                    "原 payload 路径被外部重新占用，隔离副本未覆盖：{}",
                    original.display()
                ));
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                failures.push(format!(
                    "检查原 payload 恢复路径失败 {}：{error}",
                    original.display()
                ));
                continue;
            }
        }
        if let Err(error) = std::fs::rename(staged, original) {
            failures.push(format!(
                "恢复隔离 payload 失败 {} -> {}：{error}",
                staged.display(),
                original.display()
            ));
        }
    }
    failures
}

fn restore_or_preserve_holding(holding: TempDir, held: &[(PathBuf, PathBuf)]) -> String {
    let failures = restore_held_payloads(held);
    let path = holding.keep();
    if failures.is_empty() {
        return format!("已恢复；隔离目录保留于 {}", path.display());
    }
    format!(
        "{}；未恢复副本保留于 {}",
        failures.join("；"),
        path.display()
    )
}

fn verify_held_payloads(
    receipt: &CommitReceipt,
    held: &[(PathBuf, PathBuf)],
) -> Result<(), String> {
    if held.len() != receipt.paths.len() {
        return Err("隔离 payload 数量与 commit receipt 不一致".into());
    }
    for (index, (_, staged)) in held.iter().enumerate() {
        let expected = &receipt.paths[index].fingerprint;
        match raw_path_fingerprint(staged) {
            Ok(fingerprint) if &fingerprint == expected => {}
            Ok(_) => return Err("隔离 payload 在最终删除前被外部替换".into()),
            Err(error) => return Err(format!("最终删除前无法证明隔离 payload 身份：{error}")),
        }
    }
    Ok(())
}

fn rollback_commit(home: &Path, receipt: &mut CommitReceipt) -> Result<(), String> {
    for committed in &receipt.paths {
        if committed.path.strip_prefix(home).is_err() {
            return Err(format!(
                "拒绝回滚 home 外路径，索引与 payload 均保留：{}",
                committed.path.display()
            ));
        }
        match raw_path_fingerprint(&committed.path) {
            Ok(fingerprint) if fingerprint == committed.fingerprint => {}
            Ok(_) => {
                return Err(format!(
                    "Session payload 已被外部修改，索引与全部 payload 均保留：{}",
                    committed.path.display()
                ));
            }
            Err(error) => {
                return Err(format!(
                    "无法证明 Session payload 仍为本轮内容，索引与全部 payload 均保留 {}：{error}",
                    committed.path.display()
                ));
            }
        }
    }

    let holding = tempfile::Builder::new()
        .prefix(".htybox-session-rollback-")
        .tempdir_in(home)
        .map_err(|error| format!("创建同卷 rollback 隔离目录失败：{error}"))?;
    let mut held = Vec::new();
    for (index, committed) in receipt.paths.iter().enumerate() {
        let fingerprint = match raw_path_fingerprint(&committed.path) {
            Ok(value) => value,
            Err(error) => {
                let recovery = restore_or_preserve_holding(holding, &held);
                return Err(format!(
                    "隔离前无法复核 payload {}：{error}；恢复结果：{recovery}",
                    committed.path.display()
                ));
            }
        };
        if fingerprint != committed.fingerprint {
            let recovery = restore_or_preserve_holding(holding, &held);
            return Err(format!(
                "payload 在隔离前发生变化，索引保持不变；恢复结果：{recovery}"
            ));
        }
        let staged = holding.path().join(format!("payload-{index:04}"));
        if let Err(error) = std::fs::rename(&committed.path, &staged) {
            let recovery = restore_or_preserve_holding(holding, &held);
            return Err(format!(
                "隔离 payload 失败 {}：{error}；恢复结果：{recovery}",
                committed.path.display(),
            ));
        }
        held.push((committed.path.clone(), staged));
        let staged_fingerprint = match raw_path_fingerprint(&held.last().expect("just pushed").1) {
            Ok(value) => value,
            Err(error) => {
                let recovery = restore_or_preserve_holding(holding, &held);
                return Err(format!(
                    "隔离后无法复核 payload：{error}；索引保持不变；恢复结果：{recovery}"
                ));
            }
        };
        if staged_fingerprint != committed.fingerprint {
            let recovery = restore_or_preserve_holding(holding, &held);
            return Err(format!(
                "隔离后的 payload 指纹变化，索引保持不变；恢复结果：{recovery}"
            ));
        }
    }

    if let Some(append) = receipt.append.as_ref() {
        match rollback_append(append) {
            Ok(AppendRollbackOutcome::RolledBack) => {}
            Ok(AppendRollbackOutcome::RestoredVisible(error)) | Err(error) => {
                let recovery = restore_or_preserve_holding(holding, &held);
                return Err(format!(
                    "{error}；索引保持/恢复为原现场，payload 恢复结果：{recovery}"
                ));
            }
            Ok(AppendRollbackOutcome::UncertainAfterTruncate(error)) => {
                let path = holding.keep();
                return Err(format!(
                    "{error}；为避免制造无索引的原生 Session，payload 隔离副本保留于 {}",
                    path.display()
                ));
            }
        }
    }

    if let Err(error) = verify_held_payloads(receipt, &held) {
        let path = holding.keep();
        return Err(format!(
            "索引已回滚，但 {error}；未递归删除，隔离内容保留于 {}",
            path.display()
        ));
    }

    let path = holding.keep();
    let retained_dirs = receipt
        .created_dirs
        .iter()
        .map(|directory| directory.display().to_string())
        .collect::<Vec<_>>();
    Err(format!(
        "索引已安全回滚；为避免 pathname 删除竞态，payload 隔离副本永久保留于 {}{}",
        path.display(),
        if retained_dirs.is_empty() {
            String::new()
        } else {
            format!("；本轮创建目录亦未自动删除：{}", retained_dirs.join("，"))
        }
    ))
}

fn maybe_fault(actual: ImportFault, expected: ImportFault, label: &str) -> Result<(), String> {
    if actual == expected {
        Err(format!("测试故障注入：{label}"))
    } else {
        Ok(())
    }
}

fn commit_agent_payload(
    context: &ImportContext<'_>,
    prepared: &PreparedArchive,
    ready: &Path,
    receipt: &mut CommitReceipt,
) -> Result<(), String> {
    let id = &prepared.manifest.session_id;
    match prepared.manifest.agent {
        ArchiveAgent::Claude => {
            let paths =
                crate::catalog::resolve_claude_project_in_home(context.target_cwd, context.home)?;
            ensure_plain_dirs_under(context.home, &paths.projects_root, receipt)?;
            ensure_plain_dirs_under(context.home, &paths.storage_dir, receipt)?;
            let resolved =
                crate::catalog::resolve_claude_project_in_home(context.target_cwd, context.home)?;
            if resolved.storage_dir != paths.storage_dir {
                return Err("Claude project bucket 在创建期间发生大小写歧义/竞态".into());
            }
            let transcript = paths.storage_dir.join(format!("{id}.jsonl"));
            let sidecar = paths.storage_dir.join(id);
            let tasks = context.home.join(".claude").join("tasks").join(id);
            require_destination_absent(&transcript, "Claude transcript")?;
            if ready.join("sidecar").exists() {
                require_destination_absent(&sidecar, "Claude sidecar")?;
            }
            if ready.join("tasks").exists() {
                require_destination_absent(&tasks, "Claude tasks")?;
            }
            if ready.join("sidecar").exists() {
                rename_commit(&ready.join("sidecar"), &sidecar, receipt)?;
            }
            if ready.join("tasks").exists() {
                ensure_plain_dirs_under(
                    context.home,
                    tasks.parent().expect("tasks parent"),
                    receipt,
                )?;
                rename_commit(&ready.join("tasks"), &tasks, receipt)?;
            }
            rename_commit(&ready.join("transcript.jsonl"), &transcript, receipt)?;
        }
        ArchiveAgent::Codex => {
            let relative = prepared
                .manifest
                .native_relative_path
                .as_deref()
                .ok_or_else(|| "Codex 缺少原生相对路径".to_string())?;
            let destination = relative.split('/').fold(
                context.home.join(".codex").join("sessions"),
                |mut path, part| {
                    path.push(part);
                    path
                },
            );
            ensure_plain_dirs_under(
                context.home,
                destination
                    .parent()
                    .ok_or_else(|| "Codex 目标缺少父目录".to_string())?,
                receipt,
            )?;
            rename_commit(&ready.join("rollout.jsonl"), &destination, receipt)?;
        }
        ArchiveAgent::Cursor => {
            let destination = context
                .home
                .join(".cursor")
                .join("chats")
                .join(cursor_bucket(context.target_cwd))
                .join(id);
            ensure_plain_dirs_under(
                context.home,
                destination
                    .parent()
                    .ok_or_else(|| "Cursor 目标缺少父目录".to_string())?,
                receipt,
            )?;
            rename_commit(&ready.join("chat"), &destination, receipt)?;
        }
    }
    Ok(())
}

fn verify_visible(context: &ImportContext<'_>, manifest: &SessionManifest) -> Result<(), String> {
    let visible = match manifest.agent {
        ArchiveAgent::Claude => {
            locate_claude_session_in(context.home, &manifest.session_id, context.target_cwd)?;
            list_claude_sessions_in(context.home, context.target_cwd)
                .iter()
                .any(|item| item.id == manifest.session_id)
        }
        ArchiveAgent::Codex => {
            locate_codex_session_in(context.home, &manifest.session_id, context.target_cwd)?;
            list_codex_sessions_in(context.home, context.target_cwd)
                .iter()
                .any(|item| item.id == manifest.session_id)
        }
        ArchiveAgent::Cursor => {
            locate_cursor_session_in(context.home, &manifest.session_id, context.target_cwd)?;
            list_cursor_sessions_in(context.home, context.target_cwd)
                .iter()
                .any(|item| item.id == manifest.session_id)
        }
    };
    if !visible {
        return Err("Session payload 已提交但现有列表函数不可见，触发回滚".into());
    }
    Ok(())
}

fn commit_prepared(
    context: &ImportContext<'_>,
    prepared: PreparedArchive,
    workdir: &TempDir,
) -> Result<SessionImportResult, String> {
    let ready = workdir.path().join("ready");
    prepare_ready_payload(&prepared, context.target_cwd, &ready)?;
    // Native indexes are streamed, bounded, and snapshotted before any payload
    // rename.  A huge or malformed index therefore cannot leave a half-session.
    let pending_append = prepare_native_append(context.home, &prepared.manifest, &ready)?;
    let mut receipt = CommitReceipt::default();
    let attempt = (|| {
        // Recheck the global identity immediately before the first rename.
        if find_existing_session(
            context.home,
            prepared.manifest.agent,
            &prepared.manifest.session_id,
        )?
        .is_some()
        {
            return Err("Session ID 在预检后被外部创建，拒绝提交".into());
        }
        commit_agent_payload(context, &prepared, &ready, &mut receipt)?;
        maybe_fault(
            context.fault,
            ImportFault::AfterPayloadCommit,
            "payload commit 后",
        )?;
        maybe_fault(
            context.fault,
            ImportFault::BeforeIndexAppend,
            "原生索引 append 前",
        )?;
        if let Some(pending) = &pending_append {
            apply_append(pending, &mut receipt.append, context.fault)?;
        }
        maybe_fault(
            context.fault,
            ImportFault::AfterIndexAppend,
            "原生索引 append 后",
        )?;
        maybe_fault(
            context.fault,
            ImportFault::RollbackIndexSyncFailure,
            "触发 truncate 后 sync 回滚故障",
        )?;
        maybe_fault(
            context.fault,
            ImportFault::BeforeVisibilityCheck,
            "可见性复核前",
        )?;
        verify_visible(context, &prepared.manifest)
    })();
    if let Err(error) = attempt {
        return match rollback_commit(context.home, &mut receipt) {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!("{error}；并且回滚失败：{rollback}")),
        };
    }
    Ok(SessionImportResult {
        agent: agent_name(prepared.manifest.agent).into(),
        id: prepared.manifest.session_id,
        label: prepared.manifest.label,
        status: "imported".into(),
        warnings: vec!["已绑定到当前工作区；包内历史消息中的旧路径与外部附件引用未迁移。".into()],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portable_archive::{
        write_package, PackageKind, PackageSource, PortableManifest, PACKAGE_VERSION,
    };
    use rusqlite::Connection;
    use serde_json::json;
    use std::fs;

    const ID: &str = "01234567-89ab-cdef-0123-456789abcdef";
    const OTHER_ID: &str = "11111111-2222-3333-4444-555555555555";

    struct Fixture {
        root: TempDir,
        home: PathBuf,
        source: PathBuf,
        target: PathBuf,
        target_two: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().expect("fixture tempdir");
            let home = root.path().join("home");
            let source = root.path().join("source-workspace");
            let target = root.path().join("target-workspace");
            let target_two = root.path().join("target-workspace-two");
            for path in [&home, &source, &target, &target_two] {
                fs::create_dir(path).expect("create fixture dir");
            }
            Self {
                root,
                home,
                source,
                target,
                target_two,
            }
        }

        fn path(&self, value: &Path) -> String {
            value.to_string_lossy().into_owned()
        }
    }

    fn write_lines(values: &[Value]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for value in values {
            bytes.extend(serde_json::to_vec(value).expect("serialize fixture line"));
            bytes.push(b'\n');
        }
        bytes
    }

    fn session_manifest(
        agent: ArchiveAgent,
        id: &str,
        source: &str,
        schema: &str,
        version: &str,
        label: Option<&str>,
        native_relative_path: Option<String>,
        capabilities: Vec<ArchiveCapability>,
    ) -> PortableManifest {
        PortableManifest::Session(SessionManifest {
            version: PACKAGE_VERSION,
            kind: PackageKind::Session,
            agent,
            session_id: id.into(),
            source_cwd: source.into(),
            source_agent_version: version.into(),
            source_schema_version: schema.into(),
            exported_at_ms: 1,
            label: label.map(str::to_string),
            native_relative_path,
            capabilities,
            entries: Vec::new(),
        })
    }

    fn write_archive(
        fixture: &Fixture,
        name: &str,
        manifest: PortableManifest,
        sources: Vec<PackageSource>,
    ) -> PathBuf {
        write_package(
            &fixture.root.path().join(name),
            crate::portable_archive::SESSION_EXTENSION,
            manifest,
            sources,
            ArchiveLimits::session(),
        )
        .expect("write fixture archive")
        .path
    }

    fn claude_archive(fixture: &Fixture, id: &str, changed: bool) -> PathBuf {
        let source = fixture.path(&fixture.source);
        let transcript = write_lines(&[
            json!({
                "type":"user",
                "sessionId":id,
                "cwd":source,
                "version":"1.2.3",
                "message":{"content": if changed { "changed" } else { "keep old source text" }, "cwd": source}
            }),
            json!({
                "type":"assistant",
                "sessionId":id,
                "cwd":"C:\\deliberate-old-switch",
                "version":"1.2.3",
                "message":{"content":"switch stays old"}
            }),
            json!({"type":"ai-title","aiTitle":"Claude fixture"}),
        ]);
        let history = write_lines(&[json!({
            "sessionId":id,
            "project":source,
            "display":"first prompt",
            "timestamp":42
        })]);
        write_archive(
            fixture,
            if changed { "claude-changed" } else { "claude" },
            session_manifest(
                ArchiveAgent::Claude,
                id,
                &fixture.path(&fixture.source),
                CLAUDE_SESSION_SCHEMA,
                "1.2.3",
                Some("Claude fixture"),
                None,
                vec![
                    ArchiveCapability::Transcript,
                    ArchiveCapability::History,
                    ArchiveCapability::Subagents,
                    ArchiveCapability::Tasks,
                ],
            ),
            vec![
                PackageSource::Bytes {
                    archive_path: CLAUDE_TRANSCRIPT_ENTRY.into(),
                    data: transcript,
                },
                PackageSource::Bytes {
                    archive_path: CLAUDE_HISTORY_ENTRY.into(),
                    data: history,
                },
                PackageSource::Directory {
                    archive_path: CLAUDE_SUBAGENTS_ROOT.into(),
                },
                PackageSource::Directory {
                    archive_path: format!("{CLAUDE_SUBAGENTS_ROOT}/empty"),
                },
                PackageSource::Bytes {
                    archive_path: format!("{CLAUDE_SUBAGENTS_ROOT}/agent.json"),
                    data: br#"{"agent":"fixture"}"#.to_vec(),
                },
                PackageSource::Directory {
                    archive_path: CLAUDE_TASKS_ROOT.into(),
                },
                PackageSource::Bytes {
                    archive_path: format!("{CLAUDE_TASKS_ROOT}/task.txt"),
                    data: b"task".to_vec(),
                },
            ],
        )
    }

    fn mixed_version_claude_archive(fixture: &Fixture, id: &str) -> PathBuf {
        let source = fixture.path(&fixture.source);
        let transcript = write_lines(&[
            json!({"type":"user","sessionId":id,"cwd":source,"version":"0.8.0"}),
            json!({"type":"assistant","sessionId":id,"cwd":source}),
            json!({"type":"assistant","sessionId":id,"cwd":source,"version":"1.2.3"}),
        ]);
        let history = write_lines(&[
            json!({"sessionId":id,"project":source,"display":"mixed versions","timestamp":1}),
        ]);
        write_archive(
            fixture,
            "claude-mixed-version",
            session_manifest(
                ArchiveAgent::Claude,
                id,
                &fixture.path(&fixture.source),
                CLAUDE_SESSION_SCHEMA,
                "1.2.3",
                None,
                None,
                vec![ArchiveCapability::Transcript, ArchiveCapability::History],
            ),
            vec![
                PackageSource::Bytes {
                    archive_path: CLAUDE_TRANSCRIPT_ENTRY.into(),
                    data: transcript,
                },
                PackageSource::Bytes {
                    archive_path: CLAUDE_HISTORY_ENTRY.into(),
                    data: history,
                },
            ],
        )
    }

    fn codex_archive(fixture: &Fixture, id: &str) -> PathBuf {
        let source = fixture.path(&fixture.source);
        let rollout = write_lines(&[
            json!({"type":"session_meta","payload":{"id":id,"cwd":source,"cli_version":"9.9.9"}}),
            json!({"type":"turn_context","payload":{"cwd":source,"note":"structured"}}),
            json!({"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":format!("literal old path {source}")}]}}),
        ]);
        let relative = format!("2026/07/11/rollout-2026-07-11T12-34-56-{id}.jsonl");
        write_archive(
            fixture,
            "codex",
            session_manifest(
                ArchiveAgent::Codex,
                id,
                &fixture.path(&fixture.source),
                CODEX_SESSION_SCHEMA,
                "9.9.9",
                Some("Native Codex title"),
                Some(relative),
                vec![ArchiveCapability::Rollout, ArchiveCapability::NativeTitle],
            ),
            vec![PackageSource::Bytes {
                archive_path: CODEX_ROLLOUT_ENTRY.into(),
                data: rollout,
            }],
        )
    }

    fn cursor_archive(fixture: &Fixture, id: &str) -> PathBuf {
        let source = fixture.path(&fixture.source);
        cursor_archive_with_meta_cwd(fixture, id, &source, "cursor")
    }

    fn cursor_archive_with_meta_cwd(
        fixture: &Fixture,
        id: &str,
        meta_cwd: &str,
        archive_name: &str,
    ) -> PathBuf {
        let db = fixture.root.path().join(format!("{id}-store.db"));
        let connection = Connection::open(&db).expect("create cursor fixture db");
        connection
            .execute_batch(
                "CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT NOT NULL);\
                 INSERT INTO messages(body) VALUES ('hello');\
                 PRAGMA journal_mode=DELETE;",
            )
            .expect("seed cursor fixture db");
        connection.close().expect("close cursor fixture db");
        let normalized_db = fixture
            .root
            .path()
            .join(format!("{id}-normalized-store.db"));
        backup_cursor_database(&db, &normalized_db).expect("normalize cursor fixture db");
        let source = fixture.path(&fixture.source);
        write_archive(
            fixture,
            archive_name,
            session_manifest(
                ArchiveAgent::Cursor,
                id,
                &source,
                CURSOR_SESSION_SCHEMA,
                "not-recorded-by-cursor-chat-v1",
                Some("Cursor fixture"),
                None,
                vec![
                    ArchiveCapability::Metadata,
                    ArchiveCapability::PromptHistory,
                    ArchiveCapability::StoreDb,
                ],
            ),
            vec![
                PackageSource::Bytes {
                    archive_path: CURSOR_META_ENTRY.into(),
                    data: serde_json::to_vec(&json!({
                        "schemaVersion":1,
                        "id":id,
                        "createdAtMs":1,
                        "updatedAtMs":2,
                        "hasConversation":true,
                        "title":"Cursor fixture",
                        "cwd":meta_cwd
                    }))
                    .unwrap(),
                },
                PackageSource::Bytes {
                    archive_path: CURSOR_PROMPT_HISTORY_ENTRY.into(),
                    data: br#"["hello"]"#.to_vec(),
                },
                PackageSource::File {
                    archive_path: CURSOR_STORE_DB_ENTRY.into(),
                    source_path: normalized_db,
                },
            ],
        )
    }

    fn import(
        fixture: &Fixture,
        archive: &Path,
        target: &Path,
    ) -> Result<SessionImportResult, String> {
        import_session_archive_in(
            &fixture.home,
            archive,
            &fixture.path(target),
            &fixture.path(target),
            ImportFault::None,
        )
    }

    #[test]
    fn claude_import_rebinds_only_structured_anchor_and_is_idempotent_across_cwd() {
        let fixture = Fixture::new();
        let archive = claude_archive(&fixture, ID, false);
        let result = import(&fixture, &archive, &fixture.target).expect("import claude");
        assert_eq!(result.status, "imported");
        let located = locate_claude_session_in(&fixture.home, ID, &fixture.path(&fixture.target))
            .expect("locate imported claude");
        let lines: Vec<Value> = fs::read_to_string(&located.transcript)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            lines[0].get("cwd").and_then(Value::as_str),
            Some(fixture.path(&fixture.target).as_str())
        );
        assert_eq!(
            lines[0].pointer("/message/cwd").and_then(Value::as_str),
            Some(fixture.path(&fixture.source).as_str())
        );
        assert_eq!(
            lines[1].get("cwd").and_then(Value::as_str),
            Some("C:\\deliberate-old-switch")
        );
        assert!(located
            .sidecar_dir
            .unwrap()
            .join("subagents/empty")
            .is_dir());
        assert!(located.tasks_dir.unwrap().join("task.txt").is_file());

        let duplicate = import(&fixture, &archive, &fixture.target_two).expect("idempotent import");
        assert_eq!(duplicate.status, "alreadyPresent");
        assert!(
            find_existing_session(&fixture.home, ArchiveAgent::Claude, ID)
                .unwrap()
                .is_some()
        );
        assert!(
            locate_claude_session_in(&fixture.home, ID, &fixture.path(&fixture.target_two))
                .is_err()
        );
    }

    #[test]
    fn same_claude_id_with_different_payload_is_rejected() {
        let fixture = Fixture::new();
        import(
            &fixture,
            &claude_archive(&fixture, ID, false),
            &fixture.target,
        )
        .expect("first import");
        let error = import(
            &fixture,
            &claude_archive(&fixture, ID, true),
            &fixture.target_two,
        )
        .expect_err("changed payload must conflict");
        assert!(error.contains("payload 不同"));
    }

    #[test]
    fn codex_import_preserves_native_date_and_title_and_is_idempotent() {
        let fixture = Fixture::new();
        let archive = codex_archive(&fixture, ID);
        let first = import(&fixture, &archive, &fixture.target).expect("import codex");
        assert_eq!(first.status, "imported");
        let located = locate_codex_session_in(&fixture.home, ID, &fixture.path(&fixture.target))
            .expect("locate imported codex");
        assert_eq!(
            relative_path_string(&located.relative_rollout).unwrap(),
            format!("2026/07/11/rollout-2026-07-11T12-34-56-{ID}.jsonl")
        );
        assert_eq!(located.native_title.as_deref(), Some("Native Codex title"));
        let values: Vec<Value> = fs::read_to_string(located.rollout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            values[0].pointer("/payload/cwd").and_then(Value::as_str),
            Some(fixture.path(&fixture.target).as_str())
        );
        assert_eq!(
            values[1].pointer("/payload/cwd").and_then(Value::as_str),
            Some(fixture.path(&fixture.target).as_str())
        );
        assert_eq!(
            values[2]
                .pointer("/payload/content/0/text")
                .and_then(Value::as_str),
            Some(format!("literal old path {}", fixture.path(&fixture.source)).as_str())
        );
        let duplicate = import(&fixture, &archive, &fixture.target_two).expect("idempotent codex");
        assert_eq!(duplicate.status, "alreadyPresent");
    }

    #[test]
    fn cursor_import_uses_exact_target_md5_and_clean_database_and_is_idempotent() {
        let fixture = Fixture::new();
        let archive = cursor_archive(&fixture, ID);
        let first = import(&fixture, &archive, &fixture.target).expect("import cursor");
        assert_eq!(first.status, "imported");
        let located = locate_cursor_session_in(&fixture.home, ID, &fixture.path(&fixture.target))
            .expect("locate imported cursor");
        assert_eq!(
            located
                .chat_dir
                .parent()
                .and_then(Path::file_name)
                .and_then(|value| value.to_str()),
            Some(cursor_bucket(&fixture.path(&fixture.target)).as_str())
        );
        sqlite_integrity(&located.store_db).expect("imported DB integrity");
        for suffix in ["-wal", "-shm", "-journal"] {
            assert!(
                !PathBuf::from(format!("{}{suffix}", located.store_db.to_string_lossy())).exists()
            );
        }
        let duplicate = import(&fixture, &archive, &fixture.target_two).expect("idempotent cursor");
        assert_eq!(duplicate.status, "alreadyPresent");
    }

    #[test]
    fn cursor_closed_wal_database_without_sidecars_hashes_like_export_backup() {
        let fixture = Fixture::new();
        let archive = cursor_archive(&fixture, ID);
        import(&fixture, &archive, &fixture.target).expect("first cursor import");
        let located = locate_cursor_session_in(&fixture.home, ID, &fixture.path(&fixture.target))
            .expect("locate cursor");
        let connection = Connection::open(&located.store_db).expect("open imported cursor db");
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE);")
            .expect("switch existing DB to clean WAL mode");
        connection.close().expect("close WAL database");
        for suffix in ["-wal", "-shm", "-journal"] {
            let sidecar = PathBuf::from(format!("{}{suffix}", located.store_db.to_string_lossy()));
            if sidecar.exists() {
                fs::remove_file(sidecar).expect("remove closed test sidecar");
            }
        }
        let duplicate =
            import(&fixture, &archive, &fixture.target_two).expect("normalized WAL idempotence");
        assert_eq!(duplicate.status, "alreadyPresent");
    }

    #[test]
    fn claude_fault_after_index_append_rolls_back_payload_and_exact_append() {
        let fixture = Fixture::new();
        let archive = claude_archive(&fixture, OTHER_ID, false);
        let result = import_session_archive_in(
            &fixture.home,
            &archive,
            &fixture.path(&fixture.target),
            &fixture.path(&fixture.target),
            ImportFault::AfterIndexAppend,
        );
        let error = result.expect_err("fault must trigger rollback");
        assert!(
            find_existing_session(&fixture.home, ArchiveAgent::Claude, OTHER_ID)
                .unwrap()
                .is_none(),
            "rollback error: {error}"
        );
        let history = fixture.home.join(".claude/history.jsonl");
        assert!(!history.exists() || !fs::read_to_string(history).unwrap().contains(OTHER_ID));
    }

    #[test]
    fn codex_and_cursor_faults_leave_no_half_session_or_index() {
        let fixture = Fixture::new();
        let codex = codex_archive(&fixture, OTHER_ID);
        assert!(import_session_archive_in(
            &fixture.home,
            &codex,
            &fixture.path(&fixture.target),
            &fixture.path(&fixture.target),
            ImportFault::AfterIndexAppend,
        )
        .is_err());
        assert!(
            find_existing_session(&fixture.home, ArchiveAgent::Codex, OTHER_ID)
                .unwrap()
                .is_none()
        );
        let index = fixture.home.join(".codex/session_index.jsonl");
        assert!(!index.exists() || !fs::read_to_string(index).unwrap().contains(OTHER_ID));

        let cursor = cursor_archive(&fixture, ID);
        assert!(import_session_archive_in(
            &fixture.home,
            &cursor,
            &fixture.path(&fixture.target),
            &fixture.path(&fixture.target),
            ImportFault::AfterPayloadCommit,
        )
        .is_err());
        assert!(
            find_existing_session(&fixture.home, ArchiveAgent::Cursor, ID)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn claude_mixed_historical_versions_accept_last_valid_authority() {
        let fixture = Fixture::new();
        let archive = mixed_version_claude_archive(&fixture, ID);
        let result = import(&fixture, &archive, &fixture.target).expect("import mixed versions");
        assert_eq!(result.status, "imported");
    }

    #[test]
    fn partial_index_append_is_truncated_to_exact_original_prefix() {
        let fixture = Fixture::new();
        let claude = fixture.home.join(".claude");
        fs::create_dir(&claude).unwrap();
        let history = claude.join("history.jsonl");
        let baseline = br#"{"sessionId":"existing","project":"existing"}
"#;
        fs::write(&history, baseline).unwrap();
        let archive = claude_archive(&fixture, OTHER_ID, false);
        let result = import_session_archive_in(
            &fixture.home,
            &archive,
            &fixture.path(&fixture.target),
            &fixture.path(&fixture.target),
            ImportFault::DuringIndexAppend,
        );
        assert!(result.is_err());
        assert_eq!(fs::read(&history).unwrap(), baseline);
        assert!(
            find_existing_session(&fixture.home, ArchiveAgent::Claude, OTHER_ID)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn write_before_sync_failure_is_rolled_back_from_registered_receipt() {
        let fixture = Fixture::new();
        let archive = claude_archive(&fixture, OTHER_ID, false);
        let result = import_session_archive_in(
            &fixture.home,
            &archive,
            &fixture.path(&fixture.target),
            &fixture.path(&fixture.target),
            ImportFault::AfterIndexWriteBeforeSync,
        );
        assert!(result.is_err());
        assert!(
            find_existing_session(&fixture.home, ArchiveAgent::Claude, OTHER_ID)
                .unwrap()
                .is_none()
        );
        let history = fixture.home.join(".claude/history.jsonl");
        assert!(!history.exists() || !fs::read_to_string(history).unwrap().contains(OTHER_ID));
    }

    #[test]
    fn truncate_sync_failure_restores_index_tail_and_payload_visibility() {
        let fixture = Fixture::new();
        let archive = claude_archive(&fixture, OTHER_ID, false);
        let error = import_session_archive_in(
            &fixture.home,
            &archive,
            &fixture.path(&fixture.target),
            &fixture.path(&fixture.target),
            ImportFault::RollbackIndexSyncFailure,
        )
        .expect_err("injected rollback sync failure must surface");
        assert!(error.contains("已恢复完整业务 append"));
        assert!(
            find_existing_session(&fixture.home, ArchiveAgent::Claude, OTHER_ID)
                .unwrap()
                .is_some()
        );
        assert!(
            fs::read_to_string(fixture.home.join(".claude/history.jsonl"))
                .unwrap()
                .contains(OTHER_ID)
        );
    }

    #[test]
    fn partial_append_plus_truncate_sync_failure_restores_complete_business_line() {
        let fixture = Fixture::new();
        let archive = claude_archive(&fixture, OTHER_ID, false);
        let error = import_session_archive_in(
            &fixture.home,
            &archive,
            &fixture.path(&fixture.target),
            &fixture.path(&fixture.target),
            ImportFault::PartialAppendRollbackSyncFailure,
        )
        .expect_err("combined append/rollback fault must surface");
        assert!(error.contains("已恢复完整业务 append"));
        let history = fs::read(fixture.home.join(".claude/history.jsonl")).unwrap();
        assert!(history.ends_with(b"\n"));
        let lines = std::str::from_utf8(&history).unwrap().lines();
        let values = lines
            .map(|line| serde_json::from_str::<Value>(line).expect("complete JSONL line"))
            .collect::<Vec<_>>();
        assert!(values
            .iter()
            .any(|value| { value.get("sessionId").and_then(Value::as_str) == Some(OTHER_ID) }));
        assert!(
            find_existing_session(&fixture.home, ArchiveAgent::Claude, OTHER_ID)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn recovery_sync_failure_still_restores_visible_index_and_native_payload() {
        let fixture = Fixture::new();
        let archive = claude_archive(&fixture, OTHER_ID, false);
        let error = import_session_archive_in(
            &fixture.home,
            &archive,
            &fixture.path(&fixture.target),
            &fixture.path(&fixture.target),
            ImportFault::PartialAppendRollbackRecoverySyncFailure,
        )
        .expect_err("recovery sync fault must surface");
        assert!(error.contains("完整业务 append 已写回，但恢复 sync 失败"));
        let history = fs::read(fixture.home.join(".claude/history.jsonl")).unwrap();
        assert!(history.ends_with(b"\n"));
        for line in std::str::from_utf8(&history).unwrap().lines() {
            serde_json::from_str::<Value>(line).expect("recovery must leave complete JSONL");
        }
        assert!(
            find_existing_session(&fixture.home, ArchiveAgent::Claude, OTHER_ID)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn create_new_collision_never_overwrites_external_index() {
        let fixture = Fixture::new();
        let path = fixture.home.join("index.jsonl");
        let pending = PendingAppend {
            path: path.clone(),
            bytes: b"{\"ours\":true}\n".to_vec(),
            expected: IndexSnapshot {
                existed: false,
                len: 0,
                sha256: empty_sha256(),
            },
        };
        let external = b"{\"external\":true}\n";
        fs::write(&path, external).unwrap();
        let mut receipt = None;
        assert!(apply_append(&pending, &mut receipt, ImportFault::None).is_err());
        assert!(receipt.is_none());
        assert_eq!(fs::read(path).unwrap(), external);
    }

    #[test]
    fn oversized_native_index_is_rejected_before_payload_commit() {
        let fixture = Fixture::new();
        let claude = fixture.home.join(".claude");
        fs::create_dir(&claude).unwrap();
        let history = claude.join("history.jsonl");
        let file = File::create(&history).unwrap();
        file.set_len(MAX_NATIVE_INDEX_BYTES + 1).unwrap();
        drop(file);
        let archive = claude_archive(&fixture, OTHER_ID, false);
        let error = import(&fixture, &archive, &fixture.target)
            .expect_err("oversized index must fail before payload commit");
        assert!(error.contains("256 MiB"));
        assert!(
            find_existing_session(&fixture.home, ArchiveAgent::Claude, OTHER_ID)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn pending_append_cannot_push_index_past_business_limit() {
        let error = pending_append(
            PathBuf::from("index.jsonl"),
            vec![b'x'; 6],
            IndexSnapshot {
                existed: true,
                len: MAX_NATIVE_INDEX_BYTES - 5,
                sha256: empty_sha256(),
            },
        )
        .expect_err("combined index size must be bounded");
        assert!(error.contains("append 后原生索引"));
    }

    #[test]
    fn existing_claude_tree_hash_respects_entry_limit() {
        let root = tempfile::tempdir().unwrap();
        let mut items = (0..ArchiveLimits::session().max_entries)
            .map(|index| HashItem {
                archive_path: format!("payload/existing-{index}"),
                kind: ArchiveEntryKind::Directory,
                source: None,
            })
            .collect::<Vec<_>>();
        let mut total = 0;
        let error = append_native_tree_items(root.path(), "payload/tasks", &mut items, &mut total)
            .expect_err("existing tree must honor entry limit");
        assert!(error.contains("entry 数"));
    }

    #[test]
    fn rollback_preserves_payload_when_index_has_external_suffix() {
        let fixture = Fixture::new();
        let index = fixture.home.join("index.jsonl");
        let original = b"{\"base\":true}\n";
        let appended = b"{\"ours\":true}\n".to_vec();
        let mut original_hasher = Sha256::new();
        original_hasher.update(original);
        fs::write(&index, original).unwrap();
        let payload = fixture.home.join("payload.jsonl");
        fs::write(&payload, b"payload").unwrap();
        let fingerprint = raw_path_fingerprint(&payload).unwrap();
        let mut file = OpenOptions::new().append(true).open(&index).unwrap();
        file.write_all(&appended).unwrap();
        file.write_all(b"{\"external\":true}\n").unwrap();
        file.sync_all().unwrap();
        drop(file);
        let mut receipt = CommitReceipt {
            paths: vec![CommittedPath {
                path: payload.clone(),
                fingerprint,
            }],
            created_dirs: Vec::new(),
            append: Some(AppendReceipt {
                path: index,
                original_len: original.len() as u64,
                original_sha256: original_hasher.finalize().into(),
                appended,
                inject_rollback_sync_failure: false,
                inject_rollback_recovery_sync_failure: false,
            }),
        };
        let error = rollback_commit(&fixture.home, &mut receipt)
            .expect_err("unprovable index rollback must preserve payload");
        assert!(error.contains("外部追加"));
        assert_eq!(fs::read(payload).unwrap(), b"payload");
    }

    #[test]
    fn rollback_preserves_all_payload_when_one_path_changed() {
        let fixture = Fixture::new();
        let first = fixture.home.join("first.jsonl");
        let second = fixture.home.join("second.jsonl");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        let index = fixture.home.join("history.jsonl");
        let index_original = b"{\"base\":true}\n";
        let index_append = b"{\"ours\":true}\n".to_vec();
        fs::write(
            &index,
            [index_original.as_slice(), index_append.as_slice()].concat(),
        )
        .unwrap();
        let mut index_hasher = Sha256::new();
        index_hasher.update(index_original);
        let mut receipt = CommitReceipt {
            paths: vec![
                CommittedPath {
                    path: first.clone(),
                    fingerprint: raw_path_fingerprint(&first).unwrap(),
                },
                CommittedPath {
                    path: second.clone(),
                    fingerprint: raw_path_fingerprint(&second).unwrap(),
                },
            ],
            created_dirs: Vec::new(),
            append: Some(AppendReceipt {
                path: index.clone(),
                original_len: index_original.len() as u64,
                original_sha256: index_hasher.finalize().into(),
                appended: index_append.clone(),
                inject_rollback_sync_failure: false,
                inject_rollback_recovery_sync_failure: false,
            }),
        };
        fs::write(&second, b"external replacement").unwrap();
        assert!(rollback_commit(&fixture.home, &mut receipt).is_err());
        assert!(first.exists());
        assert_eq!(fs::read(second).unwrap(), b"external replacement");
        assert_eq!(
            fs::read(index).unwrap(),
            [index_original.as_slice(), index_append.as_slice()].concat()
        );
    }

    #[test]
    fn restore_held_payloads_reports_missing_staged_path() {
        let fixture = Fixture::new();
        let failures = restore_held_payloads(&[(
            fixture.home.join("original.jsonl"),
            fixture.home.join("missing-staged.jsonl"),
        )]);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("已缺失"));
    }

    #[test]
    fn final_holding_verification_rejects_replacement_without_deleting_it() {
        let fixture = Fixture::new();
        let staged = fixture.home.join("held.jsonl");
        fs::write(&staged, b"ours").unwrap();
        let receipt = CommitReceipt {
            paths: vec![CommittedPath {
                path: fixture.home.join("original.jsonl"),
                fingerprint: raw_path_fingerprint(&staged).unwrap(),
            }],
            created_dirs: Vec::new(),
            append: None,
        };
        fs::write(&staged, b"external replacement").unwrap();
        let error = verify_held_payloads(
            &receipt,
            &[(fixture.home.join("original.jsonl"), staged.clone())],
        )
        .expect_err("replacement must block recursive holding deletion");
        assert!(error.contains("外部替换"));
        assert_eq!(fs::read(staged).unwrap(), b"external replacement");
    }

    #[test]
    fn target_cwd_and_project_dir_must_be_canonical_identity() {
        let fixture = Fixture::new();
        let archive = claude_archive(&fixture, ID, false);
        let error = import_session_archive_in(
            &fixture.home,
            &archive,
            &fixture.path(&fixture.target),
            &fixture.path(&fixture.target_two),
            ImportFault::None,
        )
        .expect_err("different target paths must fail");
        assert!(error.contains("同一规范工作区"));
        assert!(
            find_existing_session(&fixture.home, ArchiveAgent::Claude, ID)
                .unwrap()
                .is_none()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_target_anchor_is_case_insensitive_and_trailing_separator_free() {
        let fixture = Fixture::new();
        let archive = claude_archive(&fixture, ID, false);
        let canonical = fixture.path(&fixture.target);
        let cwd_alias = format!("{}/", canonical.to_uppercase().replace('\\', "/"));
        let result = import_session_archive_in(
            &fixture.home,
            &archive,
            &cwd_alias,
            &canonical,
            ImportFault::None,
        )
        .expect("case/trailing target alias should import");
        assert_eq!(result.status, "imported");
        let anchor = canonical_workspace_anchor(&fixture.target.canonicalize().unwrap()).unwrap();
        assert!(!anchor.ends_with('\\'));
        assert!(!anchor.contains('/'));
        let listed = list_claude_sessions_in(&fixture.home, &canonical);
        assert!(listed.iter().any(|session| session.id == ID));
        let located = locate_claude_session_in(&fixture.home, ID, &canonical)
            .expect("reload with conventional target spelling");
        let first: Value = serde_json::from_str(
            fs::read_to_string(located.transcript)
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            first.get("cwd").and_then(Value::as_str),
            Some(anchor.as_str())
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_codex_and_cursor_source_aliases_rebind_but_real_switches_survive() {
        let fixture = Fixture::new();
        let source = fixture.path(&fixture.source);
        let alias = format!("{}\\", source.to_uppercase());
        let switch = fixture.path(&fixture.target_two);
        let rollout = write_lines(&[
            json!({"type":"session_meta","payload":{"id":ID,"cwd":&alias,"cli_version":"9.9.9"}}),
            json!({"type":"turn_context","payload":{"cwd":&alias}}),
            json!({"type":"turn_context","payload":{"cwd":&switch}}),
        ]);
        let relative = format!("2026/07/11/rollout-2026-07-11T12-34-56-{ID}.jsonl");
        let codex = write_archive(
            &fixture,
            "codex-source-alias",
            session_manifest(
                ArchiveAgent::Codex,
                ID,
                &source,
                CODEX_SESSION_SCHEMA,
                "9.9.9",
                None,
                Some(relative),
                vec![ArchiveCapability::Rollout],
            ),
            vec![PackageSource::Bytes {
                archive_path: CODEX_ROLLOUT_ENTRY.into(),
                data: rollout,
            }],
        );
        import(&fixture, &codex, &fixture.target).expect("import aliased Codex cwd");
        let located = locate_codex_session_in(&fixture.home, ID, &fixture.path(&fixture.target))
            .expect("locate aliased Codex import");
        let values: Vec<Value> = fs::read_to_string(located.rollout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let target = fixture.path(&fixture.target);
        assert_eq!(
            values[0].pointer("/payload/cwd").and_then(Value::as_str),
            Some(target.as_str())
        );
        assert_eq!(
            values[1].pointer("/payload/cwd").and_then(Value::as_str),
            Some(target.as_str())
        );
        assert_eq!(
            values[2].pointer("/payload/cwd").and_then(Value::as_str),
            Some(switch.as_str())
        );

        let cursor =
            cursor_archive_with_meta_cwd(&fixture, OTHER_ID, &alias, "cursor-source-alias");
        import(&fixture, &cursor, &fixture.target).expect("import aliased Cursor cwd");
        let cursor =
            locate_cursor_session_in(&fixture.home, OTHER_ID, &fixture.path(&fixture.target))
                .expect("locate aliased Cursor import");
        let meta = read_small_json(&cursor.meta, "imported Cursor meta").unwrap();
        assert_eq!(
            meta.get("cwd").and_then(Value::as_str),
            Some(target.as_str())
        );
    }
}
