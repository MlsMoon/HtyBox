use std::path::Path;
use std::process::Command;

pub(crate) fn resolve_command_path(
    command: &str,
    path: &str,
    extensions: &[&str],
) -> Option<String> {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 {
        return command_path.is_file().then(|| command.to_string());
    }
    let candidates: Vec<String> = if command_path.extension().is_none() && !extensions.is_empty() {
        extensions
            .iter()
            .map(|extension| format!("{command}{extension}"))
            .chain(std::iter::once(command.to_string()))
            .collect()
    } else {
        vec![command.to_string()]
    };
    let directories: Vec<_> = std::env::split_paths(&std::ffi::OsString::from(path)).collect();
    for candidate in &candidates {
        for directory in &directories {
            let path = directory.join(candidate);
            if path.is_file() {
                return Some(path.to_string_lossy().into_owned());
            }
        }
    }
    None
}

pub(crate) fn shell_command(shell: &str, args: &[&str], script: &str) -> Command {
    let mut command = Command::new(shell);
    command.args(args).arg(script);
    command
}

pub(crate) fn resolve_unix_shell(requested: Option<&str>, fallback: &str) -> String {
    match requested.filter(|value| !value.trim().is_empty()) {
        None | Some("powershell.exe") | Some("powershell") | Some("cmd.exe") | Some("cmd") => {
            std::env::var("SHELL")
                .ok()
                .filter(|shell| !shell.trim().is_empty())
                .unwrap_or_else(|| fallback.to_string())
        }
        Some(shell) => shell.to_string(),
    }
}

pub(crate) fn agent_command(
    mut command: Command,
    executable: &str,
    args: &[&str],
    path: &str,
) -> Command {
    let mut line = executable.to_string();
    for arg in args {
        line.push(' ');
        line.push_str(arg);
    }
    command
        .arg(line)
        .env("PATH", path)
        .env("CI", "1")
        .env("npm_config_yes", "true")
        .env("npm_config_fund", "false")
        .env("npm_config_update_notifier", "false");
    command
}

pub(crate) fn fetch_command(url: &str) -> Command {
    let mut command = Command::new("curl");
    command.args(["-fsSL", "--max-time", "5", url]);
    command
}

pub(crate) fn unix_install_agent_command(agent: &str) -> Command {
    let script = match agent {
        "claude" => "curl -fsSL https://claude.ai/install.sh | bash",
        "codex" => "npm install -g @openai/codex",
        "cursor" => "curl -fsSL https://cursor.com/install | bash",
        "kimi" => "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
        _ => "false",
    };
    shell_command("sh", &["-lc"], script)
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_command_resolution_prefers_executable_shims() {
        let temp = tempfile::tempdir().expect("temp directory");
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        std::fs::create_dir_all(&first).expect("first path");
        std::fs::create_dir_all(&second).expect("second path");
        std::fs::write(first.join("agent"), b"shim").expect("extensionless shim");
        std::fs::write(second.join("agent.cmd"), b"cmd shim").expect("cmd shim");
        let path = std::env::join_paths([&first, &second])
            .expect("join test PATH")
            .to_string_lossy()
            .into_owned();

        assert_eq!(
            super::resolve_command_path("agent", &path, &[".exe", ".cmd", ".bat"]),
            Some(second.join("agent.cmd").to_string_lossy().into_owned())
        );
    }
}
