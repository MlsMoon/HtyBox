//! 全局框选截图：唤起系统 Screen Snipping，结果由系统写入剪贴板。
//! 成功判定靠剪贴板序号变化 + ContainsImage（unpackaged 无 ms-screenclip redirect）。
//! 热键是否注册由设置开关经 `set_hotkey_enabled` 控制（默认开；关则释放给飞书等）。

use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const POLL_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(250);
pub const HOTKEY: &str = "ctrl+shift+a";

static IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// 按设置开关注册 / 注销全局热键。幂等；注册失败返回 Err（由前端提示）。
pub fn set_hotkey_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let gs = app.global_shortcut();
    if enabled {
        if gs.is_registered(HOTKEY) {
            return Ok(());
        }
        gs.register(HOTKEY).map_err(|e| {
            eprintln!("[screenshot] Ctrl+Shift+A register failed: {e}");
            e.to_string()
        })?;
        eprintln!("[screenshot] Ctrl+Shift+A registered");
        Ok(())
    } else {
        if gs.is_registered(HOTKEY) {
            gs.unregister(HOTKEY).map_err(|e| {
                eprintln!("[screenshot] Ctrl+Shift+A unregister failed: {e}");
                e.to_string()
            })?;
            eprintln!("[screenshot] Ctrl+Shift+A unregistered");
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SnipOutcome {
    Copied,
    CancelledOrFailed,
}

/// 热键入口：防重入；触发瞬间采样主窗是否可 toast；后台线程跑框选会话。
pub fn on_hotkey(app: &AppHandle) {
    if IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let show_toast = main_window_should_toast(app);
    let app = app.clone();
    std::thread::spawn(move || {
        let outcome = run_snip_session();
        IN_PROGRESS.store(false, Ordering::SeqCst);
        if outcome == SnipOutcome::Copied && show_toast {
            let _ = app.emit("screenshot-copied", ());
        }
    });
}

fn main_window_should_toast(app: &AppHandle) -> bool {
    let Some(w) = app.get_webview_window("main") else {
        return false;
    };
    let visible = w.is_visible().unwrap_or(false);
    let minimized = w.is_minimized().unwrap_or(true);
    let focused = w.is_focused().unwrap_or(false);
    visible && !minimized && focused
}

fn run_snip_session() -> SnipOutcome {
    let before = clipboard_sequence().unwrap_or(0);
    if !launch_screen_snip() {
        eprintln!("[screenshot] failed to launch screen snip UI");
        return SnipOutcome::CancelledOrFailed;
    }
    let deadline = Instant::now() + POLL_TIMEOUT;
    while Instant::now() < deadline {
        std::thread::sleep(POLL_INTERVAL);
        let Some(seq) = clipboard_sequence() else {
            continue;
        };
        if seq != before && clipboard_has_image() {
            return SnipOutcome::Copied;
        }
    }
    SnipOutcome::CancelledOrFailed
}

/// 优先 `ms-screenclip:`（Win10 1903+ / 本机 19045 已冒烟）；失败再试 `SnippingTool.exe /clip`。
fn launch_screen_snip() -> bool {
    if launch_ms_screenclip() {
        return true;
    }
    launch_snipping_tool_clip()
}

fn launch_ms_screenclip() -> bool {
    // 勿加 CREATE_NO_WINDOW：需要系统框选 UI 可见。
    match std::process::Command::new("explorer.exe")
        .arg("ms-screenclip:")
        .spawn()
    {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[screenshot] explorer ms-screenclip: {e}");
            false
        }
    }
}

fn launch_snipping_tool_clip() -> bool {
    let sys = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    let exe = std::path::PathBuf::from(sys)
        .join("System32")
        .join("SnippingTool.exe");
    match std::process::Command::new(&exe).arg("/clip").spawn() {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[screenshot] SnippingTool /clip: {e}");
            false
        }
    }
}

fn clipboard_sequence() -> Option<u32> {
    // Win32 直接读序号（轮询热路径禁启 PowerShell）。
    #[link(name = "user32")]
    extern "system" {
        fn GetClipboardSequenceNumber() -> u32;
    }
    Some(unsafe { GetClipboardSequenceNumber() })
}

fn clipboard_has_image() -> bool {
    let ps = "Add-Type -AssemblyName System.Windows.Forms; \
        if ([System.Windows.Forms.Clipboard]::ContainsImage()) { exit 0 } else { exit 1 }";
    let out = std::process::Command::new("powershell.exe")
        .args(["-STA", "-NoProfile", "-NonInteractive", "-Command", ps])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    matches!(out, Ok(o) if o.status.success())
}
