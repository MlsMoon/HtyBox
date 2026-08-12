//! 全局框选截图：唤起系统 Screen Snipping，结果由系统写入剪贴板。
//! 成功判定靠平台剪贴板标记变化 + 图片格式检测。
//! 热键是否注册由设置开关经 `set_hotkey_enabled` 控制（默认开；关则释放给飞书等）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

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
    let services = crate::platform_services::platform_services();
    let before = services.clipboard_marker();
    if !services.launch_screen_snip() {
        eprintln!("[screenshot] failed to launch screen snip UI");
        return SnipOutcome::CancelledOrFailed;
    }
    let deadline = Instant::now() + POLL_TIMEOUT;
    while Instant::now() < deadline {
        std::thread::sleep(POLL_INTERVAL);
        let after = services.clipboard_marker();
        if after.is_some() && after != before && services.clipboard_has_image() {
            return SnipOutcome::Copied;
        }
    }
    SnipOutcome::CancelledOrFailed
}
