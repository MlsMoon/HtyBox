use std::path::Path;

/// 文件 / 会话监听共用的路径身份：斜杠归一、去掉 Windows `\\?\` 前缀、小写。
/// 前端 `filePathKey` 必须与此同契约。
pub fn watch_path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches("//?/")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::watch_path_key;
    use std::path::Path;

    #[test]
    fn file_watch_path_key_matches_case_slash_and_extended_prefix() {
        let a = watch_path_key(Path::new(r"G:\a\b.SVG"));
        let b = watch_path_key(Path::new("g:/a/b.svg"));
        let c = watch_path_key(Path::new(r"\\?\G:\a\b.svg"));
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_eq!(a, "g:/a/b.svg");
    }

    #[test]
    fn file_watch_path_key_ignores_sibling() {
        let a = watch_path_key(Path::new(r"G:\a\b.svg"));
        let sibling = watch_path_key(Path::new(r"G:\a\c.svg"));
        assert_ne!(a, sibling);
    }
}
