use std::process::{Child, Command};

use super::PlatformCapabilities;

pub trait PlatformServices: Sync {
    fn capabilities(&self) -> PlatformCapabilities;
    fn primary_shortcut_uses_meta(&self) -> bool {
        self.capabilities().primary_shortcut_uses_meta
    }
    fn resolve_shell(&self, requested: Option<&str>) -> String;
    fn workspace_path(&self, workspace_dir: &str, components: &[String]) -> Result<String, String>;
    fn home_dir(&self) -> Option<String>;
    fn standard_path(&self) -> String;
    fn resolve_command_path(&self, command: &str, path: &str) -> Option<String>;
    fn agent_command(&self, command: &str, args: &[&str], path: &str) -> Command;
    fn install_agent_command(&self, agent: &str) -> Command;
    fn fetch_command(&self, url: &str) -> Command;
    fn configure_background_command(&self, command: &mut Command);
    fn kill_process_tree(&self, child: &mut Child);
    fn reveal_path(&self, path: &str) -> Result<(), String>;
    fn write_clipboard_text(&self, text: &str) -> Result<(), String>;
    fn read_clipboard_text(&self) -> Result<String, String>;
    fn save_clipboard_image(&self, workspace_dir: &str, subdir: &str) -> Result<String, String>;
    fn clipboard_marker(&self) -> Option<String>;
    fn clipboard_has_image(&self) -> bool;
    fn launch_screen_snip(&self) -> bool;
    /// 鼠标主键当前是否物理按下；`None` = 本平台无法查询（调用侧据此停用依赖它的能力）。
    fn primary_mouse_button_down(&self) -> Option<bool>;
    /// 向系统输入队列注入一次 Esc（按下 + 抬起）；返回是否注入成功。
    fn send_escape_key(&self) -> bool;
}
