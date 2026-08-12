use std::process::Command;

use crate::platform_services::common::clipboard;

pub(super) fn write_text(text: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let script = "Add-Type -AssemblyName System.Windows.Forms; \
        [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false); \
        [System.Windows.Forms.Clipboard]::SetText([Console]::In.ReadToEnd())";
    let mut command = Command::new("powershell.exe");
    command
        .args(["-STA", "-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x0800_0000);
    clipboard::write_text_command(command, text)
}

pub(super) fn read_text() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let script = "Add-Type -AssemblyName System.Windows.Forms; \
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); \
        [Console]::Write([System.Windows.Forms.Clipboard]::GetText())";
    let mut command = Command::new("powershell.exe");
    command
        .args(["-STA", "-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x0800_0000);
    clipboard::read_text_command(command)
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
