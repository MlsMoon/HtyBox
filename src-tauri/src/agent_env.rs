//! Agent CLI 安装检测与一键安装(设置「Agent」页数据源)。
//!
//! 核心约束:HtyBox 进程 PATH 在应用启动时固定,而各 CLI 安装器写的是注册表 User PATH。
//! 因此检测(where.exe / --version)与 pty.rs spawn 一律使用 fresh_path() =
//! 进程 PATH + 注册表 User/Machine PATH 合并去重(保序、进程 PATH 优先),
//! 否则装完 CLI 必须重启应用才能检测到、新终端才能找到命令。

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
    /// best-effort 版本号(--version 首个非空行,3s 超时;拿不到不影响 installed 判定)。
    pub version: Option<String>,
    /// where.exe 解析出的首个路径(未安装为 None)。
    pub path: Option<String>,
}

/// 安装执行结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub ok: bool,
    /// stdout+stderr 合并尾部(≤4KB),失败/超时诊断用。
    pub output_tail: String,
}

struct AgentSpec {
    id: &'static str,
    command: &'static str,
    install_script: &'static str,
}

/// agent 表:检测命令名 + 官方 Windows 安装脚本(均为当前用户安装、免 admin、免 Node;出处随附)。
const AGENTS: &[AgentSpec] = &[
    // https://docs.anthropic.com/en/docs/claude-code/setup
    AgentSpec { id: "claude", command: "claude", install_script: "irm https://claude.ai/install.ps1 | iex" },
    // https://github.com/openai/codex (Quickstart)
    AgentSpec { id: "codex", command: "codex", install_script: "irm https://chatgpt.com/codex/install.ps1 | iex" },
    // https://cursor.com/docs/cli/installation
    AgentSpec { id: "cursor", command: "cursor-agent", install_script: "irm 'https://cursor.com/install?win32=true' | iex" },
    // https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html
    AgentSpec { id: "kimi", command: "kimi", install_script: "irm https://code.kimi.com/kimi-code/install.ps1 | iex" },
];

/// 一条命令的执行捕获:退出码(超时被杀为 None)+ 超时标记 + stdout/stderr 合并文本。
struct Capture {
    code: Option<i32>,
    timed_out: bool,
    text: String,
}

/// 排空一条子进程管道,内容追加进共享缓冲(直到 EOF/出错)。
fn spawn_reader<R: Read + Send + 'static>(mut p: R, buf: Arc<Mutex<String>>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match p.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut g) = buf.lock() {
                        g.push_str(&String::from_utf8_lossy(&chunk[..n]));
                    }
                }
            }
        }
    })
}

/// 跑一个外部命令并捕获输出;超时即杀(已捕获的部分输出保留)。
/// 管道由读取线程持续排空,防"子进程写满管道死锁"。
fn run_capture(mut cmd: Command, timeout: Duration) -> Result<Capture, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let buf = Arc::new(Mutex::new(String::new()));
    let mut readers = Vec::new();
    if let Some(pipe) = child.stdout.take() {
        readers.push(spawn_reader(pipe, Arc::clone(&buf)));
    }
    if let Some(pipe) = child.stderr.take() {
        readers.push(spawn_reader(pipe, Arc::clone(&buf)));
    }
    let start = Instant::now();
    let (code, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(st)) => break (st.code(), false),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    break (None, true);
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    for r in readers {
        let _ = r.join();
    }
    let text = buf.lock().map(|g| g.clone()).unwrap_or_default();
    Ok(Capture { code, timed_out, text })
}

/// 注册表 PATH 读取缓存:terminal spawn 是高频路径,而读注册表要 spawn 一次 powershell(~百毫秒级)。
/// 短 TTL 折中——连续开终端不重复付费;安装耗时远超 TTL,装完后的检测/spawn 必然拿到新值。
static REG_PATH_CACHE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);
const REG_PATH_TTL: Duration = Duration::from_secs(10);

/// 实时 PATH = 当前进程 PATH + 注册表 User/Machine PATH(合并去重、忽略大小写、进程 PATH 优先)。
/// 注册表读取失败时退回进程 PATH(检测/spawn 仍可用,只是看不到运行期新装的)。
pub fn fresh_path() -> String {
    let mut parts: Vec<String> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    for extra in registry_paths() {
        if !parts.iter().any(|p| p.eq_ignore_ascii_case(&extra)) {
            parts.push(extra);
        }
    }
    parts.join(";")
}

/// 读注册表 User + Machine PATH(spawn powershell 调 .NET API,免新增 winreg 依赖;
/// ExpandEnvironmentVariables 展开 %USERPROFILE% 等 REG_EXPAND_SZ 内嵌变量)。
fn registry_paths() -> Vec<String> {
    {
        let cache = REG_PATH_CACHE.lock().unwrap();
        if let Some((at, paths)) = &*cache {
            if at.elapsed() < REG_PATH_TTL {
                return paths.clone();
            }
        }
    }
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path','User')); \
         [Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path','Machine'))",
    ]);
    let paths = match run_capture(cmd, Duration::from_secs(10)) {
        Ok(cap) if !cap.timed_out && cap.code == Some(0) => cap
            .text
            .split([';', '\r', '\n'])
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect(),
        _ => Vec::new(),
    };
    *REG_PATH_CACHE.lock().unwrap() = Some((Instant::now(), paths.clone()));
    paths
}

/// 检测全部 agent(顺序跑,单条失败不影响其他)。
pub fn detect_agents() -> Vec<AgentInstallStatus> {
    let path = fresh_path();
    AGENTS.iter().map(|a| detect_one(a, &path)).collect()
}

fn detect_one(a: &AgentSpec, path: &str) -> AgentInstallStatus {
    let mut where_cmd = Command::new("where.exe");
    where_cmd.arg(a.command).env("PATH", path);
    let resolved = match run_capture(where_cmd, Duration::from_secs(10)) {
        Ok(cap) if !cap.timed_out && cap.code == Some(0) => cap
            .text
            .lines()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
            .map(|l| l.to_string()),
        _ => None,
    };
    match resolved {
        None => AgentInstallStatus { id: a.id.into(), installed: false, version: None, path: None },
        Some(p) => AgentInstallStatus {
            id: a.id.into(),
            installed: true,
            version: probe_version(a.command, path),
            path: Some(p),
        },
    }
}

/// best-effort 版本探测:`<command> --version` 首个非空行(3s 超时,失败返回 None)。
fn probe_version(command: &str, path: &str) -> Option<String> {
    let mut cmd = Command::new(command);
    cmd.arg("--version").env("PATH", path);
    match run_capture(cmd, Duration::from_secs(3)) {
        Ok(cap) if !cap.timed_out && cap.code == Some(0) => cap
            .text
            .lines()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
            .map(|l| l.to_string()),
        _ => None,
    }
}

/// 对指定 agent 跑官方安装脚本( powershell 后台执行,300s 超时)。
pub fn install_agent(id: &str) -> Result<InstallResult, String> {
    let spec = AGENTS
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("未知 agent: {id}"))?;
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", spec.install_script]);
    let cap = run_capture(cmd, Duration::from_secs(300))?;
    let tail = tail_chars(&cap.text, 4096);
    let (ok, output_tail) = if cap.timed_out {
        (false, format!("安装超时(300s),已终止。\n{tail}"))
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
