//! M9：列出/删除各 Agent 的工作区会话（"会话记录"按钮）。已按官方文档 + CLI --help 实证：
//! - claude：会话存 ~/.claude/projects/<slug>/<id>.jsonl；标题取自会话内最新 ai-title(claude 自动起的会话标题，与 /resume 选择器一致)，回退 history.jsonl 的 display；
//!   复原 `claude --resume <id>`(须在该 cwd 下跑)；无原生删除 → 删 <id>.jsonl 文件。
//! - codex：会话 ~/.codex/sessions/Y/M/D/rollout-*.jsonl，首行 session_meta.payload{id,cwd}；
//!   自动命名或 `/rename` 设置的原生名称取自 ~/.codex/session_index.jsonl，未命名时回退首条真实用户消息；
//!   复原 `codex resume <id>`；删除走删 rollout 文件。
//! - opencode：列表从原生 SQLite 只读查询并按 directory 过滤工作区；复原 `opencode --session <id>`；
//!   删除前通过官方 CLI 导出原生 JSON，校验后移入回收站，再调用 `opencode session delete <id>`。
//! - cursor：会话 ~/.cursor/chats/<hash>/<chatId>/meta.json（{schemaVersion,createdAtMs,updatedAtMs,hasConversation,title?,cwd}）；
//!   外层 hash 目录大概率是 cwd 哈希分桶，不逆向算法、直接扫全部子目录按 meta.json.cwd 过滤；
//!   标题优先取原生 title，未命名(hasConversation:false)的空壳会话跳过展示，其余回退 prompt_history.json 首条用户输入；
//!   复原 `cursor-agent --resume <chatId>`(flag 风格，与 claude 同构，已实测)；删除走删整个 chat 目录。
//! - kimi：会话 <KIMI_CODE_HOME|~/.kimi-code>/sessions/<workDirKey>/<sessionId>/state.json；
//!   **v1**（≤约 0.26）：`workDir` + RFC3339 时间串；**v2**（0.34+）：`cwd` 取代 workDir、`createdAt`/`updatedAt` 为 epoch 毫秒 number，可有 `archived`；
//!   workDirKey 为 cwd 派生分桶，不逆向算法、直接扫全部 state.json，路径双读 workDir|cwd、时间双读 RFC3339|ms，跳过 archived；title 缺失回退 lastPrompt；
//!   复原 `kimi --session <sessionId>`(flag 风格，id 形态 session_<uuid>，resume 精确性已实测)；删除走删整个 session 目录 + session_index.jsonl 剔行。
//! 删除统一移入回收站(trash，非交互、可恢复)。

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub id: String,
    pub label: String,
    pub ts: i64,      // 毫秒时间戳（排序/显示）
    pub path: String, // 会话文件路径（codex 删除用；claude 留空，按 id 查找）
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

const MAX_CODEX_SCAN: usize = 1200; // 最多扫描的 codex rollout 数（按文件名时间倒序）
const MAX_CURSOR_SCAN: usize = 2000; // 最多扫描的 cursor chat meta.json 数（安全上限，文件名不含时间故按遍历序截断）
const MAX_OPENCODE_SESSIONS: usize = 2000;

pub const CLAUDE_SESSION_SCHEMA: &str = "claude-transcript-jsonl-v1";
pub const CODEX_SESSION_SCHEMA: &str = "codex-rollout-jsonl-v1";
pub const CURSOR_SESSION_SCHEMA: &str = "cursor-chat-v1";

#[derive(Debug)]
struct OpenCodeSession {
    id: String,
    title: String,
    updated: i64,
    created: i64,
    directory: String,
}

fn validate_opencode_session_id(id: &str) -> Result<(), String> {
    let Some(token) = id.strip_prefix("ses_") else {
        return Err("OpenCode Session ID 必须以 ses_ 开头".into());
    };
    if token.is_empty()
        || token.len() > 124
        || !token.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err("OpenCode Session ID 含非法字符".into());
    }
    Ok(())
}

fn run_opencode(args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = crate::platform_services::platform_services().agent_command(
        "opencode",
        args,
        &crate::agent_env::fresh_path(),
    );
    command.output().map_err(|error| format!("运行 OpenCode CLI 失败：{error}"))
}

fn opencode_database_path() -> Result<PathBuf, String> {
    home()
        .map(|home| {
            home.join(".local")
                .join("share")
                .join("opencode")
                .join("opencode.db")
        })
        .ok_or_else(|| "无法定位 OpenCode 数据目录".into())
}

fn query_opencode_sessions_in(
    database: &Path,
    cwd: &str,
) -> Result<Vec<OpenCodeSession>, String> {
    let workspace = canonical_workspace(cwd)?;
    let metadata = crate::portable_archive::reject_link_or_reparse(database)?;
    if !metadata.is_file() {
        return Err("OpenCode 会话数据库不是普通文件".into());
    }
    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("只读打开 OpenCode 会话数据库失败：{error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_millis(250))
        .map_err(|error| format!("设置 OpenCode 数据库 busy timeout 失败：{error}"))?;
    connection
        .execute_batch("PRAGMA query_only=ON;")
        .map_err(|error| format!("设置 OpenCode 数据库只读模式失败：{error}"))?;

    let mut statement = connection
        .prepare(
            "SELECT id, title, time_updated, time_created, directory \
             FROM session ORDER BY time_updated DESC, time_created DESC",
        )
        .map_err(|error| format!("准备 OpenCode 会话查询失败：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(OpenCodeSession {
                id: row.get(0)?,
                title: row.get(1)?,
                updated: row.get(2)?,
                created: row.get(3)?,
                directory: row.get(4)?,
            })
        })
        .map_err(|error| format!("查询 OpenCode 会话失败：{error}"))?;

    let mut sessions = Vec::new();
    let mut directory_matches = HashMap::<String, bool>::new();
    for row in rows {
        let session = row.map_err(|error| format!("读取 OpenCode 会话失败：{error}"))?;
        let matches_workspace = *directory_matches
            .entry(session.directory.clone())
            .or_insert_with(|| {
                path_matches_workspace(&session.directory, &workspace).unwrap_or(false)
            });
        if validate_opencode_session_id(&session.id).is_err()
            || !matches_workspace
        {
            continue;
        }
        sessions.push(session);
        if sessions.len() >= MAX_OPENCODE_SESSIONS {
            break;
        }
    }
    Ok(sessions)
}

fn query_opencode_sessions(cwd: &str) -> Result<Vec<OpenCodeSession>, String> {
    query_opencode_sessions_in(&opencode_database_path()?, cwd)
}

pub fn list_opencode_sessions(cwd: &str) -> Vec<SessionRef> {
    let Ok(sessions) = query_opencode_sessions(cwd) else {
        return Vec::new();
    };
    let mut refs: Vec<_> = sessions
        .into_iter()
        .map(|session| SessionRef {
            id: session.id,
            label: if session.title.trim().is_empty() {
                "(无标题)".into()
            } else {
                session.title
            },
            ts: session.updated.max(session.created),
            path: String::new(),
        })
        .collect();
    refs.sort_by(|left, right| right.ts.cmp(&left.ts));
    refs
}

pub fn delete_opencode_session(id: &str, cwd: &str) -> Result<(), String> {
    validate_opencode_session_id(id)?;
    if !query_opencode_sessions(cwd)?.iter().any(|session| session.id == id) {
        return Err("OpenCode Session 不属于当前工作区或已不存在".into());
    }

    let mut backup = tempfile::Builder::new()
        .prefix(&format!("htybox-opencode-{id}-"))
        .suffix(".json")
        .tempfile()
        .map_err(|error| format!("创建 OpenCode 会话备份失败：{error}"))?;
    let writer = backup
        .reopen()
        .map_err(|error| format!("打开 OpenCode 会话备份失败：{error}"))?;
    let mut command = crate::platform_services::platform_services().agent_command(
        "opencode",
        &["export", id],
        &crate::agent_env::fresh_path(),
    );
    let output = command
        .stdout(Stdio::from(writer))
        .output()
        .map_err(|error| format!("导出 OpenCode 会话失败：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "导出 OpenCode 会话失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    backup
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("读取 OpenCode 会话备份失败：{error}"))?;
    #[derive(Deserialize)]
    struct ExportEnvelope {
        info: ExportInfo,
        messages: serde::de::IgnoredAny,
    }
    #[derive(Deserialize)]
    struct ExportInfo {
        id: String,
    }
    let exported: ExportEnvelope = serde_json::from_reader(&mut backup)
        .map_err(|error| format!("OpenCode 会话备份格式无效：{error}"))?;
    let _ = exported.messages;
    if exported.info.id != id {
        return Err("OpenCode 会话备份 ID 与待删除会话不一致".into());
    }
    let (backup_file, backup_path) = backup
        .keep()
        .map_err(|error| format!("保留 OpenCode 会话备份失败：{}", error.error))?;
    drop(backup_file);
    trash::delete(&backup_path).map_err(|error| {
        let _ = std::fs::remove_file(&backup_path);
        format!("OpenCode 会话备份移入回收站失败，未删除原会话：{error}")
    })?;

    let output = run_opencode(&["session", "delete", id])
        .map_err(|error| format!("OpenCode 原生备份已在回收站，但删除命令启动失败：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "OpenCode 原生备份已在回收站，但删除失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionAgent {
    Claude,
    Codex,
    Cursor,
}

impl TryFrom<&str> for SessionAgent {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "cursor" => Ok(Self::Cursor),
            _ => Err(format!("不支持的 Session Agent：{value}")),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum ExistingPathKind {
    File,
    Directory,
}

#[derive(Debug, Clone)]
pub struct ClaudeSessionLocation {
    pub id: String,
    pub source_cwd: String,
    pub source_agent_version: String,
    pub project_dir: PathBuf,
    pub transcript: PathBuf,
    pub history: PathBuf,
    pub sidecar_dir: Option<PathBuf>,
    pub subagents_dir: Option<PathBuf>,
    pub tool_results_dir: Option<PathBuf>,
    pub tasks_dir: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct CodexSessionLocation {
    pub id: String,
    pub source_cwd: String,
    pub source_agent_version: String,
    pub rollout: PathBuf,
    pub relative_rollout: PathBuf,
    pub native_title: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CursorSessionLocation {
    pub id: String,
    pub source_cwd: String,
    pub schema_version: u32,
    pub chat_dir: PathBuf,
    pub meta: PathBuf,
    pub prompt_history: Option<PathBuf>,
    pub store_db: PathBuf,
    pub native_title: Option<String>,
}

#[derive(Debug, Clone)]
pub enum LocatedSession {
    Claude(ClaudeSessionLocation),
    Codex(CodexSessionLocation),
    Cursor(CursorSessionLocation),
}

pub fn validate_session_id(id: &str) -> Result<(), String> {
    if id.len() != 36 {
        return Err("Session ID 必须是 36 字符小写 UUID".into());
    }
    for (index, byte) in id.bytes().enumerate() {
        let is_dash = matches!(index, 8 | 13 | 18 | 23);
        if (is_dash && byte != b'-')
            || (!is_dash && !(byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        {
            return Err("Session ID 必须是规范小写 UUID".into());
        }
    }
    Ok(())
}

fn reject_dot_components(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("路径必须是绝对路径：{}", path.display()));
    }
    if path.components().any(|component| {
        matches!(
            component,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    }) {
        return Err(format!("路径不能含 . 或 ..：{}", path.display()));
    }
    Ok(())
}

pub fn canonical_existing_under(
    root: &Path,
    candidate: &Path,
    expected_kind: ExistingPathKind,
) -> Result<PathBuf, String> {
    reject_dot_components(root)?;
    reject_dot_components(candidate)?;
    let root_metadata = crate::portable_archive::reject_link_or_reparse(root)?;
    if !root_metadata.is_dir() {
        return Err(format!("权威根目录不存在：{}", root.display()));
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("解析权威根目录失败：{e}"))?;
    let metadata = crate::portable_archive::reject_link_or_reparse(candidate)?;
    let candidate = candidate
        .canonicalize()
        .map_err(|e| format!("解析候选路径失败：{e}"))?;
    if candidate.strip_prefix(&root).is_err() || candidate == root {
        return Err(format!("路径不在权威根目录内：{}", candidate.display()));
    }
    let kind_matches = match expected_kind {
        ExistingPathKind::File => metadata.is_file(),
        ExistingPathKind::Directory => metadata.is_dir(),
    };
    if !kind_matches {
        return Err(format!("候选路径类型不正确：{}", candidate.display()));
    }
    Ok(candidate)
}

pub fn canonical_same_existing_path(left: &Path, right: &Path) -> Result<bool, String> {
    reject_dot_components(left)?;
    reject_dot_components(right)?;
    crate::portable_archive::reject_link_or_reparse(left)?;
    crate::portable_archive::reject_link_or_reparse(right)?;
    let left = left
        .canonicalize()
        .map_err(|e| format!("解析路径失败 {}：{e}", left.display()))?;
    let right = right
        .canonicalize()
        .map_err(|e| format!("解析路径失败 {}：{e}", right.display()))?;
    Ok(left == right)
}

pub fn validate_source_hint(hint: Option<&str>, authoritative: &Path) -> Result<(), String> {
    let Some(hint) = hint.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    if !canonical_same_existing_path(Path::new(hint), authoritative)? {
        return Err("前端 sourcePath 与权威 Session 来源不一致".into());
    }
    Ok(())
}

pub fn cursor_bucket(cwd: &str) -> String {
    format!("{:x}", md5::compute(cwd.as_bytes()))
}

fn canonical_workspace(cwd: &str) -> Result<PathBuf, String> {
    let path = Path::new(cwd);
    reject_dot_components(path)?;
    let metadata = crate::portable_archive::reject_link_or_reparse(path)?;
    if !metadata.is_dir() {
        return Err("Session cwd 不是现存目录".into());
    }
    path.canonicalize()
        .map_err(|e| format!("解析 Session cwd 失败：{e}"))
}

fn path_matches_workspace(value: &str, workspace: &Path) -> Result<bool, String> {
    let path = Path::new(value);
    reject_dot_components(path)?;
    let metadata = crate::portable_archive::reject_link_or_reparse(path)?;
    if !metadata.is_dir() {
        return Ok(false);
    }
    Ok(path.canonicalize().map_err(|e| e.to_string())? == workspace)
}

fn inspect_claude_transcript(
    path: &Path,
    id: &str,
    workspace: &Path,
) -> Result<(String, String), String> {
    const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let mut authoritative: Option<(String, String)> = None;
    loop {
        buffer.clear();
        let read = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        if buffer.len() > MAX_LINE_BYTES {
            return Err("Claude transcript 单行超过 16 MiB".into());
        }
        let complete = buffer.ends_with(b"\n");
        let line = buffer.strip_suffix(b"\n").unwrap_or(&buffer);
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let value = match serde_json::from_slice::<serde_json::Value>(line) {
            Ok(value) => value,
            Err(_) if !complete => break,
            Err(error) => return Err(format!("Claude transcript 含损坏 JSONL：{error}")),
        };
        if let Some(found_id) = value.get("sessionId").and_then(|value| value.as_str()) {
            if found_id != id {
                return Err("Claude transcript 内 sessionId 冲突".into());
            }
        }
        let record_type = value.get("type").and_then(|value| value.as_str());
        if matches!(
            record_type,
            Some("user" | "assistant" | "system" | "attachment")
        ) {
            let Some(record_id) = value.get("sessionId").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(record_cwd) = value.get("cwd").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(version) = value
                .get("version")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
            else {
                continue;
            };
            if record_id == id && path_matches_workspace(record_cwd, workspace).unwrap_or(false) {
                authoritative = Some((record_cwd.to_string(), version.to_string()));
            }
        }
    }
    authoritative.ok_or_else(|| "Claude transcript 缺少 id/cwd/version 权威正文记录".into())
}

fn claude_history_contains(history: &Path, id: &str, workspace: &Path) -> Result<bool, String> {
    let file = std::fs::File::open(history).map_err(|e| e.to_string())?;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("sessionId").and_then(|value| value.as_str()) != Some(id) {
            continue;
        }
        if let Some(project) = value.get("project").and_then(|value| value.as_str()) {
            if path_matches_workspace(project, workspace).unwrap_or(false) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn optional_directory(root: &Path, candidate: PathBuf) -> Result<Option<PathBuf>, String> {
    match std::fs::symlink_metadata(&candidate) {
        Ok(_) => canonical_existing_under(root, &candidate, ExistingPathKind::Directory).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取可选目录失败 {}：{error}", candidate.display())),
    }
}

pub(crate) fn locate_claude_session_in(
    home: &Path,
    id: &str,
    cwd: &str,
) -> Result<ClaudeSessionLocation, String> {
    validate_session_id(id)?;
    let workspace = canonical_workspace(cwd)?;
    let claude_root = home.join(".claude");
    let projects_root = claude_root.join("projects");
    let mut expected_slugs = vec![crate::catalog::claude_project_slug(cwd)?];
    let canonical_slug = crate::catalog::claude_project_slug(
        workspace
            .to_str()
            .ok_or_else(|| "规范工作区路径不是 UTF-8".to_string())?,
    )?;
    if !expected_slugs
        .iter()
        .any(|slug| slug.eq_ignore_ascii_case(&canonical_slug))
    {
        expected_slugs.push(canonical_slug);
    }
    let root_metadata = crate::portable_archive::reject_link_or_reparse(&projects_root)?;
    if !root_metadata.is_dir() {
        return Err("Claude projects 根目录不存在".into());
    }

    let mut candidates = Vec::new();
    let file_name = format!("{id}.jsonl");
    for entry in std::fs::read_dir(&projects_root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let project = entry.path();
        let Ok(metadata) = crate::portable_archive::reject_link_or_reparse(&project) else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }
        let candidate = project.join(&file_name);
        if std::fs::symlink_metadata(&candidate).is_ok() {
            candidates.push(canonical_existing_under(
                &projects_root,
                &candidate,
                ExistingPathKind::File,
            )?);
        }
    }
    if candidates.len() != 1 {
        return Err(format!(
            "Claude Session 来源必须全局唯一，实际找到 {} 个",
            candidates.len()
        ));
    }
    let transcript = candidates.remove(0);
    let project_dir = transcript
        .parent()
        .ok_or_else(|| "Claude transcript 缺少 project 父目录".to_string())?
        .to_path_buf();
    let actual_slug = project_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !expected_slugs
        .iter()
        .any(|slug| actual_slug.eq_ignore_ascii_case(slug))
    {
        return Err("Claude transcript 不在当前工作区对应 project bucket".into());
    }
    let (source_cwd, source_agent_version) =
        inspect_claude_transcript(&transcript, id, &workspace)?;
    let history = canonical_existing_under(
        &claude_root,
        &claude_root.join("history.jsonl"),
        ExistingPathKind::File,
    )?;
    if !claude_history_contains(&history, id, &workspace)? {
        return Err("Claude history 缺少当前 Session 的工作区记录".into());
    }
    let sidecar_dir = optional_directory(&project_dir, project_dir.join(id))?;
    let subagents_dir = sidecar_dir
        .as_ref()
        .map(|root| optional_directory(root, root.join("subagents")))
        .transpose()?
        .flatten();
    let tool_results_dir = sidecar_dir
        .as_ref()
        .map(|root| optional_directory(root, root.join("tool-results")))
        .transpose()?
        .flatten();
    let tasks_root = claude_root.join("tasks");
    let tasks_dir = if tasks_root.is_dir() {
        optional_directory(&tasks_root, tasks_root.join(id))?
    } else {
        None
    };
    Ok(ClaudeSessionLocation {
        id: id.to_string(),
        source_cwd,
        source_agent_version,
        project_dir,
        transcript,
        history,
        sidecar_dir,
        subagents_dir,
        tool_results_dir,
        tasks_dir,
    })
}

pub fn locate_claude_session(id: &str, cwd: &str) -> Result<ClaudeSessionLocation, String> {
    let home = home().ok_or_else(|| "无 home 目录".to_string())?;
    locate_claude_session_in(&home, id, cwd)
}

pub fn locate_session(agent: SessionAgent, id: &str, cwd: &str) -> Result<LocatedSession, String> {
    match agent {
        SessionAgent::Claude => locate_claude_session(id, cwd).map(LocatedSession::Claude),
        SessionAgent::Codex => locate_codex_session(id, cwd).map(LocatedSession::Codex),
        SessionAgent::Cursor => locate_cursor_session(id, cwd).map(LocatedSession::Cursor),
    }
}

/// claude：从 ~/.claude/history.jsonl 取本工作区(project==cwd)会话列表与时间；标题(label)取该会话 jsonl
/// 内最新一条 ai-title(claude 自动生成的会话标题，= /resume 选择器所示)，无则回退首条非斜杠提示。
pub fn list_claude_sessions(cwd: &str) -> Vec<SessionRef> {
    let Some(home_dir) = home() else {
        return Vec::new();
    };
    list_claude_sessions_in(&home_dir, cwd)
}

pub(crate) fn list_claude_sessions_in(home_dir: &Path, cwd: &str) -> Vec<SessionRef> {
    let h = home_dir;
    let Ok(f) = std::fs::File::open(h.join(".claude").join("history.jsonl")) else {
        return Vec::new();
    };
    // sessionId -> (label, ts, label_still_slash)
    let mut map: HashMap<String, (String, i64, bool)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(project) = v.get("project").and_then(|p| p.as_str()) else {
            continue;
        };
        if !same_path(project, cwd) {
            continue;
        }
        let Some(id) = v.get("sessionId").and_then(|s| s.as_str()) else {
            continue;
        };
        let display = v
            .get("display")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let ts = v.get("timestamp").and_then(|t| t.as_i64()).unwrap_or(0);
        let is_slash = display.is_empty() || display.starts_with('/');
        match map.entry(id.to_string()) {
            std::collections::hash_map::Entry::Vacant(slot) => {
                order.push(id.to_string());
                slot.insert((display, ts, is_slash));
            }
            std::collections::hash_map::Entry::Occupied(mut slot) => {
                let cur = slot.get_mut();
                if ts > cur.1 {
                    cur.1 = ts;
                }
                if cur.2 && !is_slash {
                    cur.0 = display;
                    cur.2 = false;
                }
            }
        }
    }
    // sessionId -> <id>.jsonl 路径映射，标题优先取会话内最新 ai-title，无则回退 history 的 display。
    let files = session_files(&h);
    let mut out: Vec<SessionRef> = order
        .into_iter()
        .filter_map(|id| {
            let transcript = files.get(&id)?;
            map.get(&id).map(|(display, ts, _)| {
                let label = read_ai_title(transcript)
                    .or_else(|| (!display.is_empty()).then(|| display.clone()))
                    .unwrap_or_else(|| "(无标题)".into());
                SessionRef {
                    label,
                    id: id.clone(),
                    ts: *ts,
                    path: transcript.to_string_lossy().into_owned(),
                }
            })
        })
        .collect();
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out
}

/// 建 sessionId -> <id>.jsonl 路径映射（遍历 ~/.claude/projects/*/*.jsonl）。
fn session_files(home: &Path) -> HashMap<String, PathBuf> {
    let mut m = HashMap::new();
    let mut duplicates = HashSet::new();
    let Ok(dirs) = std::fs::read_dir(home.join(".claude").join("projects")) else {
        return m;
    };
    for d in dirs.flatten() {
        let Ok(files) = std::fs::read_dir(d.path()) else {
            continue;
        };
        for fe in files.flatten() {
            let fp = fe.path();
            if fp.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if let Some(stem) = fp.file_stem().and_then(|s| s.to_str()) {
                    let stem = stem.to_string();
                    if duplicates.contains(&stem) {
                        continue;
                    }
                    if m.insert(stem.clone(), fp).is_some() {
                        m.remove(&stem);
                        duplicates.insert(stem);
                    }
                }
            }
        }
    }
    m
}

/// 取会话 jsonl 内【最新一条】ai-title(claude 自动生成的会话标题)。
/// ai-title 每次更新追加写入，最新条在文件末尾附近 → 只反向读末尾约 64KB，避免扫描超大转录文件。
fn read_ai_title(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len == 0 {
        return None;
    }
    let n = len.min(64 * 1024);
    f.seek(SeekFrom::End(-(n as i64))).ok()?;
    let mut buf = vec![0u8; n as usize];
    f.read_exact(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    // 反向找最后一条 ai-title（首行可能因截断不完整，但末尾的 ai-title 行完整）
    for line in text.lines().rev() {
        if !line.contains("\"ai-title\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("ai-title") {
            continue;
        }
        if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
            let t = t.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// 删除 claude 会话：① 在 ~/.claude/projects/*/ 下找 <id>.jsonl 移入回收站；
/// ② 从 ~/.claude/history.jsonl 移除该 sessionId 的行（否则列表源自 history，删后仍会显示）。
pub fn delete_claude_session(id: &str) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("非法会话 id：{id}"));
    }
    let Some(h) = home() else {
        return Err("无 home 目录".into());
    };
    let claude = h.join(".claude");
    let mut did = false;
    // ① transcript 文件 → 回收站（best-effort）
    if let Ok(dirs) = std::fs::read_dir(claude.join("projects")) {
        let fname = format!("{id}.jsonl");
        for d in dirs.flatten() {
            let p = d.path().join(&fname);
            if p.is_file() {
                let _ = trash::delete(&p);
                did = true;
                break;
            }
        }
    }
    // ② history.jsonl 移除该 sessionId 的行（这才让它从列表消失）
    let hist = claude.join("history.jsonl");
    if let Ok(content) = std::fs::read_to_string(&hist) {
        let needle = format!("\"sessionId\":\"{id}\"");
        let kept: Vec<&str> = content.lines().filter(|l| !l.contains(&needle)).collect();
        if kept.len() != content.lines().count() {
            let mut out = kept.join("\n");
            if content.ends_with('\n') {
                out.push('\n');
            }
            std::fs::write(&hist, out).map_err(|e| e.to_string())?;
            did = true;
        }
    }
    if did {
        Ok(())
    } else {
        Err("未找到该会话".into())
    }
}

// ---------------- codex ----------------

fn mtime_ms(p: &Path) -> i64 {
    std::fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_head_lines(path: &Path, max: usize) -> Vec<String> {
    let Ok(f) = std::fs::File::open(path) else {
        return Vec::new();
    };
    BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .take(max)
        .collect()
}

/// Codex 的原生会话名索引（自动命名 / `/rename`）是 append-only JSONL：
/// `{ "id": "...", "thread_name": "...", "updated_at": "..." }`。
/// 同一 id 可出现多次，后写入的有效记录覆盖旧值；空名称与坏行按 Codex batch reader 语义忽略。
fn parse_codex_session_titles(reader: impl BufRead) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    for line in reader.lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(id) = v
            .get("id")
            .and_then(|x| x.as_str())
            .filter(|x| !x.is_empty())
        else {
            continue;
        };
        let Some(title) = v.get("thread_name").and_then(|x| x.as_str()) else {
            continue;
        };
        let title = title.trim();
        if title.is_empty() {
            continue;
        }
        titles.insert(id.to_string(), title.to_string());
    }
    titles
}

fn read_codex_session_titles(home: &Path) -> HashMap<String, String> {
    let path = home.join(".codex").join("session_index.jsonl");
    let Ok(file) = std::fs::File::open(path) else {
        return HashMap::new();
    };
    parse_codex_session_titles(BufReader::new(file))
}

fn codex_label(native_title: Option<&String>, fallback: String) -> String {
    native_title.cloned().unwrap_or_else(|| {
        if fallback.is_empty() {
            "(无标题)".into()
        } else {
            fallback
        }
    })
}

pub(crate) fn validate_codex_relative_path(relative: &Path, id: &str) -> Result<(), String> {
    let parts: Vec<_> = relative
        .components()
        .map(|component| match component {
            std::path::Component::Normal(value) => value
                .to_str()
                .ok_or_else(|| "Codex rollout 路径不是 UTF-8".to_string()),
            _ => Err("Codex rollout 含非法相对路径组件".into()),
        })
        .collect::<Result<_, _>>()?;
    if parts.len() != 4
        || parts[0].len() != 4
        || parts[1].len() != 2
        || parts[2].len() != 2
        || !parts[..3]
            .iter()
            .all(|part| part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err("Codex rollout 日期层级必须为 YYYY/MM/DD".into());
    }
    let year: u32 = parts[0].parse().map_err(|_| "Codex rollout 年份无效")?;
    let month: u32 = parts[1].parse().map_err(|_| "Codex rollout 月份无效")?;
    let day: u32 = parts[2].parse().map_err(|_| "Codex rollout 日期无效")?;
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return Err("Codex rollout 月份必须在 01..12".into()),
    };
    if year == 0 || day == 0 || day > max_day {
        return Err("Codex rollout 日期不是有效公历日期".into());
    }
    let expected_prefix = format!("rollout-{}-{}-{}T", parts[0], parts[1], parts[2]);
    let expected_suffix = format!("-{id}.jsonl");
    let Some(clock) = parts[3]
        .strip_prefix(&expected_prefix)
        .and_then(|value| value.strip_suffix(&expected_suffix))
    else {
        return Err("Codex rollout 文件名与日期/Session ID 不一致".into());
    };
    let clock_parts: Vec<_> = clock.split('-').collect();
    if clock_parts.len() != 3
        || clock_parts
            .iter()
            .any(|part| part.len() != 2 || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err("Codex rollout 时间必须为 HH-MM-SS".into());
    }
    let hour: u32 = clock_parts[0]
        .parse()
        .map_err(|_| "Codex rollout 小时无效")?;
    let minute: u32 = clock_parts[1]
        .parse()
        .map_err(|_| "Codex rollout 分钟无效")?;
    let second: u32 = clock_parts[2].parse().map_err(|_| "Codex rollout 秒无效")?;
    if hour >= 24 || minute >= 60 || second >= 60 {
        return Err("Codex rollout 时间超出有效范围".into());
    }
    Ok(())
}

fn inspect_codex_meta(
    rollout: &Path,
    id: &str,
    workspace: &Path,
) -> Result<(String, String), String> {
    let file = std::fs::File::open(rollout).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    reader
        .read_until(b'\n', &mut line)
        .map_err(|e| e.to_string())?;
    if line.is_empty() || line.len() > 1024 * 1024 || !line.ends_with(b"\n") {
        return Err("Codex rollout 首行缺失、不完整或超过 1 MiB".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&line).map_err(|e| format!("Codex session_meta JSON 无效：{e}"))?;
    if value.get("type").and_then(|value| value.as_str()) != Some("session_meta") {
        return Err("Codex rollout 首行不是 session_meta".into());
    }
    let payload = value
        .get("payload")
        .and_then(|value| value.as_object())
        .ok_or_else(|| "Codex session_meta 缺少 payload".to_string())?;
    if payload.get("id").and_then(|value| value.as_str()) != Some(id) {
        return Err("Codex session_meta payload.id 不匹配".into());
    }
    let source_cwd = payload
        .get("cwd")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex session_meta 缺少 cwd".to_string())?;
    if !path_matches_workspace(source_cwd, workspace)? {
        return Err("Codex session_meta cwd 与目标工作区不一致".into());
    }
    let version = payload
        .get("cli_version")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Codex session_meta 缺少 cli_version".to_string())?;
    Ok((source_cwd.to_string(), version.to_string()))
}

pub(crate) fn locate_codex_session_in(
    home: &Path,
    id: &str,
    cwd: &str,
) -> Result<CodexSessionLocation, String> {
    validate_session_id(id)?;
    let workspace = canonical_workspace(cwd)?;
    let root = home.join(".codex").join("sessions");
    let root_metadata = crate::portable_archive::reject_link_or_reparse(&root)?;
    if !root_metadata.is_dir() {
        return Err("Codex sessions 根目录不存在".into());
    }
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let suffix = format!("-{id}.jsonl");
    let zst_suffix = format!("-{id}.jsonl.zst");
    let mut saw_zst = false;
    let mut matches = Vec::new();
    for item in WalkDir::new(&root).max_depth(5).follow_links(false) {
        let item = item.map_err(|e| format!("扫描 Codex sessions 失败：{e}"))?;
        if !item.file_type().is_file() {
            continue;
        }
        let Some(name) = item.file_name().to_str() else {
            continue;
        };
        if name.ends_with(&zst_suffix) {
            saw_zst = true;
            continue;
        }
        if !name.ends_with(&suffix) || !name.starts_with("rollout-") {
            continue;
        }
        let rollout = canonical_existing_under(&root, item.path(), ExistingPathKind::File)?;
        let relative = rollout
            .strip_prefix(&canonical_root)
            .map_err(|_| "Codex rollout 逃逸 sessions 根".to_string())?
            .to_path_buf();
        validate_codex_relative_path(&relative, id)?;
        let (source_cwd, source_agent_version) = inspect_codex_meta(&rollout, id, &workspace)?;
        matches.push((rollout, relative, source_cwd, source_agent_version));
    }
    if matches.is_empty() && saw_zst {
        return Err("该 Codex Session 仅有 .jsonl.zst，V1 暂不支持导出".into());
    }
    if matches.len() != 1 || saw_zst {
        return Err(format!(
            "Codex Session 来源不唯一或含冲突压缩格式：jsonl={} zst={}",
            matches.len(),
            saw_zst
        ));
    }
    let (rollout, relative_rollout, source_cwd, source_agent_version) = matches.remove(0);
    let native_title = read_codex_session_titles(home).remove(id);
    Ok(CodexSessionLocation {
        id: id.to_string(),
        source_cwd,
        source_agent_version,
        rollout,
        relative_rollout,
        native_title,
    })
}

pub fn locate_codex_session(id: &str, cwd: &str) -> Result<CodexSessionLocation, String> {
    let home = home().ok_or_else(|| "无 home 目录".to_string())?;
    locate_codex_session_in(&home, id, cwd)
}

/// codex 会话开头由 CLI 注入的系统消息（非用户真实输入）：以 < 开头的 XML 标签块 / # AGENTS.md 指令。
fn is_codex_injection(t: &str) -> bool {
    t.starts_with('<') || t.starts_with("# AGENTS.md")
}

/// codex：扫 ~/.codex/sessions 的 rollout，session_meta.payload.cwd==cwd 的列出；
/// 标题优先取 session_index.jsonl 的原生 thread_name，未命名时回退首条非环境用户消息。
pub fn list_codex_sessions(cwd: &str) -> Vec<SessionRef> {
    let Some(home_dir) = home() else {
        return Vec::new();
    };
    list_codex_sessions_in(&home_dir, cwd)
}

pub(crate) fn list_codex_sessions_in(home_dir: &Path, cwd: &str) -> Vec<SessionRef> {
    let h = home_dir;
    let root = h.join(".codex").join("sessions");
    if !root.is_dir() {
        return Vec::new();
    }
    let native_titles = read_codex_session_titles(&h);
    let mut files: Vec<PathBuf> = WalkDir::new(&root)
        .max_depth(5)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
                .unwrap_or(false)
        })
        .collect();
    files.sort_by(|a, b| b.file_name().cmp(&a.file_name())); // 文件名含 ISO 时间 → 倒序=最近优先
    files.truncate(MAX_CODEX_SCAN);

    let mut out = Vec::new();
    for p in files {
        let head = read_head_lines(&p, 30);
        if head.is_empty() {
            continue;
        }
        let Ok(meta) = serde_json::from_str::<serde_json::Value>(&head[0]) else {
            continue;
        };
        if meta.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
            continue;
        }
        let payload = meta.get("payload");
        if payload
            .and_then(|p| p.get("cwd"))
            .and_then(|c| c.as_str())
            .map(|c| same_path(c, cwd))
            != Some(true)
        {
            continue;
        }
        let id = payload
            .and_then(|p| p.get("id"))
            .and_then(|i| i.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        // 标题=首条"真实用户消息"：response_item + role=user，跳过 codex 的系统注入(< 标签块 / # AGENTS.md)
        let mut label = String::new();
        'outer: for l in head.iter().skip(1) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else {
                continue;
            };
            if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
                continue;
            }
            let payload = v.get("payload");
            if payload.and_then(|p| p.get("role")).and_then(|r| r.as_str()) != Some("user") {
                continue;
            }
            let Some(content) = payload
                .and_then(|p| p.get("content"))
                .and_then(|c| c.as_array())
            else {
                continue;
            };
            for item in content {
                if item.get("type").and_then(|t| t.as_str()) != Some("input_text") {
                    continue;
                }
                let Some(t) = item.get("text").and_then(|x| x.as_str()) else {
                    continue;
                };
                let t = t.trim();
                if t.is_empty() || is_codex_injection(t) {
                    continue;
                }
                label = t.chars().take(80).collect();
                break 'outer;
            }
        }
        out.push(SessionRef {
            label: codex_label(native_titles.get(&id), label),
            id,
            ts: mtime_ms(&p),
            path: p.to_string_lossy().into_owned(),
        });
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out
}

/// 删除 codex 会话：移入回收站（仅限 ~/.codex/sessions 内）。
pub fn delete_codex_session(path: &str) -> Result<(), String> {
    let Some(h) = home() else {
        return Err("无 home 目录".into());
    };
    let root = h.join(".codex").join("sessions");
    let path = canonical_existing_under(&root, Path::new(path), ExistingPathKind::File)?;
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let relative = path
        .strip_prefix(&canonical_root)
        .map_err(|_| "Codex 删除路径逃逸 sessions 根".to_string())?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Codex rollout 文件名不是 UTF-8".to_string())?;
    let stem = name
        .strip_suffix(".jsonl")
        .ok_or_else(|| "Codex 删除目标不是 .jsonl rollout".to_string())?;
    if stem.len() < 37 {
        return Err("Codex rollout 文件名缺少 Session ID".into());
    }
    let id_start = stem.len() - 36;
    if stem.as_bytes().get(id_start.wrapping_sub(1)) != Some(&b'-') {
        return Err("Codex rollout 文件名缺少 Session ID 分隔符".into());
    }
    let id = &stem[id_start..];
    validate_session_id(id)?;
    validate_codex_relative_path(relative, id)?;
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let first = BufReader::new(file)
        .lines()
        .next()
        .transpose()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Codex rollout 是空文件".to_string())?;
    let meta: serde_json::Value = serde_json::from_str(&first).map_err(|e| e.to_string())?;
    if meta.get("type").and_then(|value| value.as_str()) != Some("session_meta")
        || meta
            .get("payload")
            .and_then(|value| value.get("id"))
            .and_then(|value| value.as_str())
            != Some(id)
    {
        return Err("Codex rollout 的 session_meta ID 与文件名不一致".into());
    }
    trash::delete(path).map_err(|e| e.to_string())
}

// ---------------- cursor ----------------

/// 原生标题优先，其次回退候选（如首条用户 prompt），都没有则"(无标题)"；规则同 codex_label。
fn cursor_label(native_title: Option<&str>, fallback: Option<String>) -> String {
    native_title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .or(fallback)
        .unwrap_or_else(|| "(无标题)".into())
}

/// 从 prompt_history.json（用户实际输入的原始 prompt 字符串数组）取首条非空项，截断 80 字符做兜底标题。
fn first_prompt_from_history(v: &serde_json::Value) -> Option<String> {
    v.as_array()?
        .iter()
        .filter_map(|x| x.as_str())
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(|s| s.chars().take(80).collect())
}

fn read_cursor_first_prompt(chat_dir: &Path) -> Option<String> {
    let txt = std::fs::read_to_string(chat_dir.join("prompt_history.json")).ok()?;
    let v = serde_json::from_str::<serde_json::Value>(&txt).ok()?;
    first_prompt_from_history(&v)
}

fn read_small_json(path: &Path, label: &str) -> Result<serde_json::Value, String> {
    let metadata = crate::portable_archive::reject_link_or_reparse(path)?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return Err(format!("{label} 不是普通小文件"));
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{label} JSON 无效：{e}"))
}

fn inspect_cursor_meta(
    meta: &Path,
    id: &str,
    workspace: &Path,
) -> Result<(serde_json::Value, String, u32), String> {
    let value = read_small_json(meta, "Cursor meta.json")?;
    let object = value
        .as_object()
        .ok_or_else(|| "Cursor meta.json 根必须是 object".to_string())?;
    let schema = object
        .get("schemaVersion")
        .and_then(|value| value.as_u64())
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "Cursor meta.json 缺少 schemaVersion".to_string())?;
    if schema != 1 {
        return Err(format!("不支持的 Cursor chat schemaVersion：{schema}"));
    }
    if let Some(meta_id) = object.get("id") {
        if meta_id.as_str() != Some(id) {
            return Err("Cursor meta.json id 与 chat 目录不一致".into());
        }
    }
    for field in ["createdAtMs", "updatedAtMs"] {
        if object
            .get(field)
            .and_then(|value| value.as_i64())
            .is_none_or(|value| value < 0)
        {
            return Err(format!("Cursor meta.json {field} 必须是非负整数"));
        }
    }
    if object
        .get("hasConversation")
        .and_then(|value| value.as_bool())
        != Some(true)
    {
        return Err("Cursor chat 尚无可导出的 conversation".into());
    }
    if object
        .get("title")
        .is_some_and(|value| !value.is_null() && !value.is_string())
    {
        return Err("Cursor meta.json title 类型无效".into());
    }
    let source_cwd = object
        .get("cwd")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Cursor meta.json 缺少 cwd".to_string())?
        .to_string();
    if !path_matches_workspace(&source_cwd, workspace)? {
        return Err("Cursor meta.json cwd 与目标工作区不一致".into());
    }
    Ok((value, source_cwd, schema))
}

fn validate_prompt_history(path: &Path) -> Result<(), String> {
    let value = read_small_json(path, "Cursor prompt_history.json")?;
    let Some(items) = value.as_array() else {
        return Err("Cursor prompt_history.json 必须是字符串数组".into());
    };
    if items.iter().any(|item| !item.is_string()) {
        return Err("Cursor prompt_history.json 必须是字符串数组".into());
    }
    Ok(())
}

pub(crate) fn locate_cursor_session_in(
    home: &Path,
    id: &str,
    cwd: &str,
) -> Result<CursorSessionLocation, String> {
    validate_session_id(id)?;
    let workspace = canonical_workspace(cwd)?;
    let root = home.join(".cursor").join("chats");
    let root_metadata = crate::portable_archive::reject_link_or_reparse(&root)?;
    if !root_metadata.is_dir() {
        return Err("Cursor chats 根目录不存在".into());
    }
    let mut matches = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let bucket = entry.path();
        let Ok(metadata) = crate::portable_archive::reject_link_or_reparse(&bucket) else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }
        let candidate = bucket.join(id);
        if std::fs::symlink_metadata(&candidate).is_ok() {
            matches.push(canonical_existing_under(
                &root,
                &candidate,
                ExistingPathKind::Directory,
            )?);
        }
    }
    if matches.len() != 1 {
        return Err(format!(
            "Cursor Session 来源必须全局唯一，实际找到 {} 个",
            matches.len()
        ));
    }
    let chat_dir = matches.remove(0);
    let bucket_name = chat_dir
        .parent()
        .and_then(|path| path.file_name())
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Cursor chat 缺少 bucket".to_string())?;
    if bucket_name.len() != 32
        || !bucket_name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Cursor chat bucket 不是 32 位小写 MD5".into());
    }
    let meta = canonical_existing_under(
        &chat_dir,
        &chat_dir.join("meta.json"),
        ExistingPathKind::File,
    )?;
    let (meta_value, source_cwd, schema_version) = inspect_cursor_meta(&meta, id, &workspace)?;
    if bucket_name != cursor_bucket(&source_cwd) {
        return Err("Cursor chat bucket 与 meta.cwd 的 MD5 不一致".into());
    }
    let store_db = canonical_existing_under(
        &chat_dir,
        &chat_dir.join("store.db"),
        ExistingPathKind::File,
    )?;
    let prompt_path = chat_dir.join("prompt_history.json");
    let prompt_history = match std::fs::symlink_metadata(&prompt_path) {
        Ok(_) => {
            let path = canonical_existing_under(&chat_dir, &prompt_path, ExistingPathKind::File)?;
            validate_prompt_history(&path)?;
            Some(path)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("读取 Cursor prompt history 失败：{error}")),
    };
    let native_title = meta_value
        .get("title")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok(CursorSessionLocation {
        id: id.to_string(),
        source_cwd,
        schema_version,
        chat_dir,
        meta,
        prompt_history,
        store_db,
        native_title,
    })
}

pub fn locate_cursor_session(id: &str, cwd: &str) -> Result<CursorSessionLocation, String> {
    let home = home().ok_or_else(|| "无 home 目录".to_string())?;
    locate_cursor_session_in(&home, id, cwd)
}

/// cursor：递归扫 ~/.cursor/chats/<hash>/<chatId>/meta.json，cwd 字段匹配的列出；
/// 跳过 hasConversation:false 的空壳会话(决策8)；标题取 meta.json 的 title，缺失回退首条用户 prompt。
pub fn list_cursor_sessions(cwd: &str) -> Vec<SessionRef> {
    let Some(home_dir) = home() else {
        return Vec::new();
    };
    list_cursor_sessions_in(&home_dir, cwd)
}

pub(crate) fn list_cursor_sessions_in(home_dir: &Path, cwd: &str) -> Vec<SessionRef> {
    let h = home_dir;
    let root = h.join(".cursor").join("chats");
    if !root.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for entry in WalkDir::new(&root)
        .max_depth(4)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.file_name().to_str() == Some("meta.json"))
        .take(MAX_CURSOR_SCAN)
    {
        let p = entry.path();
        let Ok(txt) = std::fs::read_to_string(p) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
            continue;
        };
        if v.get("schemaVersion").and_then(|value| value.as_u64()) != Some(1) {
            continue;
        }
        let Some(meta_cwd) = v.get("cwd").and_then(|value| value.as_str()) else {
            continue;
        };
        if !same_path(meta_cwd, cwd) {
            continue;
        }
        if v.get("hasConversation").and_then(|b| b.as_bool()) != Some(true) {
            continue; // 决策8：跳过从未真正开始对话的空壳会话
        }
        let Some(chat_dir) = p.parent() else {
            continue;
        };
        let Some(id) = chat_dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if v.get("id").is_some_and(|value| value.as_str() != Some(id)) {
            continue;
        }
        let Some(bucket) = chat_dir
            .parent()
            .and_then(|path| path.file_name())
            .and_then(|value| value.to_str())
        else {
            continue;
        };
        if bucket != cursor_bucket(meta_cwd) {
            continue;
        }
        let Ok(store_metadata) =
            crate::portable_archive::reject_link_or_reparse(&chat_dir.join("store.db"))
        else {
            continue;
        };
        if !store_metadata.is_file() {
            continue;
        }
        let ts = v.get("updatedAtMs").and_then(|t| t.as_i64()).unwrap_or(0);
        let native_title = v.get("title").and_then(|t| t.as_str());
        let label = cursor_label(native_title, read_cursor_first_prompt(chat_dir));
        out.push(SessionRef {
            label,
            id: id.to_string(),
            ts,
            path: chat_dir.to_string_lossy().into_owned(),
        });
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out
}

/// 删除 cursor 会话：整个 chat 目录移入回收站（仅限 ~/.cursor/chats 内；chat-id 无法从目录结构反查，故按 path 删除）。
pub fn delete_cursor_session(path: &str) -> Result<(), String> {
    let Some(h) = home() else {
        return Err("无 home 目录".into());
    };
    let root = h.join(".cursor").join("chats");
    let path = canonical_existing_under(&root, Path::new(path), ExistingPathKind::Directory)?;
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let relative = path
        .strip_prefix(&canonical_root)
        .map_err(|_| "Cursor 删除路径逃逸 chats 根".to_string())?;
    let parts: Vec<_> = relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect();
    if parts.len() != 2 {
        return Err("Cursor 删除目标必须恰为 bucket/chatId".into());
    }
    let bucket = parts[0];
    let id = parts[1];
    validate_session_id(id)?;
    if bucket.len() != 32
        || !bucket
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Cursor 删除目标 bucket 不是小写 MD5".into());
    }
    let meta_path =
        canonical_existing_under(&path, &path.join("meta.json"), ExistingPathKind::File)?;
    let meta = read_small_json(&meta_path, "Cursor meta.json")?;
    if meta.get("schemaVersion").and_then(|value| value.as_u64()) != Some(1)
        || meta
            .get("id")
            .is_some_and(|value| value.as_str() != Some(id))
    {
        return Err("Cursor 删除目标 meta schema/id 无效".into());
    }
    let meta_cwd = meta
        .get("cwd")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Cursor 删除目标 meta 缺少 cwd".to_string())?;
    if bucket != cursor_bucket(meta_cwd) {
        return Err("Cursor 删除目标 bucket 与 meta.cwd 不一致".into());
    }
    canonical_existing_under(&path, &path.join("store.db"), ExistingPathKind::File)?;
    trash::delete(path).map_err(|e| e.to_string())
}

// ---------------- kimi ----------------

const MAX_KIMI_SCAN: usize = 2000; // 最多扫描的 kimi state.json 数（安全上限，目录名不含时间故按遍历序截断）

/// kimi 数据根：`KIMI_CODE_HOME` 环境变量优先（官方契约），缺省 `~/.kimi-code`。
fn kimi_data_root() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("KIMI_CODE_HOME") {
        let v = v.trim().trim_matches('"');
        if !v.is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    home().map(|h| h.join(".kimi-code"))
}

/// RFC3339 时间串（kimi state.json v1 的 createdAt/updatedAt，如 2026-07-20T11:55:25.353Z）→ 毫秒时间戳。
/// 解析失败归 0：该条仅排到列表最末/不参与捕获，不影响其他会话。
fn rfc3339_ms(s: &str) -> i64 {
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
        .map(|t| (t.unix_timestamp_nanos() / 1_000_000) as i64)
        .unwrap_or(0)
}

/// kimi state.json 工作区路径：v1=`workDir`，v2=`cwd`（非空串优先前者）。
fn kimi_session_workdir(v: &serde_json::Value) -> Option<&str> {
    for key in ["workDir", "cwd"] {
        if let Some(s) = v.get(key).and_then(|value| value.as_str()) {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

/// kimi state.json 时间字段：v1=RFC3339 串，v2=epoch 毫秒 number；失败归 0。
fn kimi_ts_ms(v: &serde_json::Value, key: &str) -> i64 {
    let Some(value) = v.get(key) else {
        return 0;
    };
    if let Some(s) = value.as_str() {
        return rfc3339_ms(s);
    }
    if let Some(n) = value.as_i64() {
        return n;
    }
    value.as_u64().map(|n| n as i64).unwrap_or(0)
}

/// kimi v2 `archived: true` → 不列入活跃会话列表 / 不参与 capture。
fn kimi_is_archived(v: &serde_json::Value) -> bool {
    v.get("archived").and_then(|value| value.as_bool()) == Some(true)
}

/// kimi：扫 <数据根>/sessions/<workDirKey>/<sessionId>/state.json，workDir|cwd 匹配的列出；
/// 标题取 title（缺失回退 lastPrompt），ts 取 updatedAt（RFC3339|ms）；id = 目录名（session_<uuid> 完整形态）。
pub fn list_kimi_sessions(cwd: &str) -> Vec<SessionRef> {
    let Some(data_root) = kimi_data_root() else {
        return Vec::new();
    };
    list_kimi_sessions_in(&data_root, cwd)
}

pub(crate) fn list_kimi_sessions_in(data_root: &Path, cwd: &str) -> Vec<SessionRef> {
    let root = data_root.join("sessions");
    if !root.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for entry in WalkDir::new(&root)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.file_name().to_str() == Some("state.json"))
        .take(MAX_KIMI_SCAN)
    {
        let p = entry.path();
        let Ok(txt) = std::fs::read_to_string(p) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
            continue;
        };
        if kimi_is_archived(&v) {
            continue;
        }
        if kimi_session_workdir(&v).map(|value| same_path(value, cwd)) != Some(true) {
            continue;
        }
        let Some(session_dir) = p.parent() else {
            continue;
        };
        let Some(id) = session_dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let fallback = v
            .get("lastPrompt")
            .and_then(|value| value.as_str())
            .map(|s| s.chars().take(80).collect());
        let label = cursor_label(v.get("title").and_then(|value| value.as_str()), fallback);
        let ts = kimi_ts_ms(&v, "updatedAt");
        out.push(SessionRef {
            label,
            id: id.to_string(),
            ts,
            path: session_dir.to_string_lossy().into_owned(),
        });
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out
}

/// 删除 kimi 会话：整个 session 目录移入回收站（仅限 <数据根>/sessions 内），
/// 并从 session_index.jsonl 剔除对应行（读-改-写走临时文件 + rename 原子替换，防与 kimi 并发追加打架）。
pub fn delete_kimi_session(path: &str) -> Result<(), String> {
    let Some(data_root) = kimi_data_root() else {
        return Err("无 kimi 数据目录".into());
    };
    let root = data_root.join("sessions");
    let path = canonical_existing_under(&root, Path::new(path), ExistingPathKind::Directory)?;
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let relative = path
        .strip_prefix(&canonical_root)
        .map_err(|_| "Kimi 删除路径逃逸 sessions 根".to_string())?;
    let parts: Vec<_> = relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect();
    if parts.len() != 2 {
        return Err("Kimi 删除目标必须恰为 bucket/sessionId".into());
    }
    let bucket = parts[0];
    let id = parts[1];
    if !bucket.starts_with("wd_") {
        return Err("Kimi 删除目标 bucket 不是 wd_ 前缀".into());
    }
    let valid_id = id
        .strip_prefix("session_")
        .map(|u| u.len() == 36 && u.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .unwrap_or(false);
    if !valid_id {
        return Err("Kimi 删除目标目录名不是 session_<uuid>".into());
    }
    // state.json 必须存在且可解析（防误删 sessions 根下的同名杂物目录）
    let state_path = canonical_existing_under(&path, &path.join("state.json"), ExistingPathKind::File)?;
    read_small_json(&state_path, "Kimi state.json")?;
    trash::delete(&path).map_err(|e| e.to_string())?;
    let index = data_root.join("session_index.jsonl");
    if let Ok(content) = std::fs::read_to_string(&index) {
        let needle = format!("\"sessionId\":\"{id}\"");
        let kept: Vec<&str> = content.lines().filter(|l| !l.contains(&needle)).collect();
        if kept.len() != content.lines().count() {
            let mut out = kept.join("\n");
            if content.ends_with('\n') {
                out.push('\n');
            }
            let tmp = index.with_extension("jsonl.htytmp");
            std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &index).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------------- 运行后捕获 agent 自生成的 session id ----------------

/// 只比较两个现存目录的 canonical identity；解析失败即不匹配。
fn same_path(a: &str, b: &str) -> bool {
    canonical_same_existing_path(Path::new(a), Path::new(b)).unwrap_or(false)
}

/// 捕获某 agent 在 cwd 下、启动时刻(since_ms)之后新生成的会话 id（按时间升序）。
/// 各 CLI 都不便在新建时预分配 id，故新建发裸命令、启动后由此关联各自终端的真实 session id。
pub fn capture_session_ids(agent: &str, cwd: &str, since_ms: i64) -> Vec<String> {
    match agent {
        "claude" => capture_claude_ids(cwd, since_ms),
        "codex" => capture_codex_ids(cwd, since_ms),
        "opencode" => capture_opencode_ids(cwd, since_ms),
        "cursor" => capture_cursor_ids(cwd, since_ms),
        "kimi" => capture_kimi_ids(cwd, since_ms),
        _ => Vec::new(),
    }
}

/// PTY shell → sessionId 映射（与 `terminal_pty_pid` 对齐）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionMap {
    pub pty_pid: u32,
    pub session_id: String,
}

#[derive(Clone)]
struct ClaudeSessionProc {
    id: String,
    pid: u32,
    started_at: i64,
}

/// claude：读 ~/.claude/sessions/<pid>.json（运行中会话状态，含 sessionId/cwd/startedAt/kind），
/// 取 cwd 匹配、startedAt>=since、interactive 的条目，按 startedAt 升序。
fn scan_claude_session_procs(cwd: &str, since_ms: i64) -> Vec<ClaudeSessionProc> {
    let Some(h) = home() else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(h.join(".claude").join("sessions")) else {
        return Vec::new();
    };
    let mut hits: Vec<ClaudeSessionProc> = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(txt) = std::fs::read_to_string(&p) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
            continue;
        };
        if v.get("cwd")
            .and_then(|c| c.as_str())
            .map(|c| same_path(c, cwd))
            != Some(true)
        {
            continue;
        }
        let started = v.get("startedAt").and_then(|t| t.as_i64()).unwrap_or(0);
        if started < since_ms {
            continue;
        }
        if v.get("kind").and_then(|k| k.as_str()) != Some("interactive") {
            continue; // 排除 print/exec 等一次性会话
        }
        let Some(id) = v.get("sessionId").and_then(|s| s.as_str()) else {
            continue;
        };
        // 优先 JSON 内 pid，回退文件名 stem（sessions/<pid>.json）
        let pid = v
            .get("pid")
            .and_then(|x| x.as_u64())
            .map(|x| x as u32)
            .or_else(|| {
                p.file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(|s| s.parse().ok())
            });
        let Some(pid) = pid else {
            continue;
        };
        hits.push(ClaudeSessionProc {
            id: id.to_string(),
            pid,
            started_at: started,
        });
    }
    hits.sort_by_key(|h| h.started_at);
    hits
}

fn capture_claude_ids(cwd: &str, since_ms: i64) -> Vec<String> {
    scan_claude_session_procs(cwd, since_ms)
        .into_iter()
        .map(|h| h.id)
        .collect()
}

/// 将各 PTY shell pid 映射到对应 agent 的 sessionId。
/// - claude：`sessions/<pid>.json` 的 pid 落在 PTY 进程树内（精确）
/// - cursor/codex/kimi：优先解析子树进程命令行里的 `--resume`/`resume`/`--session`；
///   否则用**主进程**（index.js / codex.js / kimi.exe，非 worker）创建时间 ↔ 会话 createdAt 最近邻
pub fn map_agent_sessions_by_pty(
    agent: &str,
    cwd: &str,
    since_ms: i64,
    pty_pids: &[u32],
) -> Vec<PtySessionMap> {
    match agent {
        "claude" => map_claude_sessions_by_pty(cwd, since_ms, pty_pids),
        "codex" | "opencode" | "cursor" | "kimi" => {
            map_sessions_by_agent_process(agent, cwd, since_ms, pty_pids)
        }
        _ => Vec::new(),
    }
}

/// 兼容旧命令名。
pub fn map_claude_sessions_by_pty(
    cwd: &str,
    since_ms: i64,
    pty_pids: &[u32],
) -> Vec<PtySessionMap> {
    if pty_pids.is_empty() {
        return Vec::new();
    }
    let want: HashSet<u32> = pty_pids.iter().copied().filter(|&p| p != 0).collect();
    if want.is_empty() {
        return Vec::new();
    }
    let snap = process_snapshot();
    let mut out = Vec::new();
    let mut used_sessions = HashSet::new();
    let mut used_pty = HashSet::new();
    for hit in scan_claude_session_procs(cwd, since_ms) {
        if used_sessions.contains(&hit.id) {
            continue;
        }
        let Some(pty) = find_ancestor_in(hit.pid, &want, &snap.parents) else {
            continue;
        };
        if !used_pty.insert(pty) {
            continue;
        }
        used_sessions.insert(hit.id.clone());
        out.push(PtySessionMap {
            pty_pid: pty,
            session_id: hit.id,
        });
    }
    out
}

/// 会话侧 (id, created_ms)，按时间升序。
fn scan_session_times(agent: &str, cwd: &str, since_ms: i64) -> Vec<(String, i64)> {
    match agent {
        "codex" => scan_codex_session_times(cwd, since_ms),
        "opencode" => scan_opencode_session_times(cwd, since_ms),
        "cursor" => scan_cursor_session_times(cwd, since_ms),
        "kimi" => scan_kimi_session_times(cwd, since_ms),
        _ => Vec::new(),
    }
}

fn scan_opencode_session_times(cwd: &str, since_ms: i64) -> Vec<(String, i64)> {
    let Ok(sessions) = query_opencode_sessions(cwd) else {
        return Vec::new();
    };
    let mut hits: Vec<_> = sessions
        .into_iter()
        .filter_map(|session| {
            let created = session.created;
            (created >= since_ms).then_some((session.id, created))
        })
        .collect();
    hits.sort_by_key(|(_, created)| *created);
    hits
}

fn scan_codex_session_times(cwd: &str, since_ms: i64) -> Vec<(String, i64)> {
    let Some(h) = home() else {
        return Vec::new();
    };
    let root = h.join(".codex").join("sessions");
    if !root.is_dir() {
        return Vec::new();
    }
    let mut hits: Vec<(String, i64)> = Vec::new();
    for entry in WalkDir::new(&root)
        .max_depth(5)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let p = entry.path();
        let is_rollout = p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
            .unwrap_or(false);
        if !is_rollout {
            continue;
        }
        let mt = mtime_ms(p);
        if mt < since_ms {
            continue;
        }
        let head = read_head_lines(p, 1);
        let Some(first) = head.first() else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<serde_json::Value>(first) else {
            continue;
        };
        if meta.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
            continue;
        }
        let payload = meta.get("payload");
        if payload
            .and_then(|pl| pl.get("cwd"))
            .and_then(|c| c.as_str())
            .map(|c| same_path(c, cwd))
            != Some(true)
        {
            continue;
        }
        let Some(id) = payload.and_then(|pl| pl.get("id")).and_then(|i| i.as_str()) else {
            continue;
        };
        let created = payload
            .and_then(|pl| pl.get("timestamp"))
            .and_then(|t| t.as_str())
            .map(rfc3339_ms)
            .filter(|&t| t > 0)
            .unwrap_or(mt);
        if created < since_ms {
            continue;
        }
        hits.push((id.to_string(), created));
    }
    hits.sort_by_key(|(_, t)| *t);
    hits
}

fn scan_cursor_session_times(cwd: &str, since_ms: i64) -> Vec<(String, i64)> {
    let Some(h) = home() else {
        return Vec::new();
    };
    let root = h.join(".cursor").join("chats");
    if !root.is_dir() {
        return Vec::new();
    }
    let mut hits: Vec<(String, i64)> = Vec::new();
    for entry in WalkDir::new(&root)
        .max_depth(4)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.file_name().to_str() == Some("meta.json"))
        .take(MAX_CURSOR_SCAN)
    {
        let p = entry.path();
        let Ok(txt) = std::fs::read_to_string(p) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
            continue;
        };
        let created = v.get("createdAtMs").and_then(|t| t.as_i64()).unwrap_or(0);
        if created < since_ms {
            continue;
        }
        if v.get("cwd")
            .and_then(|c| c.as_str())
            .map(|c| same_path(c, cwd))
            != Some(true)
        {
            continue;
        }
        let Some(chat_dir) = p.parent() else {
            continue;
        };
        if let Some(id) = chat_dir.file_name().and_then(|n| n.to_str()) {
            hits.push((id.to_string(), created));
        }
    }
    hits.sort_by_key(|(_, t)| *t);
    hits
}

fn scan_kimi_session_times(cwd: &str, since_ms: i64) -> Vec<(String, i64)> {
    let Some(data_root) = kimi_data_root() else {
        return Vec::new();
    };
    scan_kimi_session_times_in(&data_root, cwd, since_ms)
}

/// 测试 / list 同源：在给定数据根下按 createdAt(since) + workDir|cwd 扫会话 id。
pub(crate) fn scan_kimi_session_times_in(
    data_root: &Path,
    cwd: &str,
    since_ms: i64,
) -> Vec<(String, i64)> {
    let root = data_root.join("sessions");
    if !root.is_dir() {
        return Vec::new();
    }
    let mut hits: Vec<(String, i64)> = Vec::new();
    for entry in WalkDir::new(&root)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.file_name().to_str() == Some("state.json"))
        .take(MAX_KIMI_SCAN)
    {
        let p = entry.path();
        let Ok(txt) = std::fs::read_to_string(p) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
            continue;
        };
        if kimi_is_archived(&v) {
            continue;
        }
        let created = kimi_ts_ms(&v, "createdAt");
        if created < since_ms {
            continue;
        }
        if kimi_session_workdir(&v).map(|value| same_path(value, cwd)) != Some(true) {
            continue;
        }
        let Some(session_dir) = p.parent() else {
            continue;
        };
        if let Some(id) = session_dir.file_name().and_then(|n| n.to_str()) {
            hits.push((id.to_string(), created));
        }
    }
    hits.sort_by_key(|(_, t)| *t);
    hits
}

/// cursor/codex/kimi：命令行 session id 优先，否则主进程创建时间最近邻（|Δt|<120s）。
fn map_sessions_by_agent_process(
    agent: &str,
    cwd: &str,
    since_ms: i64,
    pty_pids: &[u32],
) -> Vec<PtySessionMap> {
    if pty_pids.is_empty() {
        return Vec::new();
    }
    let sessions = scan_session_times(agent, cwd, since_ms);
    if sessions.is_empty() {
        return Vec::new();
    }
    let valid: HashSet<String> = sessions.iter().map(|(id, _)| id.clone()).collect();
    let snap = process_snapshot();
    let mut used_sid = HashSet::new();
    let mut used_pty = HashSet::new();
    let mut out = Vec::new();

    // Pass 1：命令行里已有 --resume / resume / --session → 精确
    for &pty in pty_pids {
        if pty == 0 || used_pty.contains(&pty) {
            continue;
        }
        let Some(sid) = session_id_from_pty_cmdline(agent, pty, &snap, &valid) else {
            continue;
        };
        if !used_sid.insert(sid.clone()) {
            continue;
        }
        used_pty.insert(pty);
        out.push(PtySessionMap {
            pty_pid: pty,
            session_id: sid,
        });
    }

    // Pass 2：剩余 PTY 用主进程创建时间最近邻（避开 cursor worker node）
    let mut cands: Vec<(u32, i64)> = Vec::new();
    for &pty in pty_pids {
        if pty == 0 || used_pty.contains(&pty) {
            continue;
        }
        let Some(agent_pid) = pick_agent_main_pid(agent, pty, &snap) else {
            continue;
        };
        let Some(start) = process_creation_ms_from_snapshot(agent_pid, &snap) else {
            continue;
        };
        cands.push((pty, start));
    }
    cands.sort_by_key(|(_, t)| *t);
    const MAX_DELTA_MS: i64 = 120_000;
    for (pty, start) in cands {
        let mut best: Option<(usize, i64)> = None;
        for (i, (sid, created)) in sessions.iter().enumerate() {
            if used_sid.contains(sid) {
                continue;
            }
            let delta = (created - start).abs();
            if delta > MAX_DELTA_MS {
                continue;
            }
            if best.map(|(_, d)| delta < d).unwrap_or(true) {
                best = Some((i, delta));
            }
        }
        let Some((i, _)) = best else {
            continue;
        };
        let sid = sessions[i].0.clone();
        used_sid.insert(sid.clone());
        used_pty.insert(pty);
        out.push(PtySessionMap {
            pty_pid: pty,
            session_id: sid,
        });
    }
    out
}

/// 在 PTY 子树进程命令行中找已出现在 `valid` 里的 session id。
fn session_id_from_pty_cmdline(
    agent: &str,
    pty_pid: u32,
    snap: &ProcSnap,
    valid: &HashSet<String>,
) -> Option<String> {
    for pid in descendant_pids(pty_pid, &snap.parents) {
        let Some(cmd) = process_command_line_from_snapshot(pid, snap) else {
            continue;
        };
        if let Some(id) = extract_session_id_from_cmdline(agent, &cmd) {
            let canon = if agent == "opencode" {
                valid.get(&id)
            } else {
                valid.iter().find(|value| value.eq_ignore_ascii_case(&id))
            };
            if let Some(canon) = canon {
                return Some(canon.clone());
            }
        }
    }
    None
}

/// 从 agent 进程命令行解析 session id。
fn extract_session_id_from_cmdline(agent: &str, cmd: &str) -> Option<String> {
    let lower = cmd.to_ascii_lowercase();
    match agent {
        "cursor" => {
            // ... index.js --resume <uuid>
            extract_flag_value(&lower, &["--resume", "-r"]).and_then(normalize_uuid)
        }
        "codex" => {
            // `codex resume <uuid>` 或 flag 形态
            extract_flag_value(&lower, &["--resume", "-r"])
                .or_else(|| extract_subcommand_value(&lower, "resume"))
                .and_then(normalize_uuid)
        }
        "opencode" => {
            let raw = extract_flag_value(cmd, &["--session", "-s"])?;
            let value = raw.trim_matches(|c| c == '"' || c == '\'');
            validate_opencode_session_id(value)
                .is_ok()
                .then(|| value.to_string())
        }
        "kimi" => {
            // `kimi --session session_<uuid>`
            let raw = extract_flag_value(&lower, &["--session", "-s"])?;
            if raw.starts_with("session_") {
                Some(raw.to_string())
            } else {
                normalize_uuid(raw).map(|u| format!("session_{u}"))
            }
        }
        _ => None,
    }
}

fn normalize_uuid(s: &str) -> Option<String> {
    let s = s.trim().trim_matches(|c| c == '"' || c == '\'');
    let ok = s.len() == 36
        && s.as_bytes().iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        });
    ok.then(|| s.to_ascii_lowercase())
}

fn extract_flag_value<'a>(cmd: &'a str, flags: &[&str]) -> Option<&'a str> {
    for flag in flags {
        // `--resume <id>` / `--resume=<id>`
        if let Some(rest) = cmd.split(flag).nth(1) {
            let rest = rest.trim_start();
            if let Some(v) = rest.strip_prefix('=') {
                return v.split_whitespace().next();
            }
            if rest.starts_with('-') {
                continue; // 下一个 flag，无值
            }
            return rest.split_whitespace().next();
        }
    }
    None
}

fn extract_subcommand_value<'a>(cmd: &'a str, sub: &str) -> Option<&'a str> {
    // `codex.exe ... resume <uuid>`：sub 作为独立 token
    let mut parts = cmd.split_whitespace();
    while let Some(p) = parts.next() {
        if p == sub {
            return parts.next();
        }
    }
    None
}

struct ProcSnap {
    parents: HashMap<u32, u32>,
    names: HashMap<u32, String>, // lowercase exe
    commands: HashMap<u32, String>,
    started_at: HashMap<u32, i64>,
}

fn process_snapshot() -> ProcSnap {
    #[cfg(windows)]
    {
        win_process_snapshot()
    }
    #[cfg(not(windows))]
    {
        unix_process_snapshot()
    }
}

#[cfg(not(windows))]
fn parse_elapsed_seconds(value: &str) -> Option<i64> {
    let (days, clock) = if let Some((days, clock)) = value.split_once('-') {
        (days.parse::<i64>().ok()?, clock)
    } else {
        (0, value)
    };
    let parts: Vec<i64> = clock
        .split(':')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    let seconds = match parts.as_slice() {
        [minutes, seconds] => minutes * 60 + seconds,
        [hours, minutes, seconds] => hours * 3600 + minutes * 60 + seconds,
        _ => return None,
    };
    Some(days * 86_400 + seconds)
}

#[cfg(not(windows))]
fn unix_process_snapshot() -> ProcSnap {
    let mut snap = ProcSnap {
        parents: HashMap::new(),
        names: HashMap::new(),
        commands: HashMap::new(),
        started_at: HashMap::new(),
    };
    let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,etime=,comm=,command="])
        .output()
    else {
        return snap;
    };
    if !output.status.success() {
        return snap;
    }
    let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(elapsed), Some(command_name)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(ppid), Some(elapsed)) = (
            pid.parse::<u32>(),
            ppid.parse::<u32>(),
            parse_elapsed_seconds(elapsed),
        ) else {
            continue;
        };
        snap.parents.insert(pid, ppid);
        let name = Path::new(command_name)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(command_name)
            .to_ascii_lowercase();
        snap.names.insert(pid, name);
        snap.commands.insert(pid, fields.collect::<Vec<_>>().join(" "));
        snap.started_at.insert(pid, now as i64 - elapsed * 1000);
    }
    snap
}

/// 从 pid 沿父链向上，若命中 `want` 中任一祖先则返回该祖先 pid。
fn find_ancestor_in(pid: u32, want: &HashSet<u32>, parents: &HashMap<u32, u32>) -> Option<u32> {
    let mut cur = pid;
    for _ in 0..64 {
        if want.contains(&cur) {
            return Some(cur);
        }
        cur = *parents.get(&cur)?;
        if cur == 0 {
            break;
        }
    }
    None
}

fn descendant_pids(root: u32, parents: &HashMap<u32, u32>) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, &ppid) in parents {
        children.entry(ppid).or_default().push(pid);
    }
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        if let Some(chs) = children.get(&p) {
            for &c in chs {
                out.push(c);
                stack.push(c);
            }
        }
    }
    out
}

/// 选 PTY 子树中的**主** agent 进程（排除 cursor/codex 的 worker node）。
fn pick_agent_main_pid(agent: &str, pty_pid: u32, snap: &ProcSnap) -> Option<u32> {
    let desc = descendant_pids(pty_pid, &snap.parents);
    if desc.is_empty() {
        return None;
    }
    match agent {
        "kimi" => {
            let hits: Vec<u32> = desc
                .iter()
                .copied()
                .filter(|pid| snap.names.get(pid).map(|n| n.as_str()) == Some("kimi.exe"))
                .collect();
            pick_earliest_pid(&hits, snap)
        }
        "cursor" => {
            // 主入口：node ...\index.js；绝不能用创建最晚的 worker node
            let mut mains = Vec::new();
            for pid in &desc {
                if snap.names.get(pid).map(|n| n.as_str()) != Some("node.exe") {
                    continue;
                }
                let Some(cmd) = process_command_line_from_snapshot(*pid, snap) else {
                    continue;
                };
                let c = cmd.to_ascii_lowercase();
                if c.contains("index.js") && c.contains("cursor-agent") {
                    mains.push(*pid);
                }
            }
            if let Some(p) = pick_earliest_pid(&mains, snap) {
                return Some(p);
            }
            // 无 cmdline 时：取创建最早的 node（主进程先于 worker）
            let nodes: Vec<u32> = desc
                .iter()
                .copied()
                .filter(|pid| snap.names.get(pid).map(|n| n.as_str()) == Some("node.exe"))
                .collect();
            pick_earliest_pid(&nodes, snap)
        }
        "codex" => {
            let mut mains = Vec::new();
            for pid in &desc {
                let name = snap.names.get(pid).map(|n| n.as_str()).unwrap_or("");
                if name == "codex.exe" {
                    mains.push(*pid);
                    continue;
                }
                if name != "node.exe" {
                    continue;
                }
                let Some(cmd) = process_command_line_from_snapshot(*pid, snap) else {
                    continue;
                };
                let c = cmd.to_ascii_lowercase();
                if c.contains("codex.js") || c.contains("@openai\\codex") || c.contains("@openai/codex")
                {
                    mains.push(*pid);
                }
            }
            if let Some(p) = pick_earliest_pid(&mains, snap) {
                return Some(p);
            }
            let nodes: Vec<u32> = desc
                .iter()
                .copied()
                .filter(|pid| snap.names.get(pid).map(|n| n.as_str()) == Some("node.exe"))
                .collect();
            pick_earliest_pid(&nodes, snap)
        }
        "opencode" => {
            let hits: Vec<u32> = desc
                .iter()
                .copied()
                .filter(|pid| {
                    let name = snap.names.get(pid).map(String::as_str).unwrap_or("");
                    if matches!(name, "opencode" | "opencode.exe") {
                        return true;
                    }
                    process_command_line_from_snapshot(*pid, snap)
                        .map(|command| command.to_ascii_lowercase().contains("opencode"))
                        .unwrap_or(false)
                })
                .collect();
            pick_earliest_pid(&hits, snap)
        }
        _ => None,
    }
}

fn pick_earliest_pid(pids: &[u32], snap: &ProcSnap) -> Option<u32> {
    pids.iter()
        .copied()
        .min_by_key(|pid| process_creation_ms_from_snapshot(*pid, snap).unwrap_or(i64::MAX))
}

fn process_command_line_from_snapshot(pid: u32, snap: &ProcSnap) -> Option<String> {
    snap.commands
        .get(&pid)
        .filter(|value| !value.is_empty())
        .cloned()
        .or_else(|| process_command_line(pid))
}

fn process_creation_ms_from_snapshot(pid: u32, snap: &ProcSnap) -> Option<i64> {
    snap.started_at
        .get(&pid)
        .copied()
        .or_else(|| process_creation_ms(pid))
}

fn process_command_line(pid: u32) -> Option<String> {
    #[cfg(windows)]
    {
        win_process_command_line(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

fn process_creation_ms(pid: u32) -> Option<i64> {
    #[cfg(windows)]
    {
        win_process_creation_ms(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

#[cfg(windows)]
fn win_process_creation_ms(pid: u32) -> Option<i64> {
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn GetProcessTimes(
            handle: isize,
            creation: *mut i64,
            exit: *mut i64,
            kernel: *mut i64,
            user: *mut i64,
        ) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h == 0 {
            return None;
        }
        let mut creation = 0i64;
        let mut exit = 0i64;
        let mut kernel = 0i64;
        let mut user = 0i64;
        let ok = GetProcessTimes(h, &mut creation, &mut exit, &mut kernel, &mut user);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        // FILETIME：100ns since 1601-01-01 → Unix ms
        Some(creation / 10_000 - 11_644_473_600_000)
    }
}

/// Win10+：`NtQueryInformationProcess(ProcessCommandLineInformation=60)` 读命令行。
#[cfg(windows)]
fn win_process_command_line(pid: u32) -> Option<String> {
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *const u16,
    }

    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn CloseHandle(handle: isize) -> i32;
        fn NtQueryInformationProcess(
            handle: isize,
            info_class: u32,
            info: *mut u8,
            info_len: u32,
            return_len: *mut u32,
        ) -> i32;
    }

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
    const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC0000004u32 as i32;

    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h == 0 {
            return None;
        }
        let mut need = 0u32;
        let st = NtQueryInformationProcess(
            h,
            PROCESS_COMMAND_LINE_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut need,
        );
        if st != STATUS_INFO_LENGTH_MISMATCH || need == 0 {
            // 有的系统仍返回 0 长度；给一个合理兜底再试
            need = 65536;
        }
        let mut buf = vec![0u8; need as usize];
        let mut ret_len = 0u32;
        let st = NtQueryInformationProcess(
            h,
            PROCESS_COMMAND_LINE_INFORMATION,
            buf.as_mut_ptr(),
            need,
            &mut ret_len,
        );
        CloseHandle(h);
        if st != 0 {
            return None;
        }
        if buf.len() < std::mem::size_of::<UnicodeString>() {
            return None;
        }
        let uni = &*(buf.as_ptr() as *const UnicodeString);
        if uni.buffer.is_null() || uni.length == 0 {
            return None;
        }
        let nchars = (uni.length as usize) / 2;
        let slice = std::slice::from_raw_parts(uni.buffer, nchars);
        Some(String::from_utf16_lossy(slice))
    }
}

#[cfg(windows)]
fn win_process_snapshot() -> ProcSnap {
    use std::mem::{size_of, zeroed};

    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const INVALID_HANDLE_VALUE: isize = -1;

    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
        fn Process32FirstW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }

    let mut parents = HashMap::new();
    let mut names = HashMap::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap == 0 {
            return ProcSnap {
                parents,
                names,
                commands: HashMap::new(),
                started_at: HashMap::new(),
            };
        }
        let mut entry: ProcessEntry32W = zeroed();
        entry.dw_size = size_of::<ProcessEntry32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                parents.insert(entry.th32_process_id, entry.th32_parent_process_id);
                let len = entry
                    .sz_exe_file
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.sz_exe_file.len());
                let name = String::from_utf16_lossy(&entry.sz_exe_file[..len]).to_lowercase();
                names.insert(entry.th32_process_id, name);
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    ProcSnap {
        parents,
        names,
        commands: HashMap::new(),
        started_at: HashMap::new(),
    }
}

/// codex：扫 rollout，cwd 匹配、created>=since 的 id（升序）。认领请走 `map_agent_sessions_by_pty`。
fn capture_codex_ids(cwd: &str, since_ms: i64) -> Vec<String> {
    scan_codex_session_times(cwd, since_ms)
        .into_iter()
        .map(|(id, _)| id)
        .collect()
}

fn capture_opencode_ids(cwd: &str, since_ms: i64) -> Vec<String> {
    scan_opencode_session_times(cwd, since_ms)
        .into_iter()
        .map(|(id, _)| id)
        .collect()
}

/// cursor：扫 meta.json，不按 hasConversation 过滤（空壳正是捕获目标）。
fn capture_cursor_ids(cwd: &str, since_ms: i64) -> Vec<String> {
    scan_cursor_session_times(cwd, since_ms)
        .into_iter()
        .map(|(id, _)| id)
        .collect()
}

/// kimi：扫 state.json，不按 title 过滤（启动即创建，已实测）。
fn capture_kimi_ids(cwd: &str, since_ms: i64) -> Vec<String> {
    scan_kimi_session_times(cwd, since_ms)
        .into_iter()
        .map(|(id, _)| id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_existing_under, codex_label, cursor_bucket, cursor_label,
        first_prompt_from_history, list_codex_sessions_in, list_kimi_sessions_in,
        locate_claude_session_in, locate_codex_session_in, locate_cursor_session_in,
        parse_codex_session_titles, query_opencode_sessions_in, scan_kimi_session_times_in,
        validate_codex_relative_path, validate_opencode_session_id, validate_session_id,
        ExistingPathKind, MAX_OPENCODE_SESSIONS,
    };
    use rusqlite::{params, Connection};
    use serde_json::{json, Value};
    use std::fs;
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use tempfile::TempDir;

    const TEST_ID: &str = "12345678-1234-4abc-8def-1234567890ab";
    const OTHER_ID: &str = "87654321-4321-4cba-8fed-ba0987654321";

    struct TestHome {
        _temp: TempDir,
        home: PathBuf,
        workspace: PathBuf,
        other_workspace: PathBuf,
    }

    fn test_home() -> TestHome {
        let temp = tempfile::tempdir().expect("create temp fixture root");
        let home = temp.path().join("home");
        let workspace = temp.path().join("workspace");
        let other_workspace = temp.path().join("other-workspace");
        fs::create_dir_all(&home).expect("create fixture home");
        fs::create_dir_all(&workspace).expect("create fixture workspace");
        fs::create_dir_all(&other_workspace).expect("create alternate workspace");
        TestHome {
            _temp: temp,
            home,
            workspace,
            other_workspace,
        }
    }

    fn path_text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn opencode_sessions_read_sqlite_filter_sort_and_bound_results() {
        let ctx = test_home();
        let database = ctx.home.join("opencode.db");
        let mut connection = Connection::open(&database).expect("create OpenCode fixture database");
        connection
            .execute_batch(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    directory TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL
                );",
            )
            .expect("create OpenCode session table");
        let workspace = path_text(&ctx.workspace);
        let other_workspace = path_text(&ctx.other_workspace);
        let transaction = connection.transaction().expect("start fixture transaction");
        for index in 0..=MAX_OPENCODE_SESSIONS {
            transaction
                .execute(
                    "INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        format!("ses_valid{index}"),
                        format!("session {index}"),
                        workspace,
                        index as i64,
                        index as i64
                    ],
                )
                .expect("insert matching OpenCode session");
        }
        transaction
            .execute(
                "INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["ses_other", "other", other_workspace, 9_000_i64, 9_000_i64],
            )
            .expect("insert other-workspace session");
        transaction
            .execute(
                "INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["ses_bad-token", "invalid", workspace, 10_000_i64, 10_000_i64],
            )
            .expect("insert invalid session");
        transaction.commit().expect("commit fixture database");
        drop(connection);

        let sessions = query_opencode_sessions_in(&database, &workspace)
            .expect("query OpenCode fixture sessions");
        assert_eq!(sessions.len(), MAX_OPENCODE_SESSIONS);
        assert_eq!(sessions[0].id, format!("ses_valid{MAX_OPENCODE_SESSIONS}"));
        assert_eq!(sessions[0].title, format!("session {MAX_OPENCODE_SESSIONS}"));
        assert_eq!(sessions[0].updated, MAX_OPENCODE_SESSIONS as i64);
        assert_eq!(sessions.last().map(|session| session.created), Some(1));
        assert!(validate_opencode_session_id("ses_validABC123").is_ok());
        assert!(validate_opencode_session_id("ses_bad-token").is_err());
    }

    #[test]
    fn opencode_resume_command_line_extracts_session_id() {
        assert_eq!(
            super::extract_session_id_from_cmdline(
                "opencode",
                "opencode --session ses_1becf408cffeLlQq78DVRtnZTz"
            )
            .as_deref(),
            Some("ses_1becf408cffeLlQq78DVRtnZTz")
        );
        assert!(super::extract_session_id_from_cmdline(
            "opencode",
            "opencode --session ses_bad-token"
        )
        .is_none());
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_elapsed_time_parser_handles_ps_formats() {
        assert_eq!(super::parse_elapsed_seconds("02:03"), Some(123));
        assert_eq!(super::parse_elapsed_seconds("01:02:03"), Some(3723));
        assert_eq!(super::parse_elapsed_seconds("2-01:02:03"), Some(176523));
        assert_eq!(super::parse_elapsed_seconds("bad"), None);
    }

    fn write_json_lines(path: &Path, values: &[Value]) {
        fs::create_dir_all(path.parent().expect("fixture file parent"))
            .expect("create fixture parent");
        let mut text = values
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        text.push('\n');
        fs::write(path, text).expect("write JSONL fixture");
    }

    fn write_claude_fixture(ctx: &TestHome, record_id: &str, record_cwd: &Path) -> PathBuf {
        let cwd = path_text(&ctx.workspace);
        let slug = crate::catalog::claude_project_slug(&cwd).expect("derive Claude slug");
        let project = ctx.home.join(".claude").join("projects").join(slug);
        let transcript = project.join(format!("{TEST_ID}.jsonl"));
        write_json_lines(
            &transcript,
            &[
                json!({"type": "file-history-snapshot", "snapshot": {}}),
                json!({
                    "type": "user",
                    "sessionId": record_id,
                    "cwd": path_text(record_cwd),
                    "version": "2.1.0",
                    "message": {"role": "user", "content": "hello"}
                }),
            ],
        );
        write_json_lines(
            &ctx.home.join(".claude").join("history.jsonl"),
            &[json!({"sessionId": TEST_ID, "project": cwd, "display": "hello"})],
        );
        fs::create_dir_all(project.join(TEST_ID).join("subagents"))
            .expect("create Claude subagents");
        fs::create_dir_all(project.join(TEST_ID).join("tool-results"))
            .expect("create Claude tool results");
        fs::create_dir_all(ctx.home.join(".claude").join("tasks").join(TEST_ID))
            .expect("create Claude tasks");
        transcript
    }

    fn write_codex_rollout(ctx: &TestHome, date: [&str; 3], meta_cwd: &Path) -> PathBuf {
        let file_name = format!(
            "rollout-{}-{}-{}T12-34-56-{TEST_ID}.jsonl",
            date[0], date[1], date[2]
        );
        let rollout = ctx
            .home
            .join(".codex")
            .join("sessions")
            .join(date[0])
            .join(date[1])
            .join(date[2])
            .join(file_name);
        write_json_lines(
            &rollout,
            &[json!({
                "type": "session_meta",
                "payload": {
                    "id": TEST_ID,
                    "session_id": OTHER_ID,
                    "cwd": path_text(meta_cwd),
                    "cli_version": "0.101.0"
                }
            })],
        );
        write_json_lines(
            &ctx.home.join(".codex").join("session_index.jsonl"),
            &[json!({"id": TEST_ID, "thread_name": "native title"})],
        );
        rollout
    }

    fn cursor_meta(cwd: &Path) -> Value {
        json!({
            "schemaVersion": 1,
            "createdAtMs": 1,
            "updatedAtMs": 2,
            "hasConversation": true,
            "title": "Cursor title",
            "cwd": path_text(cwd)
        })
    }

    fn write_cursor_fixture(
        ctx: &TestHome,
        bucket: &str,
        meta: &Value,
        prompt: Option<&Value>,
        with_store: bool,
    ) -> PathBuf {
        let chat = ctx
            .home
            .join(".cursor")
            .join("chats")
            .join(bucket)
            .join(TEST_ID);
        fs::create_dir_all(&chat).expect("create Cursor chat fixture");
        fs::write(
            chat.join("meta.json"),
            serde_json::to_vec(meta).expect("serialize Cursor meta"),
        )
        .expect("write Cursor meta");
        if let Some(prompt) = prompt {
            fs::write(
                chat.join("prompt_history.json"),
                serde_json::to_vec(prompt).expect("serialize prompt history"),
            )
            .expect("write prompt history");
        }
        if with_store {
            fs::write(chat.join("store.db"), b"sqlite fixture").expect("write Cursor store");
        }
        chat
    }

    #[test]
    fn locator_rejects_noncanonical_session_ids() {
        assert!(validate_session_id(TEST_ID).is_ok());
        for invalid in [
            "12345678-1234-4ABC-8def-1234567890ab",
            "1234567812344abc8def1234567890ab",
            "12345678-1234-4abc-8def-1234567890ag",
            "../../12345678-1234-4abc-8def-1234567890ab",
        ] {
            assert!(
                validate_session_id(invalid).is_err(),
                "unexpected accepted id: {invalid}"
            );
        }
    }

    #[test]
    fn canonical_containment_rejects_same_prefix_sibling() {
        let temp = tempfile::tempdir().expect("create containment fixture");
        let root = temp.path().join("authority");
        let sibling = temp.path().join("authority-escape");
        fs::create_dir_all(&root).expect("create authority root");
        fs::create_dir_all(&sibling).expect("create sibling");
        let escaped = sibling.join("session.jsonl");
        fs::write(&escaped, b"fixture").expect("write sibling fixture");

        assert!(canonical_existing_under(&root, &escaped, ExistingPathKind::File).is_err());
    }

    #[test]
    fn claude_locator_accepts_later_body_record_and_collects_sidecars() {
        let ctx = test_home();
        let transcript = write_claude_fixture(&ctx, TEST_ID, &ctx.workspace);
        let mut transcript_text = fs::read_to_string(&transcript).unwrap();
        transcript_text.push_str(
            &json!({
                "type": "user",
                "sessionId": TEST_ID,
                "cwd": path_text(&ctx.other_workspace),
                "version": "2.1.1",
                "message": {"role": "user", "content": "switched cwd"}
            })
            .to_string(),
        );
        transcript_text.push('\n');
        fs::write(&transcript, transcript_text).unwrap();
        let location = locate_claude_session_in(&ctx.home, TEST_ID, &path_text(&ctx.workspace))
            .expect("locate valid Claude fixture");

        assert_eq!(location.transcript, transcript.canonicalize().unwrap());
        assert_eq!(location.source_agent_version, "2.1.0");
        assert!(location.history.is_file());
        assert!(location.sidecar_dir.is_some());
        assert!(location.subagents_dir.is_some());
        assert!(location.tool_results_dir.is_some());
        assert!(location.tasks_dir.is_some());
    }

    #[test]
    fn claude_locator_rejects_record_cwd_id_and_duplicate_sources() {
        let wrong_cwd = test_home();
        write_claude_fixture(&wrong_cwd, TEST_ID, &wrong_cwd.other_workspace);
        assert!(locate_claude_session_in(
            &wrong_cwd.home,
            TEST_ID,
            &path_text(&wrong_cwd.workspace)
        )
        .is_err());

        let wrong_id = test_home();
        write_claude_fixture(&wrong_id, OTHER_ID, &wrong_id.workspace);
        assert!(
            locate_claude_session_in(&wrong_id.home, TEST_ID, &path_text(&wrong_id.workspace))
                .is_err()
        );

        let duplicate = test_home();
        let transcript = write_claude_fixture(&duplicate, TEST_ID, &duplicate.workspace);
        let second = duplicate
            .home
            .join(".claude")
            .join("projects")
            .join("duplicate-bucket")
            .join(format!("{TEST_ID}.jsonl"));
        fs::create_dir_all(second.parent().unwrap()).unwrap();
        fs::copy(transcript, second).unwrap();
        assert!(locate_claude_session_in(
            &duplicate.home,
            TEST_ID,
            &path_text(&duplicate.workspace)
        )
        .is_err());
    }

    #[test]
    fn codex_locator_accepts_date_rollout_and_ignores_payload_session_id() {
        let ctx = test_home();
        let rollout = write_codex_rollout(&ctx, ["2026", "07", "11"], &ctx.workspace);
        let location = locate_codex_session_in(&ctx.home, TEST_ID, &path_text(&ctx.workspace))
            .expect("locate valid Codex fixture");

        assert_eq!(location.rollout, rollout.canonicalize().unwrap());
        assert_eq!(
            location.relative_rollout,
            PathBuf::from("2026")
                .join("07")
                .join("11")
                .join(format!("rollout-2026-07-11T12-34-56-{TEST_ID}.jsonl"))
        );
        assert_eq!(location.source_agent_version, "0.101.0");
        assert_eq!(location.native_title.as_deref(), Some("native title"));
    }

    #[test]
    fn codex_relative_path_rejects_invalid_calendar_and_clock() {
        for relative in [
            format!("2026/99/11/rollout-2026-99-11T12-34-56-{TEST_ID}.jsonl"),
            format!("2026/02/30/rollout-2026-02-30T12-34-56-{TEST_ID}.jsonl"),
            format!("2026/07/11/rollout-2026-07-11T24-00-00-{TEST_ID}.jsonl"),
            format!("2026/07/11/rollout-2026-07-11T12-60-00-{TEST_ID}.jsonl"),
        ] {
            assert!(
                validate_codex_relative_path(Path::new(&relative), TEST_ID).is_err(),
                "unexpected accepted rollout path: {relative}"
            );
        }
    }

    #[test]
    fn codex_locator_rejects_zst_duplicate_and_wrong_cwd() {
        let zst = test_home();
        let rollout = write_codex_rollout(&zst, ["2026", "07", "11"], &zst.workspace);
        fs::write(rollout.with_extension("jsonl.zst"), b"compressed").unwrap();
        assert!(locate_codex_session_in(&zst.home, TEST_ID, &path_text(&zst.workspace)).is_err());

        let duplicate = test_home();
        write_codex_rollout(&duplicate, ["2026", "07", "11"], &duplicate.workspace);
        write_codex_rollout(&duplicate, ["2026", "07", "12"], &duplicate.workspace);
        assert!(locate_codex_session_in(
            &duplicate.home,
            TEST_ID,
            &path_text(&duplicate.workspace)
        )
        .is_err());

        let wrong_cwd = test_home();
        write_codex_rollout(&wrong_cwd, ["2026", "07", "11"], &wrong_cwd.other_workspace);
        assert!(locate_codex_session_in(
            &wrong_cwd.home,
            TEST_ID,
            &path_text(&wrong_cwd.workspace)
        )
        .is_err());
    }

    #[test]
    fn cursor_bucket_matches_md5_fixed_vector() {
        assert_eq!(cursor_bucket("hello"), "5d41402abc4b2a76b9719d911017c592");
        assert_eq!(
            cursor_bucket(r"G:\hty_workflows"),
            "a5be933639be67a913c398fd5904e6b1"
        );
        assert_eq!(
            cursor_bucket(r"E:\UnityProject\BoardGameEditor"),
            "d603a8c29eca8a85a18f7c5ea0a803d7"
        );
    }

    #[test]
    fn cursor_locator_accepts_schema_one_without_meta_id() {
        let ctx = test_home();
        let cwd = path_text(&ctx.workspace);
        let bucket = cursor_bucket(&cwd);
        let chat = write_cursor_fixture(
            &ctx,
            &bucket,
            &cursor_meta(&ctx.workspace),
            Some(&json!(["first prompt"])),
            true,
        );
        let location = locate_cursor_session_in(&ctx.home, TEST_ID, &cwd)
            .expect("locate valid Cursor fixture without meta id");

        assert_eq!(location.chat_dir, chat.canonicalize().unwrap());
        assert_eq!(location.schema_version, 1);
        assert!(location.prompt_history.is_some());
        assert!(location.store_db.is_file());
        assert_eq!(location.native_title.as_deref(), Some("Cursor title"));
    }

    #[test]
    fn cursor_locator_rejects_bucket_cwd_and_schema_mismatch() {
        let wrong_bucket = test_home();
        write_cursor_fixture(
            &wrong_bucket,
            "00000000000000000000000000000000",
            &cursor_meta(&wrong_bucket.workspace),
            None,
            true,
        );
        assert!(locate_cursor_session_in(
            &wrong_bucket.home,
            TEST_ID,
            &path_text(&wrong_bucket.workspace)
        )
        .is_err());

        let wrong_cwd = test_home();
        let bucket = cursor_bucket(&path_text(&wrong_cwd.workspace));
        write_cursor_fixture(
            &wrong_cwd,
            &bucket,
            &cursor_meta(&wrong_cwd.other_workspace),
            None,
            true,
        );
        assert!(locate_cursor_session_in(
            &wrong_cwd.home,
            TEST_ID,
            &path_text(&wrong_cwd.workspace)
        )
        .is_err());

        let schema = test_home();
        let bucket = cursor_bucket(&path_text(&schema.workspace));
        let mut meta = cursor_meta(&schema.workspace);
        meta["schemaVersion"] = json!(2);
        write_cursor_fixture(&schema, &bucket, &meta, None, true);
        assert!(
            locate_cursor_session_in(&schema.home, TEST_ID, &path_text(&schema.workspace)).is_err()
        );
    }

    #[test]
    fn cursor_locator_rejects_invalid_prompt_missing_store_and_duplicates() {
        let prompt = test_home();
        let bucket = cursor_bucket(&path_text(&prompt.workspace));
        write_cursor_fixture(
            &prompt,
            &bucket,
            &cursor_meta(&prompt.workspace),
            Some(&json!([1, "valid"])),
            true,
        );
        assert!(
            locate_cursor_session_in(&prompt.home, TEST_ID, &path_text(&prompt.workspace)).is_err()
        );

        let missing_store = test_home();
        let bucket = cursor_bucket(&path_text(&missing_store.workspace));
        write_cursor_fixture(
            &missing_store,
            &bucket,
            &cursor_meta(&missing_store.workspace),
            None,
            false,
        );
        assert!(locate_cursor_session_in(
            &missing_store.home,
            TEST_ID,
            &path_text(&missing_store.workspace)
        )
        .is_err());

        let duplicate = test_home();
        let bucket = cursor_bucket(&path_text(&duplicate.workspace));
        write_cursor_fixture(
            &duplicate,
            &bucket,
            &cursor_meta(&duplicate.workspace),
            None,
            true,
        );
        fs::create_dir_all(
            duplicate
                .home
                .join(".cursor")
                .join("chats")
                .join("11111111111111111111111111111111")
                .join(TEST_ID),
        )
        .unwrap();
        assert!(locate_cursor_session_in(
            &duplicate.home,
            TEST_ID,
            &path_text(&duplicate.workspace)
        )
        .is_err());
    }

    #[test]
    fn codex_session_index_uses_latest_name_for_each_id() {
        let input = concat!(
            r#"{"id":"session-a","thread_name":"old name","updated_at":"2026-07-09T10:00:00Z"}"#,
            "\n",
            "not json\n",
            r#"{"id":"session-b","thread_name":"another","updated_at":"2026-07-09T10:01:00Z"}"#,
            "\n",
            r#"{"id":"session-b","thread_name":"  ","updated_at":"2026-07-09T10:01:30Z"}"#,
            "\n",
            r#"{"id":"session-a","thread_name":"renamed","updated_at":"2026-07-09T10:02:00Z"}"#,
            "\n",
        );
        let titles = parse_codex_session_titles(Cursor::new(input));

        assert_eq!(titles.get("session-a").map(String::as_str), Some("renamed"));
        assert_eq!(titles.get("session-b").map(String::as_str), Some("another"));
    }

    #[test]
    fn codex_native_name_wins_and_fallback_remains_available() {
        let native = "renamed in codex".to_string();
        assert_eq!(codex_label(Some(&native), "first prompt".into()), native);
        assert_eq!(codex_label(None, "first prompt".into()), "first prompt");
        assert_eq!(codex_label(None, String::new()), "(无标题)");
    }

    #[test]
    fn list_codex_sessions_matches_cwd_via_same_path_not_string_eq() {
        let ctx = test_home();
        write_codex_rollout(&ctx, ["2026", "07", "13"], &ctx.workspace);

        // 正斜杠写法与 path_text 字符串可能不同，但 canonicalize 后应同一目录
        let slash_cwd = ctx.workspace.to_string_lossy().replace('\\', "/");
        let listed = list_codex_sessions_in(&ctx.home, &slash_cwd);
        assert_eq!(listed.len(), 1, "same_path 应把斜杠变体认作同一工作区");
        assert_eq!(listed[0].id, TEST_ID);
        assert_eq!(listed[0].label, "native title");

        let other = list_codex_sessions_in(&ctx.home, &path_text(&ctx.other_workspace));
        assert!(other.is_empty(), "其它工作区不得列入");
    }

    #[test]
    fn cursor_native_title_wins_and_fallback_remains_available() {
        assert_eq!(
            cursor_label(Some("原生标题"), Some("首条prompt".into())),
            "原生标题"
        );
        assert_eq!(cursor_label(None, Some("首条prompt".into())), "首条prompt");
        assert_eq!(
            cursor_label(Some("  "), Some("首条prompt".into())),
            "首条prompt"
        );
        assert_eq!(cursor_label(None, None), "(无标题)");
    }

    #[test]
    fn cursor_first_prompt_skips_empty_and_truncates() {
        let long_prompt = format!("/plan-create {}", "很长".repeat(50)); // 前缀13 + 100 CJK字符，确保超过80
        let arr = serde_json::json!(["", "  ", long_prompt]);
        let got = first_prompt_from_history(&arr).expect("应跳过前两个空白项，取到第三个非空候选");
        assert_eq!(got.chars().count(), 80);
        assert!(got.starts_with("/plan-create"));

        let empty = serde_json::json!([]);
        assert_eq!(first_prompt_from_history(&empty), None);

        let all_blank = serde_json::json!(["", "   "]);
        assert_eq!(first_prompt_from_history(&all_blank), None);
    }

    const KIMI_V1_ID: &str = "session_11111111-1111-4111-8111-111111111111";
    const KIMI_V2_ID: &str = "session_22222222-2222-4222-8222-222222222222";
    const KIMI_V2_ARCHIVED_ID: &str = "session_33333333-3333-4333-8333-333333333333";
    const KIMI_V2_OTHER_ID: &str = "session_44444444-4444-4444-8444-444444444444";
    /// 与现场 v2 实证同量级的 epoch 毫秒（≈2026-08-07）。
    const KIMI_V2_CREATED_MS: i64 = 1_786_107_797_534;
    const KIMI_V2_UPDATED_MS: i64 = 1_786_107_896_324;

    fn write_kimi_state(data_root: &Path, bucket: &str, session_id: &str, state: &Value) {
        let dir = data_root.join("sessions").join(bucket).join(session_id);
        fs::create_dir_all(&dir).expect("create kimi session dir");
        fs::write(
            dir.join("state.json"),
            serde_json::to_vec_pretty(state).expect("serialize kimi state"),
        )
        .expect("write kimi state.json");
    }

    #[test]
    fn list_kimi_sessions_reads_v1_workdir_and_v2_cwd_with_dual_timestamps() {
        let ctx = test_home();
        let cwd = path_text(&ctx.workspace).replace('\\', "/");
        let bucket = "wd_fixture_test";

        write_kimi_state(
            &ctx.home,
            bucket,
            KIMI_V1_ID,
            &json!({
                "createdAt": "2026-08-06T06:12:18.365Z",
                "updatedAt": "2026-08-06T14:30:35.119Z",
                "title": "v1-session",
                "workDir": cwd,
                "lastPrompt": "old"
            }),
        );
        write_kimi_state(
            &ctx.home,
            bucket,
            KIMI_V2_ID,
            &json!({
                "id": KIMI_V2_ID,
                "version": 2,
                "cwd": cwd,
                "createdAt": KIMI_V2_CREATED_MS,
                "updatedAt": KIMI_V2_UPDATED_MS,
                "archived": false,
                "title": "v2-session",
                "lastPrompt": "hello"
            }),
        );
        // 其它工作区 v2 —— 不得列入
        write_kimi_state(
            &ctx.home,
            bucket,
            KIMI_V2_OTHER_ID,
            &json!({
                "version": 2,
                "cwd": path_text(&ctx.other_workspace).replace('\\', "/"),
                "createdAt": KIMI_V2_CREATED_MS,
                "updatedAt": KIMI_V2_UPDATED_MS,
                "title": "other-ws",
            }),
        );
        // 已归档 —— 决策 A 跳过
        write_kimi_state(
            &ctx.home,
            bucket,
            KIMI_V2_ARCHIVED_ID,
            &json!({
                "version": 2,
                "cwd": cwd,
                "createdAt": KIMI_V2_CREATED_MS + 1,
                "updatedAt": KIMI_V2_UPDATED_MS + 1,
                "archived": true,
                "title": "archived",
            }),
        );

        let listed = list_kimi_sessions_in(&ctx.home, &cwd);
        assert_eq!(listed.len(), 2, "应同时列出 v1+v2，排除其它 cwd 与 archived");
        assert_eq!(listed[0].id, KIMI_V2_ID, "v2 updatedAt 更新 → 排前");
        assert_eq!(listed[0].label, "v2-session");
        assert_eq!(listed[0].ts, KIMI_V2_UPDATED_MS);
        assert_eq!(listed[1].id, KIMI_V1_ID);
        assert_eq!(listed[1].label, "v1-session");
        assert!(listed[1].ts > 0, "v1 RFC3339 应解析为非零 ms");

        let captured = scan_kimi_session_times_in(&ctx.home, &cwd, KIMI_V2_CREATED_MS);
        assert_eq!(
            captured.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec![KIMI_V2_ID],
            "capture 应按 epoch createdAt 命中 v2，且跳过 archived"
        );
    }

    #[test]
    fn list_kimi_sessions_skips_v2_without_path() {
        let ctx = test_home();
        let cwd = path_text(&ctx.workspace).replace('\\', "/");
        write_kimi_state(
            &ctx.home,
            "wd_empty",
            KIMI_V2_ID,
            &json!({
                "version": 2,
                "createdAt": KIMI_V2_CREATED_MS,
                "updatedAt": KIMI_V2_UPDATED_MS,
                "title": "no-cwd",
            }),
        );
        assert!(list_kimi_sessions_in(&ctx.home, &cwd).is_empty());
    }
}
