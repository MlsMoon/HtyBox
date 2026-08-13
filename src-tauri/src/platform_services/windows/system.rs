use std::process::{Child, Command};

pub(super) fn configure_background_command(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
}

pub(super) fn kill_process_tree(child: &mut Child) {
    use std::os::windows::process::CommandExt;
    let pid = child.id().to_string();
    let mut kill = Command::new("taskkill");
    kill.args(["/PID", &pid, "/T", "/F"])
        .creation_flags(0x0800_0000);
    let _ = kill.status();
    let _ = child.kill();
}

pub(super) fn reveal_path(path: &str) -> Result<(), String> {
    Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub(super) fn launch_screen_snip() -> bool {
    if Command::new("explorer")
        .arg("ms-screenclip:")
        .spawn()
        .is_ok()
    {
        return true;
    }
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    Command::new(
        std::path::PathBuf::from(root)
            .join("System32")
            .join("SnippingTool.exe"),
    )
    .arg("/clip")
    .spawn()
    .is_ok()
}
