use std::process::Command;

use crate::platform_services::common::clipboard;

pub(super) fn write_text(text: &str) -> Result<(), String> {
    let mut xclip = Command::new("xclip");
    xclip.args(["-selection", "clipboard"]);
    let mut xsel = Command::new("xsel");
    xsel.args(["--clipboard", "--input"]);
    let mut errors = Vec::new();
    for command in [Command::new("wl-copy"), xclip, xsel] {
        match clipboard::write_text_command(command, text) {
            Ok(()) => return Ok(()),
            Err(error) => errors.push(error),
        }
    }
    Err(format!("系统剪贴板写入失败：{}", errors.join("；")))
}

pub(super) fn read_text() -> Result<String, String> {
    let mut wl_paste = Command::new("wl-paste");
    wl_paste.arg("--no-newline");
    let mut xclip = Command::new("xclip");
    xclip.args(["-selection", "clipboard", "-out"]);
    let mut xsel = Command::new("xsel");
    xsel.args(["--clipboard", "--output"]);
    let mut errors = Vec::new();
    for command in [wl_paste, xclip, xsel] {
        match clipboard::read_text_command(command) {
            Ok(text) => return Ok(text),
            Err(error) => errors.push(error),
        }
    }
    Err(format!("系统剪贴板读取失败：{}", errors.join("；")))
}
