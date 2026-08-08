use std::process::{Child, Command};

pub(super) fn kill_process_tree(child: &mut Child) {
    let _ = child.kill();
}

pub(super) fn reveal_path(path: &str) -> Result<(), String> {
    Command::new("open")
        .args(["-R", path])
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub(super) fn launch_screen_snip() -> bool {
    Command::new("screencapture")
        .args(["-i", "-c"])
        .spawn()
        .is_ok()
}
