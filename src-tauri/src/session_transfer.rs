//! Portable export for one authoritative Claude, Codex, or Cursor session.
//! Import and Tauri command wiring live in later plan steps.

use crate::portable_archive::{
    ensure_extension, write_package, ArchiveAgent, ArchiveCapability, ArchiveLimits, PackageKind,
    PackageSource, PortableManifest, SessionManifest, PACKAGE_VERSION, SESSION_EXTENSION,
};
use crate::sessions::{
    locate_session, validate_source_hint, ClaudeSessionLocation, CodexSessionLocation,
    CursorSessionLocation, LocatedSession, SessionAgent, CLAUDE_SESSION_SCHEMA,
    CODEX_SESSION_SCHEMA, CURSOR_SESSION_SCHEMA,
};
use rusqlite::backup::{Backup, StepResult};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tempfile::TempDir;
use walkdir::WalkDir;

pub(crate) const CLAUDE_TRANSCRIPT_ENTRY: &str = "payload/transcript.jsonl";
pub(crate) const CLAUDE_HISTORY_ENTRY: &str = "payload/history.jsonl";
pub(crate) const CLAUDE_SUBAGENTS_ROOT: &str = "payload/subagents";
pub(crate) const CLAUDE_TOOL_RESULTS_ROOT: &str = "payload/tool-results";
pub(crate) const CLAUDE_TASKS_ROOT: &str = "payload/tasks";
pub(crate) const CODEX_ROLLOUT_ENTRY: &str = "payload/rollout.jsonl";
pub(crate) const CURSOR_META_ENTRY: &str = "payload/meta.json";
pub(crate) const CURSOR_PROMPT_HISTORY_ENTRY: &str = "payload/prompt_history.json";
pub(crate) const CURSOR_STORE_DB_ENTRY: &str = "payload/store.db";

const MAX_JSONL_LINE_BYTES: usize = 16 * 1024 * 1024;
const MAX_SMALL_JSON_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SESSION_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_SESSION_TOTAL_BYTES: u64 = 3 * 1024 * 1024 * 1024;
const SQLITE_BACKUP_DEADLINE: Duration = Duration::from_secs(15);
const SQLITE_TRANSIENT_RETRIES: usize = 100;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionExportResult {
    pub agent: String,
    pub id: String,
    pub label: Option<String>,
    pub path: String,
    pub bytes: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Default)]
struct JsonlSnapshot {
    complete_lines: usize,
    included_lines: usize,
    invalid_lines: usize,
    discarded_tail: bool,
}

struct PreparedExport {
    agent: ArchiveAgent,
    id: String,
    source_cwd: String,
    source_agent_version: String,
    source_schema_version: String,
    label: Option<String>,
    native_relative_path: Option<String>,
    capabilities: Vec<ArchiveCapability>,
    sources: Vec<PackageSource>,
    limits: ArchiveLimits,
    warnings: Vec<String>,
    _workdir: TempDir,
}

#[derive(Debug, Clone)]
enum ProtectedSource {
    File(PathBuf),
    Tree(PathBuf),
}

pub fn export_session_archive(
    agent: &str,
    id: &str,
    cwd: &str,
    source_path: Option<&str>,
    destination: &str,
) -> Result<SessionExportResult, String> {
    let agent = SessionAgent::try_from(agent)?;
    let located = locate_session(agent, id, cwd)?;
    let authoritative = match &located {
        LocatedSession::Claude(value) => &value.transcript,
        LocatedSession::Codex(value) => &value.rollout,
        LocatedSession::Cursor(value) => &value.chat_dir,
    };
    validate_source_hint(source_path, authoritative)?;
    let (cursor_version, version_warning): (Option<String>, Option<String>) =
        if matches!(located, LocatedSession::Cursor(_)) {
            (
                Some("not-recorded-by-cursor-chat-v1".into()),
                Some("Cursor chat V1 不记录 CLI 版本，manifest 已明确标记为未记录。".into()),
            )
        } else {
            (None, None)
        };
    let mut result =
        export_located_session(located, Path::new(destination), cursor_version.as_deref())?;
    if let Some(warning) = version_warning {
        result.warnings.push(warning);
    }
    Ok(result)
}

fn protected_session_sources(location: &LocatedSession) -> Vec<ProtectedSource> {
    match location {
        LocatedSession::Claude(value) => {
            let mut sources = vec![
                ProtectedSource::File(value.transcript.clone()),
                ProtectedSource::File(value.history.clone()),
            ];
            if let Some(path) = &value.sidecar_dir {
                sources.push(ProtectedSource::Tree(path.clone()));
            }
            if let Some(path) = &value.tasks_dir {
                sources.push(ProtectedSource::Tree(path.clone()));
            }
            sources
        }
        LocatedSession::Codex(value) => {
            vec![ProtectedSource::File(value.rollout.clone())]
        }
        LocatedSession::Cursor(value) => {
            vec![ProtectedSource::Tree(value.chat_dir.clone())]
        }
    }
}

fn canonical_export_target(destination: &Path) -> Result<PathBuf, String> {
    let requested = ensure_extension(destination, SESSION_EXTENSION);
    let parent = requested
        .parent()
        .ok_or_else(|| "导出目标没有父目录".to_string())?;
    let parent = parent
        .canonicalize()
        .map_err(|error| format!("导出父目录无效 {}：{error}", parent.display()))?;
    let metadata = crate::portable_archive::reject_link_or_reparse(&parent)?;
    if !metadata.is_dir() {
        return Err("导出父路径不是普通目录".into());
    }
    let file_name = requested
        .file_name()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "导出目标缺少文件名".to_string())?;
    let target = parent.join(file_name);
    match std::fs::symlink_metadata(&target) {
        Ok(_) => {
            let metadata = crate::portable_archive::reject_link_or_reparse(&target)?;
            if !metadata.is_file() {
                return Err("导出目标不是普通文件".into());
            }
            target
                .canonicalize()
                .map_err(|error| format!("解析现有导出目标失败：{error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(target),
        Err(error) => Err(format!("检查导出目标失败：{error}")),
    }
}

fn reject_export_source_overlap(
    destination: &Path,
    protected: &[ProtectedSource],
) -> Result<(), String> {
    let target = canonical_export_target(destination)?;
    for source in protected {
        let (path, recursive) = match source {
            ProtectedSource::File(path) => (path, false),
            ProtectedSource::Tree(path) => (path, true),
        };
        let metadata = crate::portable_archive::reject_link_or_reparse(path)?;
        if recursive && !metadata.is_dir() {
            return Err(format!("Session 递归源不再是目录：{}", path.display()));
        }
        if !recursive && !metadata.is_file() {
            return Err(format!("Session 文件源不再是普通文件：{}", path.display()));
        }
        let source = path
            .canonicalize()
            .map_err(|error| format!("解析 Session 源路径失败 {}：{error}", path.display()))?;
        if target == source || recursive && target.starts_with(&source) {
            return Err(format!(
                "导出目标与 Session 源 payload 重叠，拒绝覆盖：{}",
                target.display()
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn directory_identity(metadata: &std::fs::Metadata) -> (u64, u32) {
    use std::os::windows::fs::MetadataExt;
    (metadata.creation_time(), metadata.file_attributes())
}

#[cfg(unix)]
fn directory_identity(metadata: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}

#[cfg(not(any(windows, unix)))]
fn directory_identity(metadata: &std::fs::Metadata) -> (u64, u64) {
    (metadata.len(), 0)
}

fn commit_staged_package(
    staged: &Path,
    destination: &Path,
    protected: &[ProtectedSource],
) -> Result<(PathBuf, u64), String> {
    commit_staged_package_with_hook(staged, destination, protected, || Ok(()))
}

fn commit_staged_package_with_hook(
    staged: &Path,
    destination: &Path,
    protected: &[ProtectedSource],
    before_final_check: impl FnOnce() -> Result<(), String>,
) -> Result<(PathBuf, u64), String> {
    let final_path = canonical_export_target(destination)?;
    reject_export_source_overlap(destination, protected)?;
    let parent = final_path
        .parent()
        .ok_or_else(|| "导出目标缺少父目录".to_string())?;
    let parent_metadata = crate::portable_archive::reject_link_or_reparse(parent)?;
    let expected_parent_identity = directory_identity(&parent_metadata);
    let mut temp = tempfile::Builder::new()
        .prefix(".htybox-session-commit-")
        .tempfile_in(parent)
        .map_err(|error| format!("创建 Session 最终提交临时文件失败：{error}"))?;
    let staged_metadata = crate::portable_archive::reject_link_or_reparse(staged)?;
    if !staged_metadata.is_file() {
        return Err("Session staging 包不是普通文件".into());
    }
    let mut source = File::open(staged).map_err(|error| error.to_string())?;
    let copied = std::io::copy(
        &mut std::io::Read::by_ref(&mut source).take(staged_metadata.len()),
        temp.as_file_mut(),
    )
    .map_err(|error| format!("复制 Session staging 包失败：{error}"))?;
    if copied != staged_metadata.len() {
        return Err("Session staging 包复制时被截断".into());
    }
    temp.as_file()
        .sync_all()
        .map_err(|error| format!("同步 Session 最终提交临时文件失败：{error}"))?;

    // This is the final source-overlap check, immediately before persist. The
    // package is already complete and self-validated, so no long I/O remains.
    before_final_check()?;
    reject_export_source_overlap(destination, protected)?;
    let rechecked = canonical_export_target(destination)?;
    if rechecked != final_path {
        return Err("导出目标在最终提交前发生路径切换，拒绝 persist".into());
    }
    let current_parent = crate::portable_archive::reject_link_or_reparse(parent)?;
    if directory_identity(&current_parent) != expected_parent_identity {
        return Err("导出父目录在最终提交前被替换，拒绝 persist".into());
    }
    let bytes = temp
        .as_file()
        .metadata()
        .map_err(|error| error.to_string())?
        .len();
    temp.persist(&final_path)
        .map_err(|error| format!("提交 Session 导出文件失败：{}", error.error))?;
    Ok((final_path, bytes))
}

fn export_located_session(
    location: LocatedSession,
    destination: &Path,
    cursor_version: Option<&str>,
) -> Result<SessionExportResult, String> {
    let protected_sources = protected_session_sources(&location);
    reject_export_source_overlap(destination, &protected_sources)?;
    let prepared = match location {
        LocatedSession::Claude(value) => prepare_claude_export(value)?,
        LocatedSession::Codex(value) => prepare_codex_export(value)?,
        LocatedSession::Cursor(value) => prepare_cursor_export(
            value,
            cursor_version.ok_or_else(|| "缺少 Cursor Agent 版本".to_string())?,
        )?,
    };
    // Re-resolve after the source snapshot so parent aliases/reparse changes do
    // not let the final package replace a payload that was just exported.
    reject_export_source_overlap(destination, &protected_sources)?;
    let exported_at_ms = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "系统时间早于 Unix epoch".to_string())?
            .as_millis(),
    )
    .map_err(|_| "系统时间超出 manifest 范围".to_string())?;
    let manifest = PortableManifest::Session(SessionManifest {
        version: PACKAGE_VERSION,
        kind: PackageKind::Session,
        agent: prepared.agent,
        session_id: prepared.id.clone(),
        source_cwd: prepared.source_cwd,
        source_agent_version: prepared.source_agent_version,
        source_schema_version: prepared.source_schema_version,
        exported_at_ms,
        label: prepared.label.clone(),
        native_relative_path: prepared.native_relative_path,
        capabilities: prepared.capabilities,
        entries: Vec::new(),
    });
    let package_stage = new_workdir()?;
    let staged = write_package(
        &package_stage.path().join("package"),
        SESSION_EXTENSION,
        manifest,
        prepared.sources,
        prepared.limits,
    )?;
    let (path, bytes) = commit_staged_package(&staged.path, destination, &protected_sources)?;
    Ok(SessionExportResult {
        agent: archive_agent_name(prepared.agent).into(),
        id: prepared.id,
        label: prepared.label,
        path: path.to_string_lossy().into_owned(),
        bytes,
        warnings: prepared.warnings,
    })
}

fn archive_agent_name(agent: ArchiveAgent) -> &'static str {
    match agent {
        ArchiveAgent::Claude => "claude",
        ArchiveAgent::Codex => "codex",
        ArchiveAgent::Cursor => "cursor",
    }
}

fn session_limits(max_entries: usize) -> ArchiveLimits {
    ArchiveLimits {
        max_entries,
        max_file_bytes: MAX_SESSION_FILE_BYTES,
        max_total_bytes: MAX_SESSION_TOTAL_BYTES,
        max_compression_ratio: 1_000,
    }
}

fn base_warnings() -> Vec<String> {
    vec![
        "导出的包是明文敏感数据，可能包含对话、代码和工具输出，请妥善保管。".into(),
        "会话引用的外部附件、工作区文件、MCP 资源和凭据未内嵌。".into(),
    ]
}

fn visit_fixed_jsonl(
    source: &Path,
    mut visit: impl FnMut(&[u8]) -> Result<(), String>,
) -> Result<(usize, bool), String> {
    crate::portable_archive::reject_link_or_reparse(source)?;
    let file = File::open(source).map_err(|error| format!("打开 JSONL 失败：{error}"))?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    if length > MAX_SESSION_FILE_BYTES {
        return Err(format!(
            "JSONL 超过 Session 单文件上限：{}",
            source.display()
        ));
    }
    let mut reader = file.take(length);
    let mut chunk = [0u8; 64 * 1024];
    let mut pending = Vec::new();
    let mut lines = 0usize;
    let mut total_read = 0u64;
    loop {
        let read = reader.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        total_read = total_read
            .checked_add(read as u64)
            .ok_or_else(|| "JSONL 固定长度读取计数溢出".to_string())?;
        let mut start = 0usize;
        for (index, byte) in chunk[..read].iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            pending.extend_from_slice(&chunk[start..index]);
            if pending.len() > MAX_JSONL_LINE_BYTES {
                return Err("JSONL 单行超过 16 MiB".into());
            }
            visit(&pending)?;
            pending.clear();
            lines += 1;
            start = index + 1;
        }
        pending.extend_from_slice(&chunk[start..read]);
        if pending.len() > MAX_JSONL_LINE_BYTES {
            return Err("JSONL 单行超过 16 MiB".into());
        }
    }
    if total_read != length {
        return Err(format!(
            "JSONL 在快照读取时被截短：预期 {length} bytes，实际 {total_read} bytes"
        ));
    }
    Ok((lines, !pending.is_empty()))
}

fn write_jsonl_snapshot(
    source: &Path,
    destination: &Path,
    reject_invalid: bool,
    mut include: impl FnMut(&serde_json::Value) -> Result<bool, String>,
) -> Result<JsonlSnapshot, String> {
    write_jsonl_snapshot_inner(source, destination, reject_invalid, false, |value| {
        include(value)
    })
}

fn write_normalized_jsonl_snapshot(
    source: &Path,
    destination: &Path,
    reject_invalid: bool,
    include: impl FnMut(&mut serde_json::Value) -> Result<bool, String>,
) -> Result<JsonlSnapshot, String> {
    write_jsonl_snapshot_inner(source, destination, reject_invalid, true, include)
}

fn write_jsonl_snapshot_inner(
    source: &Path,
    destination: &Path,
    reject_invalid: bool,
    rewrite_json: bool,
    mut include: impl FnMut(&mut serde_json::Value) -> Result<bool, String>,
) -> Result<JsonlSnapshot, String> {
    let mut target =
        File::create(destination).map_err(|error| format!("创建 JSONL 快照失败：{error}"))?;
    let mut report = JsonlSnapshot::default();
    let (complete_lines, discarded_tail) = visit_fixed_jsonl(source, |raw_line| {
        let json_line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        let mut value = match serde_json::from_slice::<serde_json::Value>(json_line) {
            Ok(value) => value,
            Err(error) if reject_invalid => {
                return Err(format!("JSONL 含无效完整行：{error}"));
            }
            Err(_) => {
                report.invalid_lines += 1;
                return Ok(());
            }
        };
        if include(&mut value)? {
            if rewrite_json {
                serde_json::to_writer(&mut target, &value).map_err(|error| error.to_string())?;
            } else {
                target
                    .write_all(raw_line)
                    .map_err(|error| error.to_string())?;
            }
            target.write_all(b"\n").map_err(|error| error.to_string())?;
            report.included_lines += 1;
        }
        Ok(())
    })?;
    target
        .sync_all()
        .map_err(|error| format!("同步 JSONL 快照失败：{error}"))?;
    report.complete_lines = complete_lines;
    report.discarded_tail = discarded_tail;
    Ok(report)
}

fn snapshot_small_json_once(source: &Path) -> Result<Vec<u8>, String> {
    crate::portable_archive::reject_link_or_reparse(source)?;
    let mut file = File::open(source).map_err(|error| error.to_string())?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    if length == 0 || length > MAX_SMALL_JSON_BYTES {
        return Err(format!("JSON 文件为空或超过 4 MiB：{}", source.display()));
    }
    let length = usize::try_from(length).map_err(|_| "JSON 文件长度溢出".to_string())?;
    let mut bytes = vec![0u8; length];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("读取固定长度 JSON 快照失败：{error}"))?;
    Ok(bytes)
}

fn snapshot_small_json(source: &Path) -> Result<Vec<u8>, String> {
    for attempt in 0..3 {
        let first = snapshot_small_json_once(source)?;
        thread::sleep(Duration::from_millis(5));
        let second = snapshot_small_json_once(source)?;
        if first == second {
            return Ok(second);
        }
        if attempt < 2 {
            thread::sleep(Duration::from_millis(10));
        }
    }
    Err(format!(
        "JSON 文件持续变化，三次稳定双读均失败：{}",
        source.display()
    ))
}

fn json_string(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
}

fn tail_warning(report: &JsonlSnapshot, warnings: &mut Vec<String>) {
    if report.discarded_tail {
        warnings.push("活动 JSONL 末尾尚未完成的不完整记录未导出。".into());
    }
}

fn new_workdir() -> Result<TempDir, String> {
    tempfile::Builder::new()
        .prefix(".htybox-session-export-")
        .tempdir()
        .map_err(|error| format!("创建 Session 导出 staging 失败：{error}"))
}

fn workspace_matches(value: &str, expected: &Path) -> bool {
    let candidate = Path::new(value);
    if !candidate.is_absolute() {
        return false;
    }
    let Ok(metadata) = crate::portable_archive::reject_link_or_reparse(candidate) else {
        return false;
    };
    if !metadata.is_dir() {
        return false;
    }
    let (Ok(candidate), Ok(expected)) = (candidate.canonicalize(), expected.canonicalize()) else {
        return false;
    };
    candidate == expected
}

fn normalize_workspace_field(
    value: &mut serde_json::Value,
    field: &str,
    expected: &Path,
    anchor: &str,
) {
    let matches = value
        .get(field)
        .and_then(|item| item.as_str())
        .is_some_and(|item| workspace_matches(item, expected));
    if matches {
        if let Some(object) = value.as_object_mut() {
            object.insert(field.into(), serde_json::Value::String(anchor.into()));
        }
    }
}

fn prepare_claude_export(location: ClaudeSessionLocation) -> Result<PreparedExport, String> {
    let workdir = new_workdir()?;
    let transcript_snapshot = workdir.path().join("transcript.jsonl");
    let expected_workspace = PathBuf::from(&location.source_cwd);
    let mut title = None;
    let mut authoritative_version: Option<String> = None;
    let transcript_report = write_normalized_jsonl_snapshot(
        &location.transcript,
        &transcript_snapshot,
        true,
        |value| {
            if let Some(found_id) = value.get("sessionId").and_then(|item| item.as_str()) {
                if found_id != location.id {
                    return Err("Claude transcript 快照内 sessionId 冲突".into());
                }
            }
            if value.get("type").and_then(|item| item.as_str()) == Some("ai-title") {
                if let Some(next) = json_string(value, "aiTitle") {
                    title = Some(next);
                }
            }
            let body = matches!(
                value.get("type").and_then(|item| item.as_str()),
                Some("user" | "assistant" | "system" | "attachment")
            );
            if body {
                let record_id = value.get("sessionId").and_then(|item| item.as_str());
                let record_cwd = value.get("cwd").and_then(|item| item.as_str());
                let version = json_string(value, "version");
                if record_id == Some(location.id.as_str())
                    && record_cwd.is_some_and(|cwd| workspace_matches(cwd, &expected_workspace))
                {
                    if let Some(version) = version {
                        authoritative_version = Some(version);
                    }
                }
            }
            normalize_workspace_field(value, "cwd", &expected_workspace, &location.source_cwd);
            Ok(true)
        },
    )?;
    if transcript_report.included_lines == 0 {
        return Err("Claude transcript 没有完整 JSONL 记录".into());
    }

    let snapshot_version = authoritative_version
        .ok_or_else(|| "Claude transcript 快照缺少 id/cwd/version 权威正文记录".to_string())?;
    let history_snapshot = workdir.path().join("history.jsonl");
    let mut history_label: Option<(i64, String)> = None;
    let history_report =
        write_normalized_jsonl_snapshot(&location.history, &history_snapshot, false, |value| {
            if value.get("sessionId").and_then(|item| item.as_str()) != Some(location.id.as_str()) {
                return Ok(false);
            }
            if value
                .get("project")
                .and_then(|item| item.as_str())
                .is_none_or(|project| !workspace_matches(project, &expected_workspace))
            {
                return Ok(false);
            }
            if let Some(display) = json_string(value, "display") {
                if !display.starts_with('/') {
                    let timestamp = value
                        .get("timestamp")
                        .and_then(|item| item.as_i64())
                        .unwrap_or(0);
                    if history_label
                        .as_ref()
                        .is_none_or(|(current, _)| timestamp >= *current)
                    {
                        history_label = Some((timestamp, display));
                    }
                }
            }
            normalize_workspace_field(value, "project", &expected_workspace, &location.source_cwd);
            Ok(true)
        })?;
    if history_report.included_lines == 0 {
        return Err("固定长度 Claude history 快照不再包含当前 Session".into());
    }

    let mut warnings = base_warnings();
    tail_warning(&transcript_report, &mut warnings);
    tail_warning(&history_report, &mut warnings);
    if history_report.invalid_lines > 0 {
        warnings.push(format!(
            "Claude 全局 history 中有 {} 条无效 JSONL，已跳过且未写入包。",
            history_report.invalid_lines
        ));
    }

    let mut sources = vec![
        PackageSource::File {
            archive_path: CLAUDE_TRANSCRIPT_ENTRY.into(),
            source_path: transcript_snapshot.clone(),
        },
        PackageSource::File {
            archive_path: CLAUDE_HISTORY_ENTRY.into(),
            source_path: history_snapshot.clone(),
        },
    ];
    let mut staged_bytes = transcript_snapshot
        .metadata()
        .map_err(|error| error.to_string())?
        .len()
        .checked_add(
            history_snapshot
                .metadata()
                .map_err(|error| error.to_string())?
                .len(),
        )
        .ok_or_else(|| "Claude Session 快照总量溢出".to_string())?;
    if staged_bytes > MAX_SESSION_TOTAL_BYTES {
        return Err("Claude transcript + history 快照总量超过 3 GiB".into());
    }
    let mut capabilities = vec![ArchiveCapability::Transcript, ArchiveCapability::History];
    if let Some(root) = &location.subagents_dir {
        append_plain_tree(
            root,
            CLAUDE_SUBAGENTS_ROOT,
            &workdir.path().join("subagents"),
            &mut sources,
            &mut staged_bytes,
        )?;
        capabilities.push(ArchiveCapability::Subagents);
    }
    if let Some(root) = &location.tool_results_dir {
        append_plain_tree(
            root,
            CLAUDE_TOOL_RESULTS_ROOT,
            &workdir.path().join("tool-results"),
            &mut sources,
            &mut staged_bytes,
        )?;
        capabilities.push(ArchiveCapability::ToolResults);
    }
    if let Some(root) = &location.tasks_dir {
        append_plain_tree(
            root,
            CLAUDE_TASKS_ROOT,
            &workdir.path().join("tasks"),
            &mut sources,
            &mut staged_bytes,
        )?;
        capabilities.push(ArchiveCapability::Tasks);
    }
    if sources.len() >= 10_000 {
        return Err("Claude Session 白名单 entry 数达到 10,000 上限".into());
    }
    Ok(PreparedExport {
        agent: ArchiveAgent::Claude,
        id: location.id,
        source_cwd: location.source_cwd,
        source_agent_version: snapshot_version,
        source_schema_version: CLAUDE_SESSION_SCHEMA.into(),
        label: title.or_else(|| history_label.map(|(_, label)| label)),
        native_relative_path: None,
        capabilities,
        sources,
        limits: session_limits(10_000),
        warnings,
        _workdir: workdir,
    })
}

fn is_runtime_only_name(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let lowercase = name.to_ascii_lowercase();
    lowercase == ".lock"
        || lowercase.ends_with(".lock")
        || lowercase == "pid"
        || lowercase.ends_with(".pid")
        || lowercase == "session-env"
}

fn archive_relative_path(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => parts.push(
                value
                    .to_str()
                    .ok_or_else(|| "Session payload 路径不是 UTF-8".to_string())?,
            ),
            _ => return Err("Session payload 含非法相对路径组件".into()),
        }
    }
    if parts.is_empty() {
        return Err("Session payload 相对路径为空".into());
    }
    Ok(parts.join("/"))
}

fn append_plain_tree(
    root: &Path,
    archive_root: &str,
    scratch_root: &Path,
    sources: &mut Vec<PackageSource>,
    staged_bytes: &mut u64,
) -> Result<(), String> {
    let root_metadata = crate::portable_archive::reject_link_or_reparse(root)?;
    if !root_metadata.is_dir() {
        return Err(format!("Session 白名单根不是目录：{}", root.display()));
    }
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    std::fs::create_dir(scratch_root)
        .map_err(|error| format!("创建 Session 白名单快照根失败：{error}"))?;
    let mut iterator = WalkDir::new(root).follow_links(false).into_iter();
    while let Some(next) = iterator.next() {
        let entry = next.map_err(|error| format!("扫描 Session 白名单失败：{error}"))?;
        let metadata = crate::portable_archive::reject_link_or_reparse(entry.path())?;
        if entry.depth() > 0 && is_runtime_only_name(entry.path()) {
            if metadata.is_dir() {
                iterator.skip_current_dir();
            }
            continue;
        }
        let canonical = entry
            .path()
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let relative = canonical
            .strip_prefix(&canonical_root)
            .map_err(|_| "Session 白名单 entry 逃逸来源根".to_string())?;
        let archive_path = if relative.as_os_str().is_empty() {
            archive_root.to_string()
        } else {
            format!("{archive_root}/{}", archive_relative_path(relative)?)
        };
        let scratch_path = if relative.as_os_str().is_empty() {
            scratch_root.to_path_buf()
        } else {
            scratch_root.join(relative)
        };
        if sources.len() >= 9_999 {
            return Err("Claude Session 白名单 entry 数将超过 10,000（含 manifest）".into());
        }
        if metadata.is_dir() {
            if !relative.as_os_str().is_empty() {
                std::fs::create_dir(&scratch_path)
                    .map_err(|error| format!("创建白名单快照目录失败：{error}"))?;
            }
            sources.push(PackageSource::Directory { archive_path });
        } else if metadata.is_file() {
            if metadata.len() > MAX_SESSION_FILE_BYTES {
                return Err(format!(
                    "Claude sidecar 文件超过 2 GiB：{}",
                    canonical.display()
                ));
            }
            let next_total = staged_bytes
                .checked_add(metadata.len())
                .ok_or_else(|| "Claude Session sidecar 总量溢出".to_string())?;
            if next_total > MAX_SESSION_TOTAL_BYTES {
                return Err("Claude Session sidecar 快照总量将超过 3 GiB".into());
            }
            copy_fixed_file(&canonical, &scratch_path)?;
            *staged_bytes = next_total;
            sources.push(PackageSource::File {
                archive_path,
                source_path: scratch_path,
            });
        } else {
            return Err(format!(
                "Session 白名单只允许普通文件/目录：{}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

fn copy_fixed_file(source: &Path, destination: &Path) -> Result<(), String> {
    crate::portable_archive::reject_link_or_reparse(source)?;
    let source_file = File::open(source).map_err(|error| error.to_string())?;
    let metadata = source_file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_SESSION_FILE_BYTES {
        return Err(format!(
            "Session 白名单源不是普通文件或超过上限：{}",
            source.display()
        ));
    }
    let mut limited = source_file.take(metadata.len());
    let mut target = File::create(destination)
        .map_err(|error| format!("创建 Session 白名单文件快照失败：{error}"))?;
    let copied = std::io::copy(&mut limited, &mut target)
        .map_err(|error| format!("复制 Session 白名单文件失败：{error}"))?;
    if copied != metadata.len() {
        return Err(format!(
            "Session 白名单源在快照时被截断：{}",
            source.display()
        ));
    }
    target
        .sync_all()
        .map_err(|error| format!("同步 Session 白名单文件快照失败：{error}"))?;
    Ok(())
}

fn prepare_codex_export(location: CodexSessionLocation) -> Result<PreparedExport, String> {
    let workdir = new_workdir()?;
    let snapshot = workdir.path().join("rollout.jsonl");
    let expected_workspace = PathBuf::from(&location.source_cwd);
    let mut line_index = 0usize;
    let mut snapshot_meta: Option<(String, String)> = None;
    let report = write_jsonl_snapshot(&location.rollout, &snapshot, true, |value| {
        if line_index == 0 {
            if value.get("type").and_then(|item| item.as_str()) != Some("session_meta") {
                return Err("Codex rollout 快照首行不是 session_meta".into());
            }
            let payload = value
                .get("payload")
                .and_then(|item| item.as_object())
                .ok_or_else(|| "Codex session_meta 快照缺少 payload".to_string())?;
            if payload.get("id").and_then(|item| item.as_str()) != Some(location.id.as_str()) {
                return Err("Codex session_meta 快照 payload.id 不匹配".into());
            }
            let cwd = payload
                .get("cwd")
                .and_then(|item| item.as_str())
                .filter(|value| workspace_matches(value, &expected_workspace))
                .ok_or_else(|| "Codex session_meta 快照 cwd 不匹配".to_string())?;
            let version = payload
                .get("cli_version")
                .and_then(|item| item.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Codex session_meta 快照缺少 cli_version".to_string())?;
            snapshot_meta = Some((cwd.to_string(), version.to_string()));
        }
        line_index += 1;
        Ok(true)
    })?;
    if report.included_lines == 0 {
        return Err("Codex rollout 没有完整 JSONL 记录".into());
    }
    let (source_cwd, source_agent_version) =
        snapshot_meta.ok_or_else(|| "Codex rollout 快照缺少 session_meta".to_string())?;
    let mut warnings = base_warnings();
    tail_warning(&report, &mut warnings);
    let mut capabilities = vec![ArchiveCapability::Rollout];
    if location.native_title.is_some() {
        capabilities.push(ArchiveCapability::NativeTitle);
    }
    Ok(PreparedExport {
        agent: ArchiveAgent::Codex,
        id: location.id,
        source_cwd,
        source_agent_version,
        source_schema_version: CODEX_SESSION_SCHEMA.into(),
        label: location.native_title,
        native_relative_path: Some(archive_relative_path(&location.relative_rollout)?),
        capabilities,
        sources: vec![PackageSource::File {
            archive_path: CODEX_ROLLOUT_ENTRY.into(),
            source_path: snapshot,
        }],
        limits: session_limits(2),
        warnings,
        _workdir: workdir,
    })
}

fn validate_cursor_meta_snapshot(
    bytes: &[u8],
    location: &CursorSessionLocation,
) -> Result<Option<String>, String> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Cursor meta.json 快照无效：{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "Cursor meta.json 根必须是 object".to_string())?;
    if object.get("schemaVersion").and_then(|item| item.as_u64())
        != Some(u64::from(location.schema_version))
    {
        return Err("Cursor meta.json 在定位后发生 schema 变化".into());
    }
    if object.get("cwd").and_then(|item| item.as_str()) != Some(&location.source_cwd) {
        return Err("Cursor meta.json 在定位后发生 cwd 变化".into());
    }
    if object
        .get("id")
        .is_some_and(|item| item.as_str() != Some(&location.id))
    {
        return Err("Cursor meta.json id 与 chat 目录不一致".into());
    }
    if object
        .get("hasConversation")
        .and_then(|item| item.as_bool())
        != Some(true)
    {
        return Err("Cursor chat 尚无可导出的 conversation".into());
    }
    for field in ["createdAtMs", "updatedAtMs"] {
        if object
            .get(field)
            .and_then(|item| item.as_i64())
            .is_none_or(|value| value < 0)
        {
            return Err(format!("Cursor meta.json {field} 必须是非负整数"));
        }
    }
    if object
        .get("title")
        .is_some_and(|item| !item.is_null() && !item.is_string())
    {
        return Err("Cursor meta.json title 类型无效".into());
    }
    Ok(object
        .get("title")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string))
}

fn validate_cursor_prompt_snapshot(bytes: &[u8]) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Cursor prompt_history.json 快照无效：{error}"))?;
    if value
        .as_array()
        .is_none_or(|items| items.iter().any(|item| !item.is_string()))
    {
        return Err("Cursor prompt_history.json 必须是字符串数组".into());
    }
    Ok(())
}

fn sqlite_error(context: &str, error: rusqlite::Error) -> String {
    format!("{context}：{error}")
}

pub(crate) fn backup_cursor_database(source: &Path, destination: &Path) -> Result<(), String> {
    crate::portable_archive::reject_link_or_reparse(source)?;
    let source_connection = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| sqlite_error("只读打开 Cursor store.db 失败", error))?;
    source_connection
        .busy_timeout(Duration::from_millis(100))
        .map_err(|error| sqlite_error("设置 Cursor 源 DB busy timeout 失败", error))?;
    source_connection
        .execute_batch("PRAGMA query_only=ON;")
        .map_err(|error| sqlite_error("设置 Cursor 源 DB 只读模式失败", error))?;
    let mut destination_connection = Connection::open(destination)
        .map_err(|error| sqlite_error("创建 Cursor DB 快照失败", error))?;
    destination_connection
        .busy_timeout(Duration::from_millis(100))
        .map_err(|error| sqlite_error("设置 Cursor 快照 busy timeout 失败", error))?;
    let started = Instant::now();
    let mut transient_failures = 0usize;
    {
        let backup = Backup::new(&source_connection, &mut destination_connection)
            .map_err(|error| sqlite_error("初始化 Cursor SQLite Online Backup 失败", error))?;
        loop {
            if started.elapsed() >= SQLITE_BACKUP_DEADLINE {
                return Err("Cursor store.db 快照超过 15 秒期限".into());
            }
            let step = backup
                .step(128)
                .map_err(|error| sqlite_error("复制 Cursor store.db 页面失败", error))?;
            match step {
                StepResult::Done => break,
                StepResult::More => {
                    transient_failures = 0;
                    thread::sleep(Duration::from_millis(2));
                }
                StepResult::Busy | StepResult::Locked => {
                    transient_failures += 1;
                    if transient_failures > SQLITE_TRANSIENT_RETRIES {
                        return Err("Cursor store.db 持续 Busy/Locked，未生成不一致快照".into());
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                _ => return Err("Cursor SQLite Backup 返回未知状态".into()),
            }
        }
    }
    let journal_mode: String = destination_connection
        .query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))
        .map_err(|error| sqlite_error("收敛 Cursor 快照 journal mode 失败", error))?;
    if !journal_mode.eq_ignore_ascii_case("delete") {
        return Err(format!(
            "Cursor 快照未收敛为单文件 DELETE journal：{journal_mode}"
        ));
    }
    let mut integrity_statement = destination_connection
        .prepare("PRAGMA integrity_check")
        .map_err(|error| sqlite_error("准备 Cursor 快照完整性检查失败", error))?;
    let integrity_rows = integrity_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| sqlite_error("执行 Cursor 快照完整性检查失败", error))?;
    let integrity = integrity_rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| sqlite_error("读取 Cursor 快照完整性结果失败", error))?;
    drop(integrity_statement);
    if integrity.as_slice() != ["ok"] {
        return Err(format!(
            "Cursor store.db 快照 integrity_check 失败：{}",
            integrity.join("; ")
        ));
    }
    destination_connection
        .close()
        .map_err(|(_, error)| sqlite_error("关闭 Cursor 快照 DB 失败", error))?;
    source_connection
        .close()
        .map_err(|(_, error)| sqlite_error("关闭 Cursor 源 DB 失败", error))?;
    let snapshot_metadata = crate::portable_archive::reject_link_or_reparse(destination)?;
    if !snapshot_metadata.is_file()
        || snapshot_metadata.len() == 0
        || snapshot_metadata.len() > MAX_SESSION_FILE_BYTES
    {
        return Err("Cursor store.db 快照为空或超过 Session 单文件上限".into());
    }
    let snapshot_file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(destination)
        .map_err(|error| error.to_string())?;
    snapshot_file
        .sync_all()
        .map_err(|error| format!("同步 Cursor store.db 快照失败：{error}"))?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", destination.to_string_lossy()));
        if sidecar.exists() {
            return Err(format!(
                "Cursor DB 快照遗留 SQLite sidecar：{}",
                sidecar.display()
            ));
        }
    }
    Ok(())
}

fn prepare_cursor_export(
    location: CursorSessionLocation,
    source_agent_version: &str,
) -> Result<PreparedExport, String> {
    if source_agent_version.trim().is_empty()
        || source_agent_version.len() > 128
        || source_agent_version.chars().any(char::is_control)
    {
        return Err("Cursor Agent 版本为空或格式无效".into());
    }
    let workdir = new_workdir()?;
    let meta_bytes = snapshot_small_json(&location.meta)?;
    let snapshot_label = validate_cursor_meta_snapshot(&meta_bytes, &location)?;
    let mut sources = vec![PackageSource::Bytes {
        archive_path: CURSOR_META_ENTRY.into(),
        data: meta_bytes,
    }];
    let mut capabilities = vec![ArchiveCapability::Metadata];
    if let Some(prompt_path) = &location.prompt_history {
        let prompt_bytes = snapshot_small_json(prompt_path)?;
        validate_cursor_prompt_snapshot(&prompt_bytes)?;
        sources.push(PackageSource::Bytes {
            archive_path: CURSOR_PROMPT_HISTORY_ENTRY.into(),
            data: prompt_bytes,
        });
        capabilities.push(ArchiveCapability::PromptHistory);
    }
    let store_snapshot = workdir.path().join("store.db");
    backup_cursor_database(&location.store_db, &store_snapshot)?;
    sources.push(PackageSource::File {
        archive_path: CURSOR_STORE_DB_ENTRY.into(),
        source_path: store_snapshot,
    });
    capabilities.push(ArchiveCapability::StoreDb);
    Ok(PreparedExport {
        agent: ArchiveAgent::Cursor,
        id: location.id,
        source_cwd: location.source_cwd,
        source_agent_version: source_agent_version.trim().to_string(),
        source_schema_version: CURSOR_SESSION_SCHEMA.into(),
        label: snapshot_label,
        native_relative_path: None,
        capabilities,
        sources,
        limits: session_limits(4),
        warnings: base_warnings(),
        _workdir: workdir,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portable_archive::{extract_package, validate_package, PortableManifest};
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use std::fs;

    const ID: &str = "01234567-89ab-cdef-0123-456789abcdef";

    fn hash(path: &Path) -> String {
        format!(
            "{:x}",
            Sha256::digest(fs::read(path).expect("read fixture"))
        )
    }

    fn session_manifest(path: &Path, limits: ArchiveLimits) -> SessionManifest {
        match validate_package(path, Some(crate::portable_archive::SESSION_FORMAT), limits)
            .expect("valid exported package")
        {
            PortableManifest::Session(value) => value,
            _ => panic!("unexpected non-session package"),
        }
    }

    fn extract(path: &Path, limits: ArchiveLimits, parent: &Path) -> PathBuf {
        let target = parent.join("extracted");
        extract_package(
            path,
            &target,
            Some(crate::portable_archive::SESSION_FORMAT),
            limits,
        )
        .expect("extract package");
        target
    }

    #[test]
    fn fixed_jsonl_uses_open_time_length_and_discards_incomplete_tail() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("source.jsonl");
        fs::write(&source, b"{\"n\":1}\n{\"n\":2}\npartial").expect("write source");
        let target = temp.path().join("snapshot.jsonl");
        let mut visited = 0usize;
        let report = write_jsonl_snapshot(&source, &target, true, |_| {
            visited += 1;
            if visited == 1 {
                let mut source_file = fs::OpenOptions::new()
                    .append(true)
                    .open(&source)
                    .expect("reopen source");
                source_file
                    .write_all(b"-finished\n{\"n\":3}\n")
                    .expect("append while snapshotting");
            }
            Ok(true)
        })
        .expect("snapshot");
        assert_eq!(visited, 2);
        assert_eq!(report.complete_lines, 2);
        assert_eq!(report.included_lines, 2);
        assert!(report.discarded_tail);
        assert_eq!(
            fs::read(target).expect("read snapshot"),
            b"{\"n\":1}\n{\"n\":2}\n"
        );
    }

    #[test]
    fn strict_jsonl_rejects_invalid_complete_record() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("source.jsonl");
        fs::write(&source, b"{\"ok\":true}\nnot-json\n").expect("write source");
        let target = temp.path().join("snapshot.jsonl");
        let error = write_jsonl_snapshot(&source, &target, true, |_| Ok(true))
            .expect_err("invalid line must fail");
        assert!(error.contains("无效完整行"));
    }

    #[test]
    fn fixed_jsonl_rejects_source_truncation_during_snapshot() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("source.jsonl");
        let mut bytes = b"{\"n\":1}\n".to_vec();
        bytes.extend(std::iter::repeat_n(b'x', 128 * 1024));
        fs::write(&source, bytes).expect("write large source");
        let error = visit_fixed_jsonl(&source, |_| {
            fs::OpenOptions::new()
                .write(true)
                .open(&source)
                .expect("open for truncation")
                .set_len(8)
                .expect("truncate source");
            Ok(())
        })
        .expect_err("truncated fixed-length source must fail");
        assert!(error.contains("被截短"));
    }

    #[test]
    fn claude_snapshot_rejects_identity_race_and_wrong_project_history() {
        let identity_temp = tempfile::tempdir().expect("identity tempdir");
        let identity = claude_location(&identity_temp);
        let cwd = &identity.source_cwd;
        let valid = serde_json::json!({
            "type": "user", "sessionId": ID, "cwd": cwd, "version": "2.1.205"
        });
        let conflict = serde_json::json!({
            "type": "assistant",
            "sessionId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        });
        fs::write(&identity.transcript, format!("{valid}\n{conflict}\n"))
            .expect("replace transcript");
        let error = export_located_session(
            LocatedSession::Claude(identity),
            &identity_temp.path().join("identity.htybox-session"),
            None,
        )
        .expect_err("identity conflict must fail");
        assert!(error.contains("sessionId 冲突"));

        let project_temp = tempfile::tempdir().expect("project tempdir");
        let project = claude_location(&project_temp);
        let other = project_temp.path().join("other-workspace");
        fs::create_dir(&other).expect("other workspace");
        let wrong = serde_json::json!({"sessionId": ID, "project": other});
        fs::write(&project.history, format!("{wrong}\n")).expect("replace history");
        let error = export_located_session(
            LocatedSession::Claude(project),
            &project_temp.path().join("wrong-project.htybox-session"),
            None,
        )
        .expect_err("wrong history project must fail");
        assert!(error.contains("history 快照"));
    }

    fn claude_location(temp: &TempDir) -> ClaudeSessionLocation {
        let workspace = temp.path().join("workspace");
        let old_workspace = temp.path().join("old-workspace");
        let project = temp.path().join("project");
        let sidecar = project.join(ID);
        let subagents = sidecar.join("subagents");
        let tool_results = sidecar.join("tool-results");
        let tasks = temp.path().join("tasks").join(ID);
        for directory in [
            &workspace,
            &old_workspace,
            &project,
            &subagents,
            &tool_results,
            &tasks,
        ] {
            fs::create_dir_all(directory).expect("create fixture directory");
        }
        let transcript = project.join(format!("{ID}.jsonl"));
        let user_record = serde_json::json!({
            "type": "user",
            "sessionId": ID,
            "cwd": workspace,
            "version": "2.1.205"
        });
        let title_record = serde_json::json!({"type": "ai-title", "aiTitle": "Portable title"});
        fs::write(
            &transcript,
            format!("{user_record}\n{title_record}\nincomplete"),
        )
        .expect("write transcript");
        let history = temp.path().join("history.jsonl");
        let other = serde_json::json!({
            "sessionId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "display": "other",
            "project": workspace
        });
        let wanted = serde_json::json!({
            "sessionId": ID,
            "display": "wanted",
            "timestamp": 7,
            "project": workspace
        });
        let old_project = serde_json::json!({
            "sessionId": ID,
            "display": "old-project-must-not-export",
            "timestamp": 9,
            "project": old_workspace
        });
        fs::write(
            &history,
            format!("bad-global-line\n{other}\n{old_project}\n{wanted}\n"),
        )
        .expect("write history");
        fs::write(subagents.join("agent.jsonl"), b"agent-data").expect("write subagent");
        fs::write(subagents.join("active.lock"), b"runtime").expect("write lock");
        fs::write(tool_results.join("result.bin"), [0, 1, 2]).expect("write tool result");
        fs::write(tasks.join("task.json"), b"{\"done\":true}").expect("write task");
        fs::write(tasks.join("worker.pid"), b"99").expect("write pid");
        ClaudeSessionLocation {
            id: ID.into(),
            source_cwd: workspace.to_string_lossy().into_owned(),
            source_agent_version: "2.1.205".into(),
            project_dir: project,
            transcript,
            history,
            sidecar_dir: Some(sidecar),
            subagents_dir: Some(subagents),
            tool_results_dir: Some(tool_results),
            tasks_dir: Some(tasks),
        }
    }

    #[test]
    fn claude_export_is_closed_filtered_snapshot_and_preserves_source() {
        let temp = tempfile::tempdir().expect("tempdir");
        let location = claude_location(&temp);
        let transcript_hash = hash(&location.transcript);
        let history_hash = hash(&location.history);
        let destination = temp.path().join("claude-backup");
        let result =
            export_located_session(LocatedSession::Claude(location.clone()), &destination, None)
                .expect("export Claude");
        let archive = PathBuf::from(&result.path);
        assert_eq!(
            archive.extension().and_then(|value| value.to_str()),
            Some("htybox-session")
        );
        assert_eq!(result.label.as_deref(), Some("Portable title"));
        assert!(result.warnings.iter().any(|item| item.contains("不完整")));
        assert!(result
            .warnings
            .iter()
            .any(|item| item.contains("无效 JSONL")));
        assert_eq!(hash(&location.transcript), transcript_hash);
        assert_eq!(hash(&location.history), history_hash);

        let limits = session_limits(10_000);
        let manifest = session_manifest(&archive, limits);
        assert_eq!(manifest.agent, ArchiveAgent::Claude);
        assert!(manifest
            .capabilities
            .contains(&ArchiveCapability::Subagents));
        assert!(manifest
            .capabilities
            .contains(&ArchiveCapability::ToolResults));
        assert!(manifest.capabilities.contains(&ArchiveCapability::Tasks));
        let extracted = extract(&archive, limits, temp.path());
        let transcript =
            fs::read(extracted.join(CLAUDE_TRANSCRIPT_ENTRY)).expect("transcript snapshot");
        assert!(transcript.ends_with(b"\n"));
        assert_eq!(transcript.iter().filter(|byte| **byte == b'\n').count(), 2);
        assert!(!transcript.windows(10).any(|window| window == b"incomplete"));
        let history =
            fs::read_to_string(extracted.join(CLAUDE_HISTORY_ENTRY)).expect("history snapshot");
        assert!(history.contains(ID));
        assert!(!history.contains("other"));
        assert!(!history.contains("old-project-must-not-export"));
        assert!(extracted
            .join(CLAUDE_SUBAGENTS_ROOT)
            .join("agent.jsonl")
            .is_file());
        assert!(!extracted
            .join(CLAUDE_SUBAGENTS_ROOT)
            .join("active.lock")
            .exists());
        assert!(!extracted
            .join(CLAUDE_TASKS_ROOT)
            .join("worker.pid")
            .exists());
    }

    #[test]
    fn export_rejects_destination_inside_claude_source_tree() {
        let temp = tempfile::tempdir().expect("tempdir");
        let location = claude_location(&temp);
        let protected = location
            .tasks_dir
            .as_ref()
            .expect("tasks")
            .join("keep.htybox-session");
        fs::write(&protected, b"do-not-replace").expect("write protected target");
        let before = hash(&protected);
        let error = export_located_session(LocatedSession::Claude(location), &protected, None)
            .expect_err("source-overlap destination must fail");
        assert!(error.contains("源 payload 重叠"));
        assert_eq!(hash(&protected), before);
    }

    #[test]
    fn final_commit_rejects_replaced_destination_parent() {
        let temp = tempfile::tempdir().expect("tempdir");
        let staged = temp.path().join("staged.htybox-session");
        fs::write(&staged, b"complete-staged-package").unwrap();
        let parent = temp.path().join("destination");
        let moved = temp.path().join("destination-moved");
        fs::create_dir(&parent).unwrap();
        let destination = parent.join("backup.htybox-session");
        let error = commit_staged_package_with_hook(&staged, &destination, &[], || {
            fs::rename(&parent, &moved).map_err(|error| error.to_string())?;
            fs::create_dir(&parent).map_err(|error| error.to_string())?;
            Ok(())
        })
        .expect_err("replaced destination parent must not receive persist");
        assert!(!error.is_empty());
        assert!(!destination.exists());
    }

    #[test]
    fn claude_export_uses_last_valid_authoritative_version() {
        let temp = tempfile::tempdir().expect("tempdir");
        let location = claude_location(&temp);
        let cwd = location.source_cwd.clone();
        let lines = [
            serde_json::json!({"type":"user","sessionId":ID,"cwd":&cwd,"version":"1.0.0"}),
            serde_json::json!({"type":"assistant","sessionId":ID,"cwd":&cwd}),
            serde_json::json!({"type":"assistant","sessionId":ID,"cwd":&cwd,"version":"2.1.205"}),
        ];
        fs::write(
            &location.transcript,
            lines
                .iter()
                .map(|value| format!("{value}\n"))
                .collect::<String>(),
        )
        .expect("write mixed-version transcript");
        let result = export_located_session(
            LocatedSession::Claude(location),
            &temp.path().join("mixed-version"),
            None,
        )
        .expect("historical versions are allowed");
        let manifest = session_manifest(Path::new(&result.path), session_limits(10_000));
        assert_eq!(manifest.source_agent_version, "2.1.205");
    }

    #[cfg(windows)]
    #[test]
    fn claude_export_normalizes_case_and_trailing_workspace_aliases() {
        let temp = tempfile::tempdir().expect("tempdir");
        let location = claude_location(&temp);
        let anchor = location.source_cwd.clone();
        let alias = format!("{}\\", anchor.to_uppercase());
        let transcript = serde_json::json!({
            "type":"user","sessionId":ID,"cwd":alias,"version":"2.1.205"
        });
        fs::write(&location.transcript, format!("{transcript}\n"))
            .expect("write aliased transcript");
        let history = serde_json::json!({
            "sessionId":ID,"project":alias,"display":"alias","timestamp":1
        });
        fs::write(&location.history, format!("{history}\n")).expect("write aliased history");
        let result = export_located_session(
            LocatedSession::Claude(location),
            &temp.path().join("normalized"),
            None,
        )
        .expect("export aliased cwd");
        let limits = session_limits(10_000);
        let manifest = session_manifest(Path::new(&result.path), limits);
        assert_eq!(manifest.source_cwd, anchor);
        let extracted = extract(Path::new(&result.path), limits, temp.path());
        let transcript: Value = serde_json::from_str(
            fs::read_to_string(extracted.join(CLAUDE_TRANSCRIPT_ENTRY))
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        )
        .unwrap();
        let history: Value = serde_json::from_str(
            fs::read_to_string(extracted.join(CLAUDE_HISTORY_ENTRY))
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            transcript.get("cwd").and_then(Value::as_str),
            Some(anchor.as_str())
        );
        assert_eq!(
            history.get("project").and_then(Value::as_str),
            Some(anchor.as_str())
        );
    }

    #[test]
    fn codex_export_preserves_native_path_and_complete_prefix() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let relative = PathBuf::from(format!("2026/07/11/rollout-2026-07-11T01-02-03-{ID}.jsonl"));
        let rollout = temp.path().join("sessions").join(&relative);
        fs::create_dir_all(rollout.parent().expect("rollout parent")).expect("rollout dir");
        let meta = serde_json::json!({
            "type": "session_meta",
            "payload": {"id": ID, "cwd": workspace, "cli_version": "0.144.1"}
        });
        fs::write(
            &rollout,
            format!("{meta}\n{{\"type\":\"event\",\"payload\":1}}\npartial"),
        )
        .expect("rollout fixture");
        let before = hash(&rollout);
        let result = export_located_session(
            LocatedSession::Codex(CodexSessionLocation {
                id: ID.into(),
                source_cwd: workspace.to_string_lossy().into_owned(),
                source_agent_version: "0.144.1".into(),
                rollout: rollout.clone(),
                relative_rollout: relative,
                native_title: Some("Native Codex title".into()),
            }),
            &temp.path().join("codex.htybox-session"),
            None,
        )
        .expect("export Codex");
        assert_eq!(hash(&rollout), before);
        assert!(result.warnings.iter().any(|item| item.contains("不完整")));
        let archive = PathBuf::from(result.path);
        let limits = session_limits(2);
        let manifest = session_manifest(&archive, limits);
        assert_eq!(manifest.agent, ArchiveAgent::Codex);
        assert!(manifest
            .capabilities
            .contains(&ArchiveCapability::NativeTitle));
        assert_eq!(
            manifest.native_relative_path.as_deref(),
            Some(
                "2026/07/11/rollout-2026-07-11T01-02-03-01234567-89ab-cdef-0123-456789abcdef.jsonl"
            )
        );
        let extracted = extract(&archive, limits, temp.path());
        let snapshot = fs::read(extracted.join(CODEX_ROLLOUT_ENTRY)).expect("rollout snapshot");
        assert!(snapshot.ends_with(b"\n"));
        assert!(!snapshot.windows(7).any(|window| window == b"partial"));
    }

    #[test]
    fn cursor_export_online_backup_includes_committed_wal_and_is_standalone() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let chat_dir = temp.path().join("chat").join(ID);
        fs::create_dir(&workspace).expect("workspace");
        fs::create_dir_all(&chat_dir).expect("chat dir");
        let meta_path = chat_dir.join("meta.json");
        fs::write(
            &meta_path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "createdAtMs": 1,
                "updatedAtMs": 2,
                "hasConversation": true,
                "title": "Cursor title",
                "cwd": workspace
            }))
            .expect("serialize meta"),
        )
        .expect("write meta");
        let prompt_path = chat_dir.join("prompt_history.json");
        fs::write(&prompt_path, b"[\"hello\"]").expect("write prompt history");
        let store = chat_dir.join("store.db");
        let writer = Connection::open(&store).expect("open source db");
        let mode: String = writer
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .expect("enable WAL");
        assert_eq!(mode.to_ascii_lowercase(), "wal");
        writer
            .execute_batch(
                "PRAGMA wal_autocheckpoint=0;
                 CREATE TABLE messages(value TEXT NOT NULL);
                 INSERT INTO messages VALUES ('base');
                 INSERT INTO messages VALUES ('latest-committed-wal');",
            )
            .expect("populate WAL source");
        assert!(PathBuf::from(format!("{}-wal", store.to_string_lossy())).is_file());
        let source_hash = hash(&store);
        let result = export_located_session(
            LocatedSession::Cursor(CursorSessionLocation {
                id: ID.into(),
                source_cwd: workspace.to_string_lossy().into_owned(),
                schema_version: 1,
                chat_dir,
                meta: meta_path,
                prompt_history: Some(prompt_path),
                store_db: store.clone(),
                native_title: Some("Cursor title".into()),
            }),
            &temp.path().join("cursor.htybox-session"),
            Some("2026.07.09-a3815c0"),
        )
        .expect("export Cursor");
        assert_eq!(hash(&store), source_hash);
        let archive = PathBuf::from(result.path);
        let limits = session_limits(4);
        let manifest = session_manifest(&archive, limits);
        assert_eq!(manifest.agent, ArchiveAgent::Cursor);
        assert!(manifest.capabilities.contains(&ArchiveCapability::StoreDb));
        let extracted = extract(&archive, limits, temp.path());
        assert!(!extracted.join("payload/store.db-wal").exists());
        assert!(!extracted.join("payload/store.db-shm").exists());
        let snapshot_db = Connection::open(extracted.join(CURSOR_STORE_DB_ENTRY))
            .expect("open extracted snapshot");
        let values: String = snapshot_db
            .query_row(
                "SELECT group_concat(value, ',') FROM messages ORDER BY rowid",
                [],
                |row| row.get(0),
            )
            .expect("read snapshot rows");
        assert_eq!(values, "base,latest-committed-wal");
        let integrity: String = snapshot_db
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("integrity check");
        assert_eq!(integrity, "ok");
        drop(writer);
    }
}
