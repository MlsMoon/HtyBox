//! M9：列出/删除 claude & codex & cursor 的工作区会话（"会话记录"按钮）。已按官方文档 + CLI --help 实证：
//! - claude：会话存 ~/.claude/projects/<slug>/<id>.jsonl；标题取自会话内最新 ai-title(claude 自动起的会话标题，与 /resume 选择器一致)，回退 history.jsonl 的 display；
//!   复原 `claude --resume <id>`(须在该 cwd 下跑)；无原生删除 → 删 <id>.jsonl 文件。
//! - codex：会话 ~/.codex/sessions/Y/M/D/rollout-*.jsonl，首行 session_meta.payload{id,cwd}；
//!   自动命名或 `/rename` 设置的原生名称取自 ~/.codex/session_index.jsonl，未命名时回退首条真实用户消息；
//!   复原 `codex resume <id>`；删除走删 rollout 文件。
//! - cursor：会话 ~/.cursor/chats/<hash>/<chatId>/meta.json（{schemaVersion,createdAtMs,updatedAtMs,hasConversation,title?,cwd}）；
//!   外层 hash 目录大概率是 cwd 哈希分桶，不逆向算法、直接扫全部子目录按 meta.json.cwd 过滤；
//!   标题优先取原生 title，未命名(hasConversation:false)的空壳会话跳过展示，其余回退 prompt_history.json 首条用户输入；
//!   复原 `cursor-agent --resume <chatId>`(flag 风格，与 claude 同构，已实测)；删除走删整个 chat 目录。
//! 删除统一移入回收站(trash，非交互、可恢复)。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;
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

/// claude：从 ~/.claude/history.jsonl 取本工作区(project==cwd)会话列表与时间；标题(label)取该会话 jsonl
/// 内最新一条 ai-title(claude 自动生成的会话标题，= /resume 选择器所示)，无则回退首条非斜杠提示。
pub fn list_claude_sessions(cwd: &str) -> Vec<SessionRef> {
    let Some(h) = home() else {
        return Vec::new();
    };
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
        if v.get("project").and_then(|p| p.as_str()) != Some(cwd) {
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
            map.get(&id).map(|(display, ts, _)| {
                let label = files
                    .get(&id)
                    .and_then(|p| read_ai_title(p))
                    .or_else(|| (!display.is_empty()).then(|| display.clone()))
                    .unwrap_or_else(|| "(无标题)".into());
                SessionRef {
                    label,
                    id: id.clone(),
                    ts: *ts,
                    path: String::new(),
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
                    m.entry(stem.to_string()).or_insert(fp);
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

/// codex 会话开头由 CLI 注入的系统消息（非用户真实输入）：以 < 开头的 XML 标签块 / # AGENTS.md 指令。
fn is_codex_injection(t: &str) -> bool {
    t.starts_with('<') || t.starts_with("# AGENTS.md")
}

/// codex：扫 ~/.codex/sessions 的 rollout，session_meta.payload.cwd==cwd 的列出；
/// 标题优先取 session_index.jsonl 的原生 thread_name，未命名时回退首条非环境用户消息。
pub fn list_codex_sessions(cwd: &str) -> Vec<SessionRef> {
    let Some(h) = home() else {
        return Vec::new();
    };
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
        if payload.and_then(|p| p.get("cwd")).and_then(|c| c.as_str()) != Some(cwd) {
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
    let p = Path::new(path);
    if !p.starts_with(h.join(".codex").join("sessions")) {
        return Err("路径不在 codex sessions 目录内".into());
    }
    if !p.is_file() {
        return Err("会话文件不存在".into());
    }
    trash::delete(p).map_err(|e| e.to_string())
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

/// cursor：递归扫 ~/.cursor/chats/<hash>/<chatId>/meta.json，cwd 字段匹配的列出；
/// 跳过 hasConversation:false 的空壳会话(决策8)；标题取 meta.json 的 title，缺失回退首条用户 prompt。
pub fn list_cursor_sessions(cwd: &str) -> Vec<SessionRef> {
    let Some(h) = home() else {
        return Vec::new();
    };
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
        if v.get("cwd").and_then(|c| c.as_str()).map(|c| same_path(c, cwd)) != Some(true) {
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
    let p = Path::new(path);
    if !p.starts_with(h.join(".cursor").join("chats")) {
        return Err("路径不在 cursor chats 目录内".into());
    }
    if !p.is_dir() {
        return Err("会话目录不存在".into());
    }
    trash::delete(p).map_err(|e| e.to_string())
}

// ---------------- 运行后捕获 agent 自生成的 session id ----------------

/// Windows 路径规范化比较：统一分隔符、去尾分隔符、忽略大小写。
fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    norm(a) == norm(b)
}

/// 捕获某 agent(claude/codex/cursor) 在 cwd 下、启动时刻(since_ms)之后新生成的会话 id（按时间升序）。
/// 三者都不便在新建时预分配 id，故新建发裸命令、启动后由此关联各自终端的真实 session id。
pub fn capture_session_ids(agent: &str, cwd: &str, since_ms: i64) -> Vec<String> {
    match agent {
        "claude" => capture_claude_ids(cwd, since_ms),
        "codex" => capture_codex_ids(cwd, since_ms),
        "cursor" => capture_cursor_ids(cwd, since_ms),
        _ => Vec::new(),
    }
}

/// claude：读 ~/.claude/sessions/<pid>.json（运行中会话状态，含 sessionId/cwd/startedAt/kind），
/// 取 cwd 匹配、startedAt>=since、interactive 的 sessionId，按 startedAt 升序。
fn capture_claude_ids(cwd: &str, since_ms: i64) -> Vec<String> {
    let Some(h) = home() else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(h.join(".claude").join("sessions")) else {
        return Vec::new();
    };
    let mut hits: Vec<(i64, String)> = Vec::new();
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
        if v.get("cwd").and_then(|c| c.as_str()).map(|c| same_path(c, cwd)) != Some(true) {
            continue;
        }
        let started = v.get("startedAt").and_then(|t| t.as_i64()).unwrap_or(0);
        if started < since_ms {
            continue;
        }
        if v.get("kind").and_then(|k| k.as_str()) != Some("interactive") {
            continue; // 排除 print/exec 等一次性会话
        }
        if let Some(id) = v.get("sessionId").and_then(|s| s.as_str()) {
            hits.push((started, id.to_string()));
        }
    }
    hits.sort_by_key(|(t, _)| *t);
    hits.into_iter().map(|(_, id)| id).collect()
}

/// codex：扫 ~/.codex/sessions rollout，取 session_meta.payload.cwd 匹配、文件 mtime>=since 的 id，按 mtime 升序。
fn capture_codex_ids(cwd: &str, since_ms: i64) -> Vec<String> {
    let Some(h) = home() else {
        return Vec::new();
    };
    let root = h.join(".codex").join("sessions");
    if !root.is_dir() {
        return Vec::new();
    }
    let mut hits: Vec<(i64, String)> = Vec::new();
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
        if let Some(id) = payload.and_then(|pl| pl.get("id")).and_then(|i| i.as_str()) {
            hits.push((mt, id.to_string()));
        }
    }
    hits.sort_by_key(|(t, _)| *t);
    hits.into_iter().map(|(_, id)| id).collect()
}

/// cursor：扫 ~/.cursor/chats 的 meta.json，取 cwd 匹配、createdAtMs>=since 的 chat-id，按 createdAtMs 升序。
/// 注意：这里不按 hasConversation 过滤——刚启动、还没来得及说第一句话的会话正是本函数要捕获的目标。
fn capture_cursor_ids(cwd: &str, since_ms: i64) -> Vec<String> {
    let Some(h) = home() else {
        return Vec::new();
    };
    let root = h.join(".cursor").join("chats");
    if !root.is_dir() {
        return Vec::new();
    }
    let mut hits: Vec<(i64, String)> = Vec::new();
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
        if v.get("cwd").and_then(|c| c.as_str()).map(|c| same_path(c, cwd)) != Some(true) {
            continue;
        }
        let Some(chat_dir) = p.parent() else {
            continue;
        };
        if let Some(id) = chat_dir.file_name().and_then(|n| n.to_str()) {
            hits.push((created, id.to_string()));
        }
    }
    hits.sort_by_key(|(t, _)| *t);
    hits.into_iter().map(|(_, id)| id).collect()
}

#[cfg(test)]
mod tests {
    use super::{codex_label, cursor_label, first_prompt_from_history, parse_codex_session_titles};
    use std::io::Cursor;

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
    fn cursor_native_title_wins_and_fallback_remains_available() {
        assert_eq!(cursor_label(Some("原生标题"), Some("首条prompt".into())), "原生标题");
        assert_eq!(cursor_label(None, Some("首条prompt".into())), "首条prompt");
        assert_eq!(cursor_label(Some("  "), Some("首条prompt".into())), "首条prompt");
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
}
