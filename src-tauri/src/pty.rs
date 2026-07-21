//! 低层 PTY 打开（M1 起）。
//! L2 重构：终端的多客户端广播/scrollback/revision 管理上移到 `terminal_core`，
//! 本模块只负责"开一个 PTY 子进程并交出读写/控制句柄"，由 `terminal_core` 接管读线程与广播。

use std::collections::HashMap;
use std::io::{Read, Write};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;

pub type TermId = String;

/// 前端创建终端时传入的参数（M1 最小集 + M7-A env 注入）。
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    /// 启动的 shell；缺省按平台选默认。
    pub shell: Option<String>,
    /// 工作目录；缺省用用户主目录。
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// per-terminal 环境变量（M7-A：注入 agent 身份 HTYBOX_MCP_TOKEN / HTYBOX_AGENT_ID 等）。
    pub env: Option<HashMap<String, String>>,
}

/// 打开 PTY 后交出的句柄集合（`reader` 由上层起读线程接管广播）。
pub struct PtyParts {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    pub reader: Box<dyn Read + Send>,
}

/// 起一个 PTY 子进程，返回读写/控制句柄（**不含读线程**——由 `terminal_core` 接管）。
pub fn open_pty(opts: SpawnOptions) -> Result<PtyParts, String> {
    let cols = if opts.cols == 0 { 80 } else { opts.cols };
    let rows = if opts.rows == 0 { 24 } else { opts.rows };

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty: {e}"))?;

    let shell = opts.shell.filter(|s| !s.is_empty()).unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell);
    match opts.cwd.filter(|c| !c.is_empty()) {
        Some(cwd) => cmd.cwd(cwd),
        None => {
            if let Some(home) = home_dir() {
                cmd.cwd(home);
            }
        }
    }
    let env = opts.env.unwrap_or_default();
    // PATH 实时化：HtyBox 进程 PATH 固定在启动时，运行期新装的 CLI（安装器写注册表 User PATH）
    // 在新终端里会找不到 → 合并注册表实时值（agent_env::fresh_path 带 10s 缓存，热路径无感）；
    // 前端显式给了 PATH（Windows 环境变量名忽略大小写）时不覆盖。
    let has_path = env.keys().any(|k| k.eq_ignore_ascii_case("PATH"));
    for (k, v) in env {
        cmd.env(k, v);
    }
    if !has_path {
        cmd.env("PATH", crate::agent_env::fresh_path());
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn `{shell}`: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    Ok(PtyParts { writer, master: pair.master, child, reader })
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string())
    }
}

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
}
