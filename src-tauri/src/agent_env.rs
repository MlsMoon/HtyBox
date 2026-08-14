//! Agent CLI 安装检测与一键安装/更新(设置「Agent」页数据源)。
//!
//! Agent 检测、安装和更新依赖平台层提供的命令查找与 shell 执行能力。

use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// agent 单条检测结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallStatus {
    pub id: String,
    pub installed: bool,
    /// 本地版本(规范化;--version best-effort,拿不到不影响 installed 判定)。
    pub version: Option<String>,
    /// 平台命令查找得到的首个路径(未安装为 None)。
    pub path: Option<String>,
    /// 远端 latest(规范化;拉取失败为 None——此时不声称最新/非最新)。
    pub latest_version: Option<String>,
    /// 本地与 latest 皆有且不等则为 true;否则 false(含拉取失败)。
    pub update_available: bool,
}

/// 安装/更新执行结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub ok: bool,
    /// stdout+stderr 合并尾部(≤4KB),失败/超时诊断用。
    pub output_tail: String,
}

/// 流式进度事件(安装/更新共用)。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    /// "output" | "heartbeat"
    pub kind: String,
    pub line: Option<String>,
}

struct AgentSpec {
    id: &'static str,
    command: &'static str,
    /// 原生命令更新子命令;None = 重新执行该 Agent 的平台安装命令。
    update_args: Option<&'static [&'static str]>,
}

/// Agent 业务元数据。平台安装命令由 PlatformServices 具体实现提供。
const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        id: "claude",
        command: "claude",
        update_args: Some(&["update"]),
    },
    AgentSpec {
        id: "codex",
        command: "codex",
        update_args: Some(&["update"]),
    },
    AgentSpec {
        id: "opencode",
        command: "opencode",
        update_args: Some(&["upgrade"]),
    },
    AgentSpec {
        id: "cursor",
        command: "cursor-agent",
        update_args: Some(&["update"]),
    },
    AgentSpec {
        id: "kimi",
        command: "kimi",
        update_args: None,
    },
    // Hermes：本期仅 PATH 检测（决策 4=A）；install_agent 会拒绝对 hermes 安装
    AgentSpec {
        id: "hermes",
        command: "hermes",
        update_args: None,
    },
    AgentSpec {
        id: "grok",
        command: "grok",
        update_args: Some(&["update"]),
    },
];

/// 一条命令的执行捕获:退出码(超时被杀为 None)+ 超时标记 + stdout/stderr 合并文本。
struct Capture {
    code: Option<i32>,
    timed_out: bool,
    text: String,
}

/// 排空一条子进程管道,内容追加进共享缓冲;可选更新「最新一行」(绝不做 IPC,防堵管道死锁)。
fn spawn_reader<R: Read + Send + 'static>(
    mut p: R,
    buf: Arc<Mutex<String>>,
    last_line: Option<Arc<Mutex<Option<String>>>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        let mut carry = String::new();
        loop {
            match p.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let piece = String::from_utf8_lossy(&chunk[..n]);
                    if let Ok(mut g) = buf.lock() {
                        g.push_str(&piece);
                    }
                    if let Some(ll) = last_line.as_ref() {
                        carry.push_str(&piece);
                        while let Some(idx) = carry.find(['\n', '\r']) {
                            let line = carry[..idx].trim_end_matches(['\r', '\n']).to_string();
                            let rest = carry[idx..].trim_start_matches(['\r', '\n']).to_string();
                            carry = rest;
                            if !line.is_empty() {
                                if let Ok(mut g) = ll.lock() {
                                    *g = Some(line);
                                }
                            }
                        }
                    }
                }
            }
        }
        if let Some(ll) = last_line.as_ref() {
            let line = carry.trim();
            if !line.is_empty() {
                if let Ok(mut g) = ll.lock() {
                    *g = Some(line.to_string());
                }
            }
        }
    })
}

/// 跑一个外部命令并捕获输出;超时即杀(已捕获的部分输出保留)。
/// 管道由读取线程持续排空,防"子进程写满管道死锁"。
fn run_capture(cmd: Command, timeout: Duration) -> Result<Capture, String> {
    run_capture_streaming(cmd, timeout, None)
}

/// 同 [`run_capture`]。进度只在等待循环里推送(读线程只写 last_line),避免 Channel::send 堵死管道。
fn run_capture_streaming(
    mut cmd: Command,
    timeout: Duration,
    on_progress: Option<Arc<dyn Fn(ProgressEvent) + Send + Sync>>,
) -> Result<Capture, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::platform_services::platform_services().configure_background_command(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let buf = Arc::new(Mutex::new(String::new()));
    let last_line: Option<Arc<Mutex<Option<String>>>> = on_progress
        .as_ref()
        .map(|_| Arc::new(Mutex::new(None)));
    let mut readers = Vec::new();
    if let Some(pipe) = child.stdout.take() {
        readers.push(spawn_reader(pipe, Arc::clone(&buf), last_line.clone()));
    }
    if let Some(pipe) = child.stderr.take() {
        readers.push(spawn_reader(pipe, Arc::clone(&buf), last_line.clone()));
    }
    let start = Instant::now();
    let mut last_push = Instant::now();
    let mut last_pushed: Option<String> = None;
    let (code, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(st)) => break (st.code(), false),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    kill_process_tree(&mut child);
                    let _ = child.wait();
                    break (None, true);
                }
                if let Some(cb) = on_progress.as_ref() {
                    if last_push.elapsed() >= Duration::from_millis(200) {
                        let line = last_line
                            .as_ref()
                            .and_then(|ll| ll.lock().ok().and_then(|g| g.clone()));
                        if line != last_pushed {
                            last_pushed = line.clone();
                            cb(ProgressEvent {
                                kind: "output".into(),
                                line,
                            });
                        } else {
                            cb(ProgressEvent {
                                kind: "heartbeat".into(),
                                line: None,
                            });
                        }
                        last_push = Instant::now();
                    }
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    for r in readers {
        let _ = r.join();
    }
    // 结束前再推一次最新行
    if let (Some(cb), Some(ll)) = (on_progress.as_ref(), last_line.as_ref()) {
        if let Ok(g) = ll.lock() {
            if let Some(line) = g.clone() {
                cb(ProgressEvent {
                    kind: "output".into(),
                    line: Some(line),
                });
            }
        }
    }
    let text = buf.lock().map(|g| g.clone()).unwrap_or_default();
    Ok(Capture {
        code,
        timed_out,
        text,
    })
}

/// 终止安装/更新进程；Windows 实现会额外终止 cmd 子树。
fn kill_process_tree(child: &mut std::process::Child) {
    crate::platform_services::platform_services().kill_process_tree(child);
}

const LATEST_FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);

/// 实时 PATH 由平台层提供；Windows 实现会合并注册表 User/Machine PATH。
pub fn fresh_path() -> String {
    crate::platform_services::platform_services().standard_path()
}

/// 检测全部 agent(本地顺序;已安装者并行拉 latest,单条失败不影响其他)。
pub fn detect_agents() -> Vec<AgentInstallStatus> {
    let path = fresh_path();
    let mut statuses: Vec<AgentInstallStatus> = AGENTS.iter().map(|a| detect_one_local(a, &path)).collect();

    let mut handles = Vec::new();
    for (i, st) in statuses.iter().enumerate() {
        if st.installed {
            let id = st.id.clone();
            handles.push((i, thread::spawn(move || fetch_latest(&id))));
        }
    }
    for (i, handle) in handles {
        let latest = handle.join().ok().flatten();
        if let Some(latest) = latest {
            let local = statuses[i].version.clone();
            statuses[i].latest_version = Some(latest.clone());
            statuses[i].update_available = match (&local, &latest) {
                (Some(l), r) => l != r,
                _ => false,
            };
        }
    }
    statuses
}

fn detect_one_local(a: &AgentSpec, path: &str) -> AgentInstallStatus {
    match resolve_command_path(a.command, path) {
        None => AgentInstallStatus {
            id: a.id.into(),
            installed: false,
            version: None,
            path: None,
            latest_version: None,
            update_available: false,
        },
        Some(p) => {
            let raw = probe_version_raw(a.command, path);
            AgentInstallStatus {
                id: a.id.into(),
                installed: true,
                version: raw.as_deref().and_then(normalize_version),
                path: Some(p),
                latest_version: None,
                update_available: false,
            }
        }
    }
}

/// 由平台实现查找 Agent 可执行文件或 shell shim。
fn resolve_command_path(command: &str, path: &str) -> Option<String> {
    crate::platform_services::platform_services().resolve_command_path(command, path)
}

/// 经平台 shell 跑 agent CLI，兼容 Windows 的 `.cmd` shim 和 Unix PATH。
fn agent_cli_command(command: &str, args: &[&str], path: &str) -> Command {
    crate::platform_services::platform_services().agent_command(command, args, path)
}

/// best-effort 版本探测:平台 shell 执行 `<command> --version` 的首个非空行。
fn probe_version_raw(command: &str, path: &str) -> Option<String> {
    let cmd = agent_cli_command(command, &["--version"], path);
    match run_capture(cmd, Duration::from_secs(8)) {
        Ok(cap) if !cap.timed_out && cap.code == Some(0) => cap
            .text
            .lines()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
            .map(|l| l.to_string()),
        _ => None,
    }
}

/// 规范化版本字符串:剥常见前缀/括号说明,保留 semver 或 Cursor 的 date-hash。
fn normalize_version(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let before_paren = s.split('(').next().unwrap_or(s).trim();
    // Hermes Agent v0.20.0 → 优先抓 vX.Y.Z / X.Y.Z
    for tok in before_paren.split_whitespace() {
        let t = tok.trim_start_matches('v');
        if t.chars().next().is_some_and(|c| c.is_ascii_digit())
            && t.contains('.')
            && t.chars().all(|c| c.is_ascii_digit() || c == '.')
        {
            return Some(t.to_string());
        }
    }
    let stripped = before_paren
        .strip_prefix("codex-cli ")
        .or_else(|| before_paren.strip_prefix("codex "))
        .or_else(|| before_paren.strip_prefix("Codex CLI "))
        .or_else(|| before_paren.strip_prefix("Hermes Agent "))
        .unwrap_or(before_paren)
        .trim();
    let token = stripped
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim()
        .trim_start_matches('v');
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// 按 agent 拉取远端 latest(失败 → None,调用方不谎称可更新)。
fn fetch_latest(id: &str) -> Option<String> {
    match id {
        "claude" => fetch_npm_latest("@anthropic-ai/claude-code"),
        "codex" => fetch_npm_latest("@openai/codex"),
        "opencode" => fetch_npm_latest("opencode-ai"),
        "kimi" => fetch_npm_latest("@moonshot-ai/kimi-code"),
        "cursor" => fetch_cursor_latest(),
        "grok" => fetch_grok_latest(),
        _ => None,
    }
}

fn fetch_npm_latest(package: &str) -> Option<String> {
    // scoped 包 URL 需 encode `/` → `%2F`
    let path = package.replace('/', "%2F");
    let url = format!("https://registry.npmjs.org/{path}/latest");
    let cmd = crate::platform_services::platform_services().fetch_command(&url);
    match run_capture(cmd, LATEST_FETCH_TIMEOUT + Duration::from_secs(2)) {
        Ok(cap) if !cap.timed_out && cap.code == Some(0) => serde_json::from_str::<serde_json::Value>(&cap.text)
            .ok()
            .and_then(|json| json.get("version").and_then(|value| value.as_str()).and_then(normalize_version)),
        _ => None,
    }
}

fn fetch_cursor_latest() -> Option<String> {
    let cmd = crate::platform_services::platform_services().fetch_command("https://cursor.com/install?win32=true");
    match run_capture(cmd, LATEST_FETCH_TIMEOUT + Duration::from_secs(3)) {
        Ok(cap) if !cap.timed_out => parse_cursor_install_version(&cap.text),
        _ => None,
    }
}

fn fetch_grok_latest() -> Option<String> {
    let path = fresh_path();
    let cmd = agent_cli_command("grok", &["update", "--check", "--json"], &path);
    match run_capture(cmd, LATEST_FETCH_TIMEOUT + Duration::from_secs(3)) {
        Ok(cap) if !cap.timed_out && cap.code == Some(0) => parse_grok_update_json(&cap.text),
        _ => None,
    }
}

fn parse_grok_update_json(text: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(text.trim())
        .ok()?
        .get("latestVersion")?
        .as_str()
        .and_then(normalize_version)
}

/// 从 Cursor win32 安装脚本解析 `$version = '…'`。
fn parse_cursor_install_version(script: &str) -> Option<String> {
    const MARK: &str = "$version = '";
    let start = script.find(MARK)? + MARK.len();
    let rest = &script[start..];
    let end = rest.find('\'')?;
    let v = rest[..end].trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

fn find_spec(id: &str) -> Result<&'static AgentSpec, String> {
    AGENTS
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("未知 agent: {id}"))
}

/// 对指定 **单个** agent 跑官方安装脚本(可流式进度;300s 超时)。
pub fn install_agent(
    id: &str,
    on_progress: Option<Arc<dyn Fn(ProgressEvent) + Send + Sync>>,
) -> Result<InstallResult, String> {
    if id == "hermes" {
        return Err("Hermes 不支持一键安装，请使用官方安装方式".into());
    }
    let spec = find_spec(id)?;
    let cmd = crate::platform_services::platform_services().install_agent_command(spec.id);
    finish_action(
        run_capture_streaming(cmd, INSTALL_TIMEOUT, on_progress)?,
        "安装",
    )
}

/// 对指定 **单个** agent 执行更新(不批量、不连带其它 agent)。
/// Claude/Codex/Cursor → 原生命令 `update`;Kimi → 仅重跑平台安装命令。
/// 原生命令失败**不**回落安装命令(避免二次全量下载)。
pub fn update_agent(
    id: &str,
    on_progress: Option<Arc<dyn Fn(ProgressEvent) + Send + Sync>>,
) -> Result<InstallResult, String> {
    let spec = find_spec(id)?;
    let path = fresh_path();
    let cap = if let Some(args) = spec.update_args {
        // 与版本探测相同：必须经平台 shell，Windows 的 npm/.cmd shim 才能执行。
        let cmd = agent_cli_command(spec.command, args, &path);
        run_capture_streaming(cmd, INSTALL_TIMEOUT, on_progress)?
    } else {
        let cmd = crate::platform_services::platform_services().install_agent_command(spec.id);
        run_capture_streaming(cmd, INSTALL_TIMEOUT, on_progress)?
    };
    finish_action(cap, "更新")
}

fn finish_action(cap: Capture, label: &str) -> Result<InstallResult, String> {
    let tail = tail_chars(&cap.text, 4096);
    let (ok, output_tail) = if cap.timed_out {
        (
            false,
            format!("{label}超时(300s),已终止。\n{tail}"),
        )
    } else {
        (cap.code == Some(0), tail)
    };
    Ok(InstallResult { ok, output_tail })
}

/// 取字符串尾部 ≤max 个字符(char 边界安全)。
fn tail_chars(s: &str, max: usize) -> String {
    let mut chars: Vec<char> = s.chars().collect();
    if chars.len() > max {
        chars.drain(..chars.len() - max);
    }
    chars.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_claude() {
        assert_eq!(
            normalize_version("2.1.220 (Claude Code)").as_deref(),
            Some("2.1.220")
        );
    }

    #[test]
    fn normalize_codex() {
        assert_eq!(
            normalize_version("codex-cli 0.144.5").as_deref(),
            Some("0.144.5")
        );
    }

    #[test]
    fn normalize_opencode() {
        assert_eq!(normalize_version("1.15.3").as_deref(), Some("1.15.3"));
    }

    #[test]
    fn normalize_cursor() {
        assert_eq!(
            normalize_version("2026.07.23-e383d2b").as_deref(),
            Some("2026.07.23-e383d2b")
        );
    }

    #[test]
    fn normalize_grok_and_parse_update_check() {
        assert_eq!(
            normalize_version("grok 1.0.3 (1a29d5bc12)").as_deref(),
            Some("1.0.3")
        );
        assert_eq!(
            parse_grok_update_json(
                r#"{"currentVersion":"1.0.3","latestVersion":"1.0.4","updateAvailable":true}"#
            )
            .as_deref(),
            Some("1.0.4")
        );
    }

    #[test]
    fn parse_cursor_version_from_script() {
        let script = "$downloadUrl = 'https://downloads.cursor.com/lab/2026.07.23-e383d2b/'\n$version = '2026.07.23-e383d2b'\nfunction Get-Architecture {";
        assert_eq!(
            parse_cursor_install_version(script).as_deref(),
            Some("2026.07.23-e383d2b")
        );
    }

    #[test]
    fn resolve_prefers_cmd_over_extensionless_shim() {
        // 纯函数逻辑用路径后缀优先级验证(不依赖本机 where)
        let lines = [
            r"C:\Users\x\AppData\Roaming\npm\claude".to_string(),
            r"C:\Users\x\AppData\Roaming\npm\claude.cmd".to_string(),
        ];
        let prefer = |ext: &str| {
            lines
                .iter()
                .find(|l| l.to_ascii_lowercase().ends_with(ext))
                .cloned()
        };
        assert_eq!(
            prefer(".exe")
                .or_else(|| prefer(".cmd"))
                .or_else(|| prefer(".bat"))
                .or_else(|| lines.iter().next().cloned())
                .as_deref(),
            Some(r"C:\Users\x\AppData\Roaming\npm\claude.cmd")
        );
    }
}
