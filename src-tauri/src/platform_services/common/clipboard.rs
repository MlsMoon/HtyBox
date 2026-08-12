#[cfg(not(target_os = "macos"))]
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "macos"))]
use std::process::{Command, Stdio};

#[cfg(not(target_os = "macos"))]
pub(crate) fn write_text_command(mut command: Command, text: &str) -> Result<(), String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let write_result = child
        .stdin
        .take()
        .ok_or_else(|| "无法打开系统剪贴板输入管道".to_string())?
        .write_all(text.as_bytes())
        .map_err(|error| error.to_string());
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            "系统剪贴板写入失败".into()
        } else {
            detail
        })
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_text_command(mut command: Command) -> Result<String, String> {
    let output = command.output().map_err(|error| error.to_string())?;
    if output.status.success() {
        String::from_utf8(output.stdout).map_err(|error| error.to_string())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            "系统剪贴板读取失败".into()
        } else {
            detail
        })
    }
}

pub(crate) fn prepare_image_path(
    workspace_dir: &str,
    subdir: &str,
) -> Result<(PathBuf, PathBuf, bool), String> {
    let (folder, prefix, cleanup) = match subdir {
        "" | "tmp" => ("tmp", "clip", true),
        "bookmarks" => ("bookmarks", "bm", false),
        _ => return Err(format!("不支持的剪贴板图片子目录: {subdir}")),
    };
    let directory = Path::new(workspace_dir).join(".htybox").join(folder);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let path = directory.join(format!("{prefix}-{timestamp}.png"));
    Ok((directory, path, cleanup))
}

pub(crate) fn cleanup_images(directory: &Path, current: &Path) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if path == current {
            continue;
        }
        if let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) {
            if now
                .duration_since(modified)
                .map(|age| age.as_secs() > 48 * 3600)
                .unwrap_or(false)
            {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}
