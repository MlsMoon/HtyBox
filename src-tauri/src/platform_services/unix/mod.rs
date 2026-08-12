mod clipboard;
mod command;
mod system;

use std::process::{Child, Command};

use super::base::{PlatformCapabilities, PlatformKind, PlatformServices};

pub struct UnixPlatformServices;

impl PlatformServices for UnixPlatformServices {
    fn capabilities(&self) -> PlatformCapabilities {
        PlatformCapabilities::new(PlatformKind::Unix, false)
    }
    fn resolve_shell(&self, requested: Option<&str>) -> String {
        command::resolve_shell(requested)
    }
    fn workspace_path(&self, workspace_dir: &str, components: &[String]) -> Result<String, String> {
        super::common::path::workspace_path(workspace_dir, components)
    }
    fn home_dir(&self) -> Option<String> {
        command::home_dir()
    }
    fn standard_path(&self) -> String {
        command::standard_path()
    }
    fn resolve_command_path(&self, executable: &str, path: &str) -> Option<String> {
        command::resolve_command_path(executable, path)
    }
    fn agent_command(&self, executable: &str, args: &[&str], path: &str) -> Command {
        command::agent_command(executable, args, path)
    }
    fn install_agent_command(&self, agent: &str) -> Command {
        command::install_agent_command(agent)
    }
    fn fetch_command(&self, url: &str) -> Command {
        super::common::command::fetch_command(url)
    }
    fn configure_background_command(&self, _command: &mut Command) {}
    fn kill_process_tree(&self, child: &mut Child) {
        system::kill_process_tree(child)
    }
    fn reveal_path(&self, path: &str) -> Result<(), String> {
        system::reveal_path(path)
    }
    fn write_clipboard_text(&self, text: &str) -> Result<(), String> {
        clipboard::write_text(text)
    }
    fn read_clipboard_text(&self) -> Result<String, String> {
        clipboard::read_text()
    }
    fn save_clipboard_image(&self, _workspace_dir: &str, _subdir: &str) -> Result<String, String> {
        Err("当前平台暂不支持剪贴板图片保存".into())
    }
    fn clipboard_marker(&self) -> Option<String> {
        None
    }
    fn clipboard_has_image(&self) -> bool {
        false
    }
    fn launch_screen_snip(&self) -> bool {
        false
    }
}
