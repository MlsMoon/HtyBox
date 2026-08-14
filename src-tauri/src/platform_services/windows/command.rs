use std::process::Command;

use crate::platform_services::common;

pub(super) fn resolve_shell(requested: Option<&str>) -> String {
    requested
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("powershell.exe")
        .to_string()
}

pub(super) fn resolve_command_path(executable: &str, path: &str) -> Option<String> {
    common::command::resolve_command_path(executable, path, &[".exe", ".cmd", ".bat"])
}

pub(super) fn agent_command(executable: &str, args: &[&str], path: &str) -> Command {
    let mut command = Command::new("cmd.exe");
    command.args(["/D", "/C"]);
    common::command::agent_command(command, executable, args, path)
}

pub(super) fn install_agent_command(agent: &str) -> Command {
    let script = match agent {
        "claude" => "irm https://claude.ai/install.ps1 | iex",
        "codex" => "irm https://chatgpt.com/codex/install.ps1 | iex",
        "opencode" => "if (Get-Command scoop -ErrorAction SilentlyContinue) { scoop install opencode } elseif (Get-Command choco -ErrorAction SilentlyContinue) { choco install opencode -y } elseif (Get-Command npm -ErrorAction SilentlyContinue) { npm install -g opencode-ai } else { Write-Error 'Installing OpenCode requires Scoop, Chocolatey, or Node.js/npm'; exit 1 }",
        "cursor" => "irm 'https://cursor.com/install?win32=true' | iex",
        "kimi" => "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
        "grok" => "irm https://x.ai/cli/install.ps1 | iex",
        _ => "exit 1",
    };
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    command
}

pub(super) fn fetch_command(url: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let url = url.replace('\'', "''");
    let script = format!(
        "$ProgressPreference='SilentlyContinue'; try {{ \
         (Invoke-WebRequest -Uri '{url}' -UseBasicParsing -TimeoutSec 5).Content \
         }} catch {{ exit 1 }}"
    );
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x0800_0000);
    command
}
