use std::process::Command;

use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
use objc2_foundation::NSString;

use crate::platform_services::common::clipboard;

pub(super) fn write_text(text: &str) -> Result<(), String> {
    autoreleasepool(|_| {
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        let text = NSString::from_str(text);
        // AppKit exports this immutable type identifier for the lifetime of the process.
        let string_type = unsafe { NSPasteboardTypeString };
        pasteboard
            .setString_forType(&text, string_type)
            .then_some(())
            .ok_or_else(|| "系统剪贴板拒绝写入文本".to_string())
    })
}

pub(super) fn read_text() -> Result<String, String> {
    autoreleasepool(|_| {
        // AppKit exports this immutable type identifier for the lifetime of the process.
        let string_type = unsafe { NSPasteboardTypeString };
        Ok(NSPasteboard::generalPasteboard()
            .stringForType(string_type)
            .map(|text| text.to_string())
            .unwrap_or_default())
    })
}

pub(super) fn save_image(workspace_dir: &str, subdir: &str) -> Result<String, String> {
    let (directory, path, cleanup) = clipboard::prepare_image_path(workspace_dir, subdir)?;
    let path_literal = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let script = format!(
        "set imageData to the clipboard as «class PNGf»\n\
         set outputFile to open for access POSIX file \"{path_literal}\" with write permission\n\
         set eof outputFile to 0\n\
         write imageData to outputFile\n\
         close access outputFile"
    );
    let result = Command::new("osascript")
        .args(["-e", &script])
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
    autoreleasepool(|_| Some(NSPasteboard::generalPasteboard().changeCount().to_string()))
}

pub(super) fn has_image() -> bool {
    let output = Command::new("osascript")
        .args(["-e", "clipboard info"])
        .output();
    output
        .map(|output| {
            let text = String::from_utf8_lossy(&output.stdout);
            output.status.success()
                && ["PNGf", "TIFF", "JPEG"]
                    .iter()
                    .any(|kind| text.contains(kind))
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    struct ClipboardRestore(String);

    impl Drop for ClipboardRestore {
        fn drop(&mut self) {
            let _ = super::write_text(&self.0);
        }
    }

    #[test]
    #[ignore = "uses the macOS general pasteboard"]
    fn native_text_round_trip() {
        let original = super::read_text().expect("read original clipboard text");
        let _restore = ClipboardRestore(original);
        let expected = "HtyBox native clipboard integration test";
        super::write_text(expected).expect("write clipboard text");
        assert_eq!(super::read_text().expect("read clipboard text"), expected);
    }
}
