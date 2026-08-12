use std::process::Command;

use crate::platform_services::common;

pub(super) fn resolve_shell(requested: Option<&str>) -> String {
    common::command::resolve_unix_shell(requested, "/bin/zsh")
}

pub(super) fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

pub(super) fn standard_path() -> String {
    common::path::standard_path(
        &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"],
        &[".local/bin", ".npm-global/bin"],
    )
}

pub(super) fn resolve_command_path(executable: &str, path: &str) -> Option<String> {
    common::command::resolve_command_path(executable, path, &[])
}

pub(super) fn agent_command(executable: &str, args: &[&str], path: &str) -> Command {
    let mut command = Command::new("sh");
    command.arg("-lc");
    common::command::agent_command(command, executable, args, path)
}

pub(super) fn install_agent_command(agent: &str) -> Command {
    common::command::unix_install_agent_command(agent)
}
