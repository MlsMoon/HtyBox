use std::path::{Path, PathBuf};

pub(crate) fn standard_path(extra: &[&str], home_suffixes: &[&str]) -> String {
    let mut parts: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    for candidate in extra {
        let path = PathBuf::from(candidate);
        if path.is_dir() && !parts.iter().any(|existing| existing == &path) {
            parts.push(path);
        }
    }
    if let Some(home) = backend_home_dir() {
        for suffix in home_suffixes {
            let path = PathBuf::from(&home).join(suffix);
            if path.is_dir() && !parts.iter().any(|existing| existing == &path) {
                parts.push(path);
            }
        }
    }
    std::env::join_paths(parts)
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

pub(crate) fn backend_home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .filter(|home| !home.trim().is_empty())
}

pub(crate) fn workspace_path(workspace_dir: &str, components: &[String]) -> Result<String, String> {
    let workspace = Path::new(workspace_dir);
    if !workspace.is_absolute() {
        return Err(format!("工作区路径必须是绝对路径：{workspace_dir}"));
    }
    let mut path = workspace.to_path_buf();
    for component in components {
        let mut parsed = Path::new(component).components();
        if !matches!(parsed.next(), Some(std::path::Component::Normal(_)))
            || parsed.next().is_some()
        {
            return Err(format!("工作区子路径必须是单个普通路径段：{component}"));
        }
        path.push(component);
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::workspace_path;

    #[test]
    fn workspace_path_joins_native_components() {
        let root = std::env::current_dir().expect("current directory");
        let resolved = workspace_path(
            root.to_str().expect("UTF-8 current directory"),
            &[".htybox".into(), "run-configs.json".into()],
        )
        .expect("resolve workspace path");
        assert_eq!(
            std::path::PathBuf::from(resolved),
            root.join(".htybox").join("run-configs.json")
        );
    }

    #[test]
    fn workspace_path_rejects_non_component_inputs() {
        let root = std::env::current_dir().expect("current directory");
        let root = root.to_str().expect("UTF-8 current directory");
        assert!(workspace_path(root, &["..".into()]).is_err());
        assert!(workspace_path(root, &["nested/path".into()]).is_err());
        assert!(workspace_path("relative", &["file".into()]).is_err());
    }
}
