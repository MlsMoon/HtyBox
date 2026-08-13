use std::process::Command;
use std::thread;
use std::time::Duration;

use crate::platform_services::common::clipboard;

const CF_UNICODETEXT: u32 = 13;
const GMEM_MOVEABLE: u32 = 0x0002;

#[link(name = "user32")]
extern "system" {
    fn OpenClipboard(hwnd: *mut std::ffi::c_void) -> i32;
    fn CloseClipboard() -> i32;
    fn EmptyClipboard() -> i32;
    fn SetClipboardData(format: u32, mem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn GetClipboardData(format: u32) -> *mut std::ffi::c_void;
}

#[link(name = "kernel32")]
extern "system" {
    fn GlobalAlloc(flags: u32, bytes: usize) -> *mut std::ffi::c_void;
    fn GlobalLock(mem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn GlobalUnlock(mem: *mut std::ffi::c_void) -> i32;
    fn GlobalSize(mem: *mut std::ffi::c_void) -> usize;
    fn GlobalFree(mem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

fn open_clipboard() -> bool {
    for _ in 0..20 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            return true;
        }
        thread::sleep(Duration::from_millis(5));
    }
    false
}

pub(super) fn write_text(text: &str) -> Result<(), String> {
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    let bytes = wide.len().saturating_mul(2);
    unsafe {
        let mem = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if mem.is_null() {
            return Err("分配剪贴板内存失败".into());
        }
        let ptr = GlobalLock(mem);
        if ptr.is_null() {
            GlobalFree(mem);
            return Err("锁定剪贴板内存失败".into());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr().cast::<u8>(), ptr.cast::<u8>(), bytes);
        GlobalUnlock(mem);
        if !open_clipboard() {
            GlobalFree(mem);
            return Err("无法打开系统剪贴板".into());
        }
        EmptyClipboard();
        if SetClipboardData(CF_UNICODETEXT, mem).is_null() {
            CloseClipboard();
            GlobalFree(mem);
            return Err("系统剪贴板拒绝写入文本".into());
        }
        CloseClipboard();
        Ok(())
    }
}

pub(super) fn read_text() -> Result<String, String> {
    unsafe {
        if !open_clipboard() {
            return Err("无法打开系统剪贴板".into());
        }
        let mem = GetClipboardData(CF_UNICODETEXT);
        if mem.is_null() {
            CloseClipboard();
            return Ok(String::new());
        }
        let ptr = GlobalLock(mem).cast::<u16>();
        if ptr.is_null() {
            CloseClipboard();
            return Err("锁定剪贴板内存失败".into());
        }
        let units = GlobalSize(mem) / 2;
        let mut len = 0usize;
        while len < units && *ptr.add(len) != 0 {
            len += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
        GlobalUnlock(mem);
        CloseClipboard();
        Ok(text)
    }
}

pub(super) fn save_image(workspace_dir: &str, subdir: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let (directory, path, cleanup) = clipboard::prepare_image_path(workspace_dir, subdir)?;
    let path_literal = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; \
         if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {{ exit 1 }}; \
         $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($null -eq $img) {{ exit 1 }}; \
         $img.Save('{path_literal}', [System.Drawing.Imaging.ImageFormat]::Png)"
    );
    let result = Command::new("powershell.exe")
        .args(["-STA", "-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|error| error.to_string())?;
    if !result.status.success() || !path.exists() {
        return Err("剪贴板中没有图片".into());
    }
    if cleanup {
        clipboard::cleanup_images(&directory, &path);
    }
    Ok(path.to_string_lossy().into_owned())
}

pub(super) fn marker() -> Option<String> {
    #[link(name = "user32")]
    extern "system" {
        fn GetClipboardSequenceNumber() -> u32;
    }
    Some(unsafe { GetClipboardSequenceNumber() }.to_string())
}

pub(super) fn has_image() -> bool {
    use std::os::windows::process::CommandExt;
    let script = "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { exit 0 } else { exit 1 }";
    Command::new("powershell.exe")
        .args(["-STA", "-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x0800_0000)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
