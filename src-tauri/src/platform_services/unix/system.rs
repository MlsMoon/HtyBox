use std::process::{Child, Command};

pub(super) fn kill_process_tree(child: &mut Child) {
    let _ = child.kill();
}

pub(super) fn reveal_path(path: &str) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}
