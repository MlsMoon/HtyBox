mod broker;
mod catalog;
mod fs_tree;
mod host_identity;
mod memory_transfer;
mod portable_archive;
mod pty;
mod relay_client;
mod session_import;
mod session_transfer;
mod sessions;
mod terminal_core;
mod watcher;
mod ws_host;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use host_identity::HostIdentity;
use pty::SpawnOptions;
use terminal_core::TerminalCore;
use tauri::ipc::Channel;
use tauri::{Emitter, State};

struct AppState {
    terminal: Arc<TerminalCore>,
    broker: Arc<broker::Broker>,
    ws_port: u16, // L2：本机 WS Host 端口（前端/配对取用）
    identity: Arc<HostIdentity>, // L3：Host 身份（公钥即配对信任锚）
    lan_enabled: Arc<AtomicBool>, // L3：LAN(0.0.0.0) 开关（绑定在启动时按此决定，改动需重启）
    workspaces: Arc<Mutex<htybox_link::rpc::WorkspacesResult>>, // L5-4P：桌面前端发布的工作区（供远程镜像）
    relay_cfg: Arc<Mutex<RelayCfg>>, // L4：relay 反连配置（endpoint/use_tls/enabled）
    relay_online: Arc<AtomicBool>, // L4：relay 控制连在线状态（relay_client 维护，UI 轮询）
    relay_task: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>, // L4：反连任务句柄（改配置时 abort 重启）
}

/// L4：relay 反连运行配置（持久化在 host-config.json）。
#[derive(Clone, Default)]
struct RelayCfg {
    endpoint: Option<String>,
    use_tls: bool,
    enabled: bool,
}

/// L4：按当前 relay 配置 (重)启动反连任务——先 abort 旧任务；启用且有 endpoint 则起新任务。
fn restart_relay(
    relay_cfg: &Arc<Mutex<RelayCfg>>,
    relay_task: &Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    relay_online: &Arc<AtomicBool>,
    terminal: &Arc<TerminalCore>,
    identity: &Arc<HostIdentity>,
    workspaces: &Arc<Mutex<htybox_link::rpc::WorkspacesResult>>,
) {
    if let Some(h) = relay_task.lock().unwrap().take() {
        h.abort();
    }
    relay_online.store(false, Ordering::Relaxed);
    let cfg = relay_cfg.lock().unwrap().clone();
    if let (true, Some(endpoint)) = (cfg.enabled, cfg.endpoint) {
        let h = tauri::async_runtime::spawn(relay_client::run(
            endpoint,
            cfg.use_tls,
            terminal.clone(),
            identity.clone(),
            workspaces.clone(),
            relay_online.clone(),
        ));
        *relay_task.lock().unwrap() = Some(h);
    }
}

/// L5-4P：桌面前端把已打开工作区 + 当前激活发布给 Host，供远程客户端镜像。
#[tauri::command]
fn set_workspaces(
    state: State<'_, AppState>,
    workspaces: Vec<htybox_link::rpc::WorkspaceInfo>,
    active_id: Option<String>,
) {
    if let Ok(mut w) = state.workspaces.lock() {
        *w = htybox_link::rpc::WorkspacesResult { workspaces, active_id };
    }
}

/// L2：前端查询本机 WS Host 端口。
#[tauri::command]
fn ws_port(state: State<'_, AppState>) -> u16 {
    state.ws_port
}

/// L3：配对 offer（二维码 SVG + 链接）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingOffer {
    offer_url: String,
    qr_svg: String,
    server_id: String,
    port: u16,
    lan_endpoint: Option<String>, // "ip:port"（LAN 开启且可探测到时）
}

fn host_display_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "HtyBox Host".to_string())
}

/// 探测本机 LAN IPv4（连 UDP 不实发，取路由源地址）。
fn detect_lan_ip() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    s.local_addr().ok().map(|a| a.ip().to_string())
}

/// L3：生成配对 offer + 二维码（供设置「连接」页展示）。
#[tauri::command]
fn pairing_offer(state: State<'_, AppState>) -> Result<PairingOffer, String> {
    let lan = if state.lan_enabled.load(Ordering::Relaxed) {
        detect_lan_ip().map(|host| htybox_link::offer::LanEndpoint { host, port: state.ws_port })
    } else {
        None
    };
    let lan_endpoint = lan.as_ref().map(|l| format!("{}:{}", l.host, l.port));
    let relay = {
        let cfg = state.relay_cfg.lock().unwrap();
        if cfg.enabled {
            cfg.endpoint
                .clone()
                .map(|endpoint| htybox_link::offer::RelayEndpoint { endpoint, use_tls: cfg.use_tls })
        } else {
            None
        }
    };
    let offer = htybox_link::offer::ConnectionOffer {
        v: 1,
        server_id: state.identity.server_id().to_string(),
        host_name: host_display_name(),
        host_public_key_b64: state.identity.public_b64(),
        lan,
        relay,
    };
    let offer_url = htybox_link::offer::encode_offer_url(&offer).map_err(|e| e.to_string())?;
    let code = qrcode::QrCode::new(offer_url.as_bytes()).map_err(|e| e.to_string())?;
    let qr_svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .dark_color(qrcode::render::svg::Color("#2A211C"))
        .light_color(qrcode::render::svg::Color("#faf9f5"))
        .quiet_zone(true)
        .build();
    Ok(PairingOffer { offer_url, qr_svg, server_id: state.identity.server_id().to_string(), port: state.ws_port, lan_endpoint })
}

/// L3：读/写 LAN 开关（写后需重启 app 生效绑定）。
#[tauri::command]
fn lan_enabled(state: State<'_, AppState>) -> bool {
    state.lan_enabled.load(Ordering::Relaxed)
}
#[tauri::command]
fn set_lan_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    host_identity::save_lan_enabled(enabled)?;
    state.lan_enabled.store(enabled, Ordering::Relaxed);
    Ok(())
}

/// L4：relay 配置（持久化的 endpoint/use_tls/enabled + 实时 online）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayConfigDto {
    endpoint: Option<String>,
    use_tls: bool,
    enabled: bool,
    online: bool,
}

/// L4：读 relay 配置（设置「连接」页展示）。
#[tauri::command]
fn relay_config(state: State<'_, AppState>) -> RelayConfigDto {
    let cfg = state.relay_cfg.lock().unwrap().clone();
    RelayConfigDto {
        endpoint: cfg.endpoint,
        use_tls: cfg.use_tls,
        enabled: cfg.enabled,
        online: state.relay_online.load(Ordering::Relaxed),
    }
}

/// L4：设置 relay 配置（持久化 + 重启反连）。
#[tauri::command]
fn set_relay_config(
    state: State<'_, AppState>,
    endpoint: Option<String>,
    use_tls: bool,
    enabled: bool,
) -> Result<(), String> {
    let mut c = host_identity::load_host_config();
    c.relay_endpoint = endpoint.clone();
    c.relay_use_tls = use_tls;
    c.relay_enabled = enabled;
    host_identity::save_host_config(&c)?;
    *state.relay_cfg.lock().unwrap() = RelayCfg { endpoint, use_tls, enabled };
    restart_relay(
        &state.relay_cfg,
        &state.relay_task,
        &state.relay_online,
        &state.terminal,
        &state.identity,
        &state.workspaces,
    );
    Ok(())
}

/// L4：relay 控制连在线状态（UI 轮询）。
#[tauri::command]
fn relay_status(state: State<'_, AppState>) -> bool {
    state.relay_online.load(Ordering::Relaxed)
}

#[tauri::command]
fn create_terminal(
    state: State<'_, AppState>,
    id: String,
    opts: SpawnOptions,
    on_output: Channel<Vec<u8>>,
) -> Result<(), String> {
    state.terminal.create(id, opts, Some(on_output), None)
}

#[tauri::command]
fn write_terminal(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    state.terminal.write(&id, data.as_bytes())
}

#[tauri::command]
fn resize_terminal(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.terminal.resize(&id, cols, rows)
}

#[tauri::command]
fn close_terminal(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.terminal.close(&id)
}

#[tauri::command]
fn list_skills(project_dir: Option<String>) -> Vec<catalog::Skill> {
    catalog::scan_skills(project_dir.as_deref())
}

#[tauri::command]
fn list_project_skills(project_dir: String) -> Vec<catalog::Skill> {
    catalog::scan_project_skills(&project_dir)
}

#[tauri::command]
fn list_memories(slug: String) -> Vec<catalog::MemoryItem> {
    catalog::scan_memories(&slug)
}

/// M9：列某工作区记忆树（分级文件夹结构；隐藏 MEMORY.md/index_* 脚手架）。
#[tauri::command]
async fn list_memory_tree(project_dir: String) -> Result<Vec<catalog::MemoryNode>, String> {
    tauri::async_runtime::spawn_blocking(move || catalog::scan_memory_tree(&project_dir))
        .await
        .map_err(|error| format!("Memory 树读取任务失败：{error}"))?
}

#[tauri::command]
async fn export_session_archive(
    agent: String,
    id: String,
    cwd: String,
    source_path: Option<String>,
    destination: String,
) -> Result<session_transfer::SessionExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        session_transfer::export_session_archive(
            &agent,
            &id,
            &cwd,
            source_path.as_deref(),
            &destination,
        )
    })
    .await
    .map_err(|error| format!("Session 导出任务失败：{error}"))?
}

#[tauri::command]
async fn import_session_archive(
    archive_path: String,
    target_cwd: String,
    target_project_dir: String,
) -> Result<session_import::SessionImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        session_import::import_session_archive(&archive_path, &target_cwd, &target_project_dir)
    })
    .await
    .map_err(|error| format!("Session 导入任务失败：{error}"))?
}

#[tauri::command]
async fn export_memory_archive(
    project_dir: String,
    destination: String,
) -> Result<memory_transfer::MemoryExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        memory_transfer::export_memory_archive(&project_dir, &destination)
    })
    .await
    .map_err(|error| format!("Memory 导出任务失败：{error}"))?
}

#[tauri::command]
async fn inspect_memory_archive(
    project_dir: String,
    archive_path: String,
) -> Result<memory_transfer::MemoryImportPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        memory_transfer::inspect_memory_archive(&project_dir, &archive_path)
    })
    .await
    .map_err(|error| format!("Memory 导入预检任务失败：{error}"))?
}

#[tauri::command]
async fn import_memory_archive(
    app: tauri::AppHandle,
    project_dir: String,
    archive_path: String,
    expected_archive_sha256: String,
    expected_target_revision: String,
) -> Result<memory_transfer::MemoryImportResult, String> {
    let imported = tauri::async_runtime::spawn_blocking(move || {
        memory_transfer::import_memory_archive(
            &project_dir,
            &archive_path,
            &expected_archive_sha256,
            &expected_target_revision,
        )
    })
    .await
    .map_err(|error| format!("Memory 导入任务失败：{error}"))?;
    let mut imported = imported?;
    if let Err(error) = app.emit("memory-changed", ()) {
        imported.warnings.push(format!(
            "Memory 已成功导入，但刷新通知发送失败，请手动刷新：{error}"
        ));
    }
    Ok(imported)
}

#[tauri::command]
fn list_projects() -> Vec<catalog::ProjectRef> {
    catalog::list_projects()
}

/// M8：列工作区级 上架+下架 的全部 skill（带 enabled 标记）。
/// `skills_rel` 可选；空/缺省 = `.claude/skills`。
#[tauri::command]
fn list_managed_skills(
    project_dir: String,
    skills_rel: Option<String>,
) -> Result<Vec<catalog::ManagedSkill>, String> {
    let rel = skills_rel
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| catalog::DEFAULT_SKILLS_REL.to_string());
    catalog::scan_managed_skills(&project_dir, &rel)
}

/// 按候选顺序解析唯一激活 skill 根（目录存在则命中，否则回退首项）。
#[tauri::command]
fn resolve_active_skill_root(
    project_dir: String,
    candidates: Vec<String>,
) -> Result<catalog::ActiveSkillRoot, String> {
    catalog::resolve_active_skill_root(&project_dir, &candidates)
}

/// M8：上架/下架单个 skill（在活动 skills 根 ↔ 镜像 downtime/skills 间移动文件夹）。
#[tauri::command]
fn set_skill_enabled(
    project_dir: String,
    dir: String,
    enabled: bool,
    skills_rel: Option<String>,
) -> Result<(), String> {
    let rel = skills_rel
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| catalog::DEFAULT_SKILLS_REL.to_string());
    catalog::set_skill_enabled(&project_dir, &dir, enabled, &rel)
}

/// M8：应用模板（dirs 全上架、其余全下架）；返回单项失败的 warnings（整体不报错）。
#[tauri::command]
fn apply_skill_template(
    project_dir: String,
    dirs: Vec<String>,
    skills_rel: Option<String>,
) -> Result<Vec<String>, String> {
    let rel = skills_rel
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| catalog::DEFAULT_SKILLS_REL.to_string());
    Ok(catalog::apply_skill_template(&project_dir, &dirs, &rel))
}

/// M8：列某目录的直接子项（文件树懒加载，一层）。
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<fs_tree::DirEntry>, String> {
    fs_tree::list_dir(&path)
}

/// M9：读文本文件（目录 → Err；超上限/二进制 → editable=false；文本白名单/强制 → 有损打开）。
/// force_lossy / max_bytes 可选（invoke 侧 forceLossy / maxBytes），缺省 = 不强制 / 默认 10MB。
#[tauri::command]
fn read_text_file(
    path: String,
    force_lossy: Option<bool>,
    max_bytes: Option<u64>,
) -> Result<fs_tree::ReadTextResult, String> {
    fs_tree::read_text_file(&path, force_lossy.unwrap_or(false), max_bytes)
}

/// M9：保存文本文件。
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs_tree::write_text_file(&path, &content)
}

/// M9：读图片为 base64 data URL（图片预览；非图片/超大 → ok=false）。
#[tauri::command]
fn read_image_data_url(path: String) -> Result<fs_tree::ReadImageResult, String> {
    fs_tree::read_image_data_url(&path)
}

/// M9：新建文件/文件夹。
#[tauri::command]
fn create_entry(parent_dir: String, name: String, is_dir: bool) -> Result<String, String> {
    fs_tree::create_entry(&parent_dir, &name, is_dir)
}

/// M9：同目录改名。
#[tauri::command]
fn rename_entry(path: String, new_name: String) -> Result<String, String> {
    fs_tree::rename_entry(&path, &new_name)
}

/// M9：删除到回收站。
#[tauri::command]
fn delete_entry(path: String) -> Result<(), String> {
    fs_tree::delete_entry(&path)
}

/// M9：移动进目标目录。
#[tauri::command]
fn move_entry(src: String, dest_dir: String) -> Result<String, String> {
    fs_tree::move_entry(&src, &dest_dir)
}

/// M9：复制进目标目录。
#[tauri::command]
fn copy_entry(src: String, dest_dir: String) -> Result<String, String> {
    fs_tree::copy_entry(&src, &dest_dir)
}

/// M9：写 OS 拖入文件的字节到目标目录。
#[tauri::command]
fn import_dropped_file(dest_dir: String, name: String, bytes: Vec<u8>) -> Result<String, String> {
    fs_tree::import_dropped_file(&dest_dir, &name, bytes)
}

/// M9：为拖入的文件夹在目标目录建去重后的顶层目录，返回其绝对路径。
#[tauri::command]
fn import_make_dir(dest_dir: String, name: String) -> Result<String, String> {
    fs_tree::import_make_dir(&dest_dir, &name)
}

/// M9：把拖入文件夹里的一项（文件字节 / 空目录）按相对路径写到导入根之下。
#[tauri::command]
fn import_dropped_entry(
    base_dir: String,
    rel_path: String,
    is_dir: bool,
    bytes: Vec<u8>,
) -> Result<(), String> {
    fs_tree::import_dropped_entry(&base_dir, &rel_path, is_dir, bytes)
}

/// M9：在资源管理器中定位。
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    fs_tree::reveal_in_explorer(&path)
}

/// 剪贴板图片（截图等位图）存为 `<工作区>/.htybox/tmp/clip-<ts>.png`，返回绝对路径
/// （终端/工作流输入框粘图用；剪贴板无图返回 Err）。
#[tauri::command]
fn save_clipboard_image(workspace_dir: String) -> Result<String, String> {
    fs_tree::save_clipboard_image(&workspace_dir)
}

/// M9：编辑器打开文件时开始监听其外部变化（变化后 emit "file-changed"）。
#[tauri::command]
fn watch_file(path: String) -> Result<(), String> {
    watcher::watch_file(&path)
}

/// M9：编辑器关闭文件时停止监听。
#[tauri::command]
fn unwatch_file(path: String) -> Result<(), String> {
    watcher::unwatch_file(&path)
}

/// M9：递归列工作区文件（双击 Shift 全局搜索）；收集前 max_files 个并返回有效文件真实总数。
#[tauri::command]
fn list_all_files(
    root: String,
    skip_folders: Vec<String>,
    skip_exts: Vec<String>,
    max_files: usize,
) -> fs_tree::ListFilesResult {
    fs_tree::list_all_files(&root, skip_folders, skip_exts, max_files)
}

/// M9：统计当前工作区有效文件总数（设置面板显示，判断是否超出搜索索引上限）。
#[tauri::command]
fn count_workspace_files(
    root: String,
    skip_folders: Vec<String>,
    skip_exts: Vec<String>,
) -> usize {
    fs_tree::count_workspace_files(&root, skip_folders, skip_exts)
}

/// M9：列本工作区 claude 会话（取自 ~/.claude/history.jsonl，按 project==cwd）。
#[tauri::command]
fn list_claude_sessions(cwd: String) -> Vec<sessions::SessionRef> {
    sessions::list_claude_sessions(&cwd)
}

/// M9：列本工作区 codex 会话（~/.codex/sessions 按 session_meta.cwd）。
#[tauri::command]
fn list_codex_sessions(cwd: String) -> Vec<sessions::SessionRef> {
    sessions::list_codex_sessions(&cwd)
}

/// M9：删除 claude 会话（删 <id>.jsonl 入回收站）。
#[tauri::command]
fn delete_claude_session(id: String) -> Result<(), String> {
    sessions::delete_claude_session(&id)
}

/// M9：删除 codex 会话（删 rollout 文件入回收站）。
#[tauri::command]
fn delete_codex_session(path: String) -> Result<(), String> {
    sessions::delete_codex_session(&path)
}

/// 列本工作区 cursor 会话（~/.cursor/chats 按 meta.json.cwd）。
#[tauri::command]
fn list_cursor_sessions(cwd: String) -> Vec<sessions::SessionRef> {
    sessions::list_cursor_sessions(&cwd)
}

/// 删除 cursor 会话（删整个 chat 目录入回收站）。
#[tauri::command]
fn delete_cursor_session(path: String) -> Result<(), String> {
    sessions::delete_cursor_session(&path)
}

/// 运行后捕获 agent(claude/codex/cursor) 在 cwd 下、启动时刻之后新生成的会话 id（前端关联终端用）。
#[tauri::command]
fn capture_session_ids(agent: String, cwd: String, since_ms: i64) -> Vec<String> {
    sessions::capture_session_ids(&agent, &cwd, since_ms)
}

/// M7-A：返回本地 MCP broker 的端点 URL（agent 的 .mcp.json 指向它）。
#[tauri::command]
fn mcp_broker_url(state: State<'_, AppState>) -> String {
    format!("http://127.0.0.1:{}/mcp", state.broker.port())
}

/// M7-F：宿主 UI(运行面板/仪表盘)读取协作状态快照（花名册/任务/归属/黑板/工具流）。
#[tauri::command]
fn broker_snapshot(state: State<'_, AppState>) -> serde_json::Value {
    state.broker.snapshot()
}

/// M7-H：agent 终端退出(主动关/崩溃) → 按 token 从 broker 花名册注销该实例。
#[tauri::command]
fn agent_exited(state: State<'_, AppState>, token: String) {
    state.broker.unregister(&token);
}

/// 把 htybox 这个 MCP server **合并**进 `<cwd>/.mcp.json`（保留用户已有的 server，如 unity-mcp）。
/// 用 `${HTYBOX_MCP_TOKEN}` 占位，token 由每个终端进程的环境变量提供 → 一份配置可区分多 agent。
fn write_mcp_json(cwd: &str, url: &str) -> Result<(), String> {
    let path = std::path::Path::new(cwd).join(".mcp.json");
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    servers.as_object_mut().unwrap().insert(
        "htybox".to_string(),
        serde_json::json!({
            "type": "http",
            "url": url,
            "headers": { "Authorization": "Bearer ${HTYBOX_MCP_TOKEN}" }
        }),
    );
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())
}

/// 把 htybox 这个 MCP server **合并**进 `<cwd>/.codex/config.toml`（保留用户已有配置）。
/// codex 不读 .mcp.json，用 `[mcp_servers.htybox]` 的 url + bearer_token_env_var；token 走
/// `HTYBOX_MCP_TOKEN` 环境变量。仅在 codex 信任该项目时此文件才被加载。
fn write_codex_config(cwd: &str, url: &str) -> Result<(), String> {
    let dir = std::path::Path::new(cwd).join(".codex");
    let path = dir.join("config.toml");
    let mut doc: toml_edit::DocumentMut = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.parse::<toml_edit::DocumentMut>().ok())
        .unwrap_or_default();

    let root = doc.as_table_mut();
    if !root.contains_key("mcp_servers") {
        let mut servers = toml_edit::Table::new();
        servers.set_implicit(true); // 渲染成 [mcp_servers.htybox] 而非裸 [mcp_servers]
        root.insert("mcp_servers", toml_edit::Item::Table(servers));
    }
    let servers = root
        .get_mut("mcp_servers")
        .and_then(|i| i.as_table_mut())
        .ok_or_else(|| "mcp_servers 不是表".to_string())?;
    let mut htybox = toml_edit::Table::new();
    htybox.insert("url", toml_edit::value(url));
    htybox.insert("bearer_token_env_var", toml_edit::value("HTYBOX_MCP_TOKEN"));
    servers.insert("htybox", toml_edit::Item::Table(htybox));

    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(&path, doc.to_string()).map_err(|e| e.to_string())
}

/// 把 htybox 这个 MCP server **合并**进 `<cwd>/.cursor/mcp.json`（保留用户已有配置）。
/// `cursor-agent mcp --help` 确认走 `.cursor/mcp.json`；格式已对照本机真实 ~/.cursor/mcp.json
/// 现有条目(jetbrains/blueprint-editor 等)核实为 url + headers.Authorization，无 claude 那样的
/// "type" 字段。**假设未 100% 验证**：`${HTYBOX_MCP_TOKEN}` 这种占位符是否被 cursor-agent 展开
/// 尚未见到官方文档确认(本机已有的真实条目都是硬编码字面量 token，不是占位符写法)——按与 claude
/// 一致的约定实现，实际是否握手成功以 Step 6 验证阶段真实跑一次为准。
fn write_cursor_config(cwd: &str, url: &str) -> Result<(), String> {
    let dir = std::path::Path::new(cwd).join(".cursor");
    let path = dir.join("mcp.json");
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    servers.as_object_mut().unwrap().insert(
        "htybox".to_string(),
        serde_json::json!({
            "url": url,
            "headers": { "Authorization": "Bearer ${HTYBOX_MCP_TOKEN}" }
        }),
    );
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())
}

/// M7-A：注册一个 agent（token→身份）并把 htybox 合并进该 cwd 的 .mcp.json。
/// 之后前端用 `HTYBOX_MCP_TOKEN=<token>` 等环境变量起该 agent 的终端。
#[tauri::command]
fn setup_mcp_agent(
    state: State<'_, AppState>,
    cwd: String,
    token: String,
    agent_id: String,
    role: String,
    role_name: String,
    workspace: String,
) -> Result<(), String> {
    state.broker.register(
        token,
        broker::AgentInfo {
            agent_id,
            role,
            role_name,
            workspace,
        },
    );
    let url = format!("http://127.0.0.1:{}/mcp", state.broker.port());
    write_mcp_json(&cwd, &url)?; // claude 读
    write_codex_config(&cwd, &url)?; // codex 读（信任项目时）
    write_cursor_config(&cwd, &url) // cursor 读
}

/// M7-C：写某 agent 的协作简报到 `<cwd>/.htybox/brief-<agentId>.md`。
/// agent 启动时用位置 prompt 先读它，从而获知角色/职责/协作协议/总目标（应用级协议，非 skill）。
#[tauri::command]
fn write_agent_brief(cwd: String, agent_id: String, content: String) -> Result<(), String> {
    let safe: String = agent_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let dir = std::path::Path::new(&cwd).join(".htybox");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("brief-{safe}.md"));
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let broker = broker::start();
    let broker_for_setup = broker.clone();
    let terminal = Arc::new(TerminalCore::default());
    let terminal_for_setup = terminal.clone();
    let lan_on = host_identity::load_lan_enabled();
    let ws_listener = ws_host::bind(lan_on);
    let ws_listen_port = ws_listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let identity = Arc::new(HostIdentity::load_or_create());
    let identity_for_setup = identity.clone();
    let lan_enabled_state = Arc::new(AtomicBool::new(lan_on));
    let workspaces = Arc::new(Mutex::new(htybox_link::rpc::WorkspacesResult::default()));
    let workspaces_for_ws = workspaces.clone();
    // L4：relay 反连配置（从 host-config.json 读）+ 在线态 + 任务句柄；setup 中按启用状态起反连
    let host_cfg = host_identity::load_host_config();
    let relay_cfg = Arc::new(Mutex::new(RelayCfg {
        endpoint: host_cfg.relay_endpoint.clone(),
        use_tls: host_cfg.relay_use_tls,
        enabled: host_cfg.relay_enabled,
    }));
    let relay_online = Arc::new(AtomicBool::new(false));
    let relay_task: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    let relay_cfg_setup = relay_cfg.clone();
    let relay_online_setup = relay_online.clone();
    let relay_task_setup = relay_task.clone();
    let terminal_for_relay = terminal.clone();
    let identity_for_relay = identity.clone();
    let workspaces_for_relay = workspaces.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            terminal,
            broker,
            ws_port: ws_listen_port,
            identity,
            lan_enabled: lan_enabled_state,
            workspaces,
            relay_cfg,
            relay_online,
            relay_task,
        })
        .setup(move |app| {
            watcher::start(app.handle().clone());
            broker_for_setup.set_app(app.handle().clone()); // M7-B：broker 可发 "agent-wake" 事件
            terminal_for_setup.set_app(app.handle().clone()); // M7-H：子进程退出 emit "terminal-exit"
            // L2/L3：起本机 WS Host（跑在 Tauri 自带 tokio runtime 上），带 Host 身份做 E2E
            let core = terminal_for_setup.clone();
            tauri::async_runtime::spawn(async move { ws_host::serve(ws_listener, core, identity_for_setup, workspaces_for_ws).await });
            // L4：若已配置启用 relay，启动反连（控制 socket 退避重连）
            restart_relay(
                &relay_cfg_setup,
                &relay_task_setup,
                &relay_online_setup,
                &terminal_for_relay,
                &identity_for_relay,
                &workspaces_for_relay,
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            ws_port,
            pairing_offer,
            lan_enabled,
            set_lan_enabled,
            relay_config,
            set_relay_config,
            relay_status,
            set_workspaces,
            list_skills,
            list_project_skills,
            list_memories,
            list_memory_tree,
            export_session_archive,
            import_session_archive,
            export_memory_archive,
            inspect_memory_archive,
            import_memory_archive,
            list_projects,
            list_managed_skills,
            resolve_active_skill_root,
            set_skill_enabled,
            apply_skill_template,
            list_dir,
            read_text_file,
            write_text_file,
            read_image_data_url,
            create_entry,
            rename_entry,
            delete_entry,
            move_entry,
            copy_entry,
            import_dropped_file,
            import_make_dir,
            import_dropped_entry,
            reveal_in_explorer,
            save_clipboard_image,
            watch_file,
            unwatch_file,
            list_all_files,
            count_workspace_files,
            list_claude_sessions,
            list_codex_sessions,
            list_cursor_sessions,
            delete_claude_session,
            delete_codex_session,
            delete_cursor_session,
            capture_session_ids,
            mcp_broker_url,
            setup_mcp_agent,
            write_agent_brief,
            broker_snapshot,
            agent_exited
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
