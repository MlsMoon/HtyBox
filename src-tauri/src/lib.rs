mod agent_accounts;
mod agent_env;
mod broker;
mod catalog;
mod fs_tree;
mod host_identity;
pub mod htyenv; // hty环境引擎:pub 供独立测试 harness/后续命令层消费(阶段构建期亦免 dead_code 噪声)
pub mod large_text; // plan-1:大文本分片读(pub 供独立验证 bin 调用)
mod memory_transfer;
mod portable_archive;
mod pty;
mod relay_client;
mod session_import;
mod session_transfer;
mod screenshot;
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
    large_docs: Arc<large_text::DocRegistry>, // plan-1：大文本分片读文档句柄注册表（LRU 兜底）
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

/// 设置「Agent」页：检测四家 agent CLI 安装状态（where.exe + --version + latest 对比）。
#[tauri::command]
async fn detect_agents() -> Result<Vec<agent_env::AgentInstallStatus>, String> {
    Ok(tauri::async_runtime::spawn_blocking(agent_env::detect_agents)
        .await
        .map_err(|error| format!("agent 安装检测任务失败：{error}"))?)
}

// ---------- Agent 配置：账号 / API Key 预设（cc-switch 式，第一期 kimi） ----------

/// 列出某 agent 的预设（掩码视图，不含明文密钥）+ 当前现场生效态。
#[tauri::command]
fn agent_accounts_list(agent: String) -> Result<agent_accounts::ListResult, String> {
    agent_accounts::list(&agent)
}

/// 新建 / 更新 API Key 预设（id 空 = 新建；更新时 apiKey 传空串 = 保持原 key）。
#[tauri::command]
fn agent_accounts_save_apikey(
    agent: String,
    id: Option<String>,
    name: String,
    api_key: String,
    base_url: Option<String>,
) -> Result<(), String> {
    agent_accounts::save_apikey(&agent, id, &name, &api_key, base_url)
}

#[tauri::command]
fn agent_accounts_rename(agent: String, id: String, name: String) -> Result<(), String> {
    agent_accounts::rename(&agent, &id, &name)
}

#[tauri::command]
fn agent_accounts_remove(agent: String, id: String) -> Result<(), String> {
    agent_accounts::remove(&agent, &id)
}

/// 一键切换（互斥：切 apikey 撤下 OAuth 凭证 / 切 oauth 清空 api_key；切走前自动重快照保鲜）。
#[tauri::command]
fn agent_accounts_apply(agent: String, id: String) -> Result<agent_accounts::ApplyResult, String> {
    agent_accounts::apply(&agent, &id)
}

/// 隔离登录（KIMI_CODE_HOME staging + kimi login device-code），返回轮询句柄。
#[tauri::command]
fn agent_accounts_login_start(agent: String, name: String) -> Result<String, String> {
    agent_accounts::login_start(&agent, &name)
}

#[tauri::command]
fn agent_accounts_login_poll(handle: String) -> Result<agent_accounts::LoginPoll, String> {
    agent_accounts::login_poll(&handle)
}

#[tauri::command]
fn agent_accounts_login_cancel(handle: String) -> Result<(), String> {
    agent_accounts::login_cancel(&handle)
}

/// 导出全部预设为 `.htybox-accounts` 包，返回最终文件路径。
#[tauri::command]
fn agent_accounts_export(destination: String) -> Result<String, String> {
    agent_accounts::export_package(&destination)
}

/// 导入 `.htybox-accounts` 包（快照替换 + 原子回滚），返回导入的预设数。
#[tauri::command]
fn agent_accounts_import(source: String) -> Result<usize, String> {
    agent_accounts::import_package(&source)
}


/// Channel → 同步进度回调(Mutex 包一层以满足 Send+Sync,供 spawn_blocking 内多线程 reader 调用)。
fn agent_progress_cb(
    on_progress: Channel<agent_env::ProgressEvent>,
) -> std::sync::Arc<dyn Fn(agent_env::ProgressEvent) + Send + Sync> {
    let ch = std::sync::Arc::new(Mutex::new(on_progress));
    std::sync::Arc::new(move |ev: agent_env::ProgressEvent| {
        if let Ok(guard) = ch.lock() {
            let _ = guard.send(ev);
        }
    })
}

/// 设置「Agent」页：对**单个** agent 跑官方 Windows 安装脚本（流式进度，300s 超时）。
#[tauri::command]
async fn install_agent(
    id: String,
    on_progress: Channel<agent_env::ProgressEvent>,
) -> Result<agent_env::InstallResult, String> {
    let progress = agent_progress_cb(on_progress);
    Ok(
        tauri::async_runtime::spawn_blocking(move || agent_env::install_agent(&id, Some(progress)))
            .await
            .map_err(|error| format!("agent 安装任务失败：{error}"))??,
    )
}

/// 设置「Agent」页：对**单个** agent 更新（原生命令或该行 install 脚本；不批量、不连带其它 agent）。
#[tauri::command]
async fn update_agent(
    id: String,
    on_progress: Channel<agent_env::ProgressEvent>,
) -> Result<agent_env::InstallResult, String> {
    let progress = agent_progress_cb(on_progress);
    Ok(
        tauri::async_runtime::spawn_blocking(move || agent_env::update_agent(&id, Some(progress)))
            .await
            .map_err(|error| format!("agent 更新任务失败：{error}"))??,
    )
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

/// PTY 直接子进程 pid（Windows 上多为 powershell；供 Claude 按进程树认领 session）。
#[tauri::command]
fn terminal_pty_pid(state: State<'_, AppState>, id: String) -> Option<u32> {
    state.terminal.pty_pid(&id)
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

/// plan-5:列工作区 canonical 权威记忆树(.htyworkflows/memory,「策展记忆」tab 数据源)。
#[tauri::command]
async fn list_canonical_memory_tree(
    project_dir: String,
) -> Result<Vec<catalog::MemoryNode>, String> {
    tauri::async_runtime::spawn_blocking(move || catalog::scan_canonical_memory_tree(&project_dir))
        .await
        .map_err(|error| format!("策展记忆树读取任务失败：{error}"))?
}

/// hty环境:识别工作区 .htyworkflows 状态(存在性/治理文件/名册三方对账),供仪表盘与就绪徽标。
#[tauri::command]
async fn htyenv_status(workspace: String) -> Result<htyenv::EnvStatus, String> {
    tauri::async_runtime::spawn_blocking(move || htyenv::detect(std::path::Path::new(&workspace)))
        .await
        .map_err(|error| format!("hty环境识别任务失败：{error}"))?
}

/// hty环境:只读对账(名册/skill 登记/薄壳三态/记忆四态/verify),全程零写入。
#[tauri::command]
async fn htyenv_check(workspace: String) -> Result<htyenv::report::SyncReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cache = catalog::resolve_claude_project(&workspace)?.memory_dir;
        htyenv::report::run(std::path::Path::new(&workspace), &cache, false)
    })
    .await
    .map_err(|error| format!("hty环境对账任务失败：{error}"))?
}

/// hty环境:机械同步(manifest 跟随刷新 + 薄壳全量重生成 + 记忆补齐),并落盘 last-sync-report.md。
#[tauri::command]
async fn htyenv_sync(workspace: String) -> Result<htyenv::report::SyncReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cache = catalog::resolve_claude_project(&workspace)?.memory_dir;
        let ws = std::path::Path::new(&workspace);
        let report = htyenv::report::run(ws, &cache, true)?;
        htyenv::report::write_last_report(ws, &report)?;
        Ok(report)
    })
    .await
    .map_err(|error| format!("hty环境同步任务失败：{error}"))?
}

/// hty环境:综合校验(verify 九组 + 孤儿薄壳 + path-audit)。
#[tauri::command]
async fn htyenv_verify(workspace: String) -> Result<htyenv::verify::VerifyReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cache = catalog::resolve_claude_project(&workspace)?.memory_dir;
        let ws = std::path::Path::new(&workspace);
        let manifest = htyenv::manifest::load(ws)?;
        htyenv::verify::verify(ws, &manifest, Some(&cache))
    })
    .await
    .map_err(|error| format!("hty环境校验任务失败：{error}"))?
}

/// hty环境:全局权威库状态(libraryDir 空 = 默认 config_dir/HtyBox/global-env,决策 1A 设置可配)。
#[tauri::command]
async fn htyenv_library_status(
    library_dir: Option<String>,
) -> Result<htyenv::library::LibraryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = htyenv::library::resolve_library_dir(library_dir.as_deref())?;
        Ok(htyenv::library::library_status(&dir))
    })
    .await
    .map_err(|error| format!("hty环境库状态任务失败：{error}"))?
}

/// hty环境:收编工程 canonical skill 进全局权威库(无冲突基线操作)。
#[tauri::command]
async fn htyenv_collect_skill(
    workspace: String,
    skill_id: String,
    library_dir: Option<String>,
) -> Result<htyenv::library::CollectOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = htyenv::library::resolve_library_dir(library_dir.as_deref())?;
        htyenv::library::collect_skill(std::path::Path::new(&workspace), &dir, &skill_id)
    })
    .await
    .map_err(|error| format!("hty环境收编任务失败：{error}"))?
}

/// hty环境:从全局权威库取件到工程(登记 + librarySha + 该 skill 薄壳)。
#[tauri::command]
async fn htyenv_fetch_skill(
    workspace: String,
    skill_id: String,
    library_dir: Option<String>,
) -> Result<htyenv::library::FetchOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = htyenv::library::resolve_library_dir(library_dir.as_deref())?;
        htyenv::library::fetch_skill(&dir, std::path::Path::new(&workspace), &skill_id)
    })
    .await
    .map_err(|error| format!("hty环境取件任务失败：{error}"))?
}

/// hty环境:初始化 dry-run(零写入,三分类清单)。
#[tauri::command]
async fn htyenv_init_preview(
    workspace: String,
    library_dir: Option<String>,
) -> Result<htyenv::init::InitPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = htyenv::library::resolve_library_dir(library_dir.as_deref())?;
        htyenv::init::init_preview(std::path::Path::new(&workspace), &dir)
    })
    .await
    .map_err(|error| format!("hty环境初始化预览任务失败：{error}"))?
}

/// hty环境:执行初始化(幂等只增不覆;native 薄引导入保护基线)。
#[tauri::command]
async fn htyenv_init_execute(
    workspace: String,
    library_dir: Option<String>,
) -> Result<htyenv::init::InitOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = htyenv::library::resolve_library_dir(library_dir.as_deref())?;
        htyenv::init::init_execute(std::path::Path::new(&workspace), &dir)
    })
    .await
    .map_err(|error| format!("hty环境初始化任务失败：{error}"))?
}

/// hty环境:已初始化工程的「环境补全」dry-run(缺目录/治理文件/库 skill)。
#[tauri::command]
async fn htyenv_complete_preview(
    workspace: String,
    library_dir: Option<String>,
) -> Result<htyenv::init::InitPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = htyenv::library::resolve_library_dir(library_dir.as_deref())?;
        htyenv::init::complete_preview(std::path::Path::new(&workspace), &dir)
    })
    .await
    .map_err(|error| format!("hty环境补全预览任务失败：{error}"))?
}

/// hty环境:执行环境补全(幂等只增不覆;刷新库种子并取件缺失 skill)。
#[tauri::command]
async fn htyenv_complete_execute(
    workspace: String,
    library_dir: Option<String>,
    confirm_diverged: Option<Vec<String>>,
) -> Result<htyenv::init::InitOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = htyenv::library::resolve_library_dir(library_dir.as_deref())?;
        let confirmed = confirm_diverged.unwrap_or_default();
        htyenv::init::complete_execute(std::path::Path::new(&workspace), &dir, &confirmed)
    })
    .await
    .map_err(|error| format!("hty环境补全任务失败：{error}"))?
}

/// hty环境:diverged 官方文件的注入裁决指令(导出官方内置版到 runtime/tmp + 生成语义合并文本,供注入 AI 终端)。
#[tauri::command]
async fn htyenv_managed_merge_brief(workspace: String, rels: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        htyenv::managed::merge_brief(std::path::Path::new(&workspace), &rels)
    })
    .await
    .map_err(|error| format!("hty环境裁决指令生成失败：{error}"))?
}

/// hty环境:标记已裁决(对给定 Managed 文件设基线=当前内置,不改内容 → 转 Reconciled 不再报 diverged)。
#[tauri::command]
async fn htyenv_managed_reconcile(workspace: String, rels: Vec<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        htyenv::managed::reconcile(std::path::Path::new(&workspace), &rels)
    })
    .await
    .map_err(|error| format!("hty环境标记已裁决失败：{error}"))?
}

/// hty环境:工作区 ↔ 全局权威库谱系五态对比(零写入;库漂移仅报告)。
#[tauri::command]
async fn htyenv_compare(
    workspace: String,
    library_dir: Option<String>,
) -> Result<htyenv::lineage::LineageReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = htyenv::library::resolve_library_dir(library_dir.as_deref())?;
        htyenv::lineage::compare(std::path::Path::new(&workspace), &dir)
    })
    .await
    .map_err(|error| format!("hty环境谱系对比任务失败：{error}"))?
}

/// hty环境:从库更新(fast-forward/基线对齐;adjudicated=裁决后以库为准)。逐项独立,一项失败不连坐。
#[tauri::command]
async fn htyenv_update_from_library(
    workspace: String,
    skill_ids: Vec<String>,
    adjudicated: bool,
    library_dir: Option<String>,
) -> Result<Vec<htyenv::lineage::SyncOpResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = htyenv::library::resolve_library_dir(library_dir.as_deref())?;
        htyenv::lineage::update_from_library(
            std::path::Path::new(&workspace),
            &dir,
            &skill_ids,
            adjudicated,
        )
    })
    .await
    .map_err(|error| format!("hty环境更新任务失败：{error}"))?
}

/// hty环境:回流到库(版本链追加/基线对齐;adjudicated=裁决后以工程为准)。逐项独立,一项失败不连坐。
#[tauri::command]
async fn htyenv_backflow_to_library(
    workspace: String,
    skill_ids: Vec<String>,
    adjudicated: bool,
    library_dir: Option<String>,
) -> Result<Vec<htyenv::lineage::SyncOpResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = htyenv::library::resolve_library_dir(library_dir.as_deref())?;
        htyenv::lineage::backflow_to_library(
            std::path::Path::new(&workspace),
            &dir,
            &skill_ids,
            adjudicated,
        )
    })
    .await
    .map_err(|error| format!("hty环境回流任务失败：{error}"))?
}

/// hty环境:生成冲突裁决指令文本(注入所选 agent 终端,plan-4 接线)。
#[tauri::command]
async fn htyenv_conflict_brief(
    workspace: String,
    skill_id: String,
    library_dir: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = htyenv::library::resolve_library_dir(library_dir.as_deref())?;
        htyenv::lineage::conflict_brief(std::path::Path::new(&workspace), &dir, &skill_id)
    })
    .await
    .map_err(|error| format!("hty环境裁决文本任务失败：{error}"))?
}

/// hty环境仪表盘:概览聚合(plans/bugs/技术债/memory 摘要 + 最近机械同步结果)。
#[tauri::command]
async fn htyenv_dashboard_data(
    workspace: String,
    recent: Option<usize>,
) -> Result<htyenv::dashboard::DashboardData, String> {
    tauri::async_runtime::spawn_blocking(move || {
        htyenv::dashboard::dashboard_data(std::path::Path::new(&workspace), recent.unwrap_or(5))
    })
    .await
    .map_err(|error| format!("hty环境概览聚合任务失败：{error}"))?
}

/// hty环境仪表盘:Plans 分类页分页查询(名称/状态过滤)。
#[tauri::command]
async fn htyenv_list_plans(
    workspace: String,
    offset: usize,
    limit: usize,
    query: Option<String>,
    status: Option<String>,
) -> Result<htyenv::dashboard::DocPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        htyenv::dashboard::list_docs(
            std::path::Path::new(&workspace),
            htyenv::dashboard::PLANS_DIR,
            true,
            offset,
            limit,
            query.as_deref(),
            status.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("hty环境 Plans 查询任务失败：{error}"))?
}

/// hty环境仪表盘:Bugs 分类页分页查询。
#[tauri::command]
async fn htyenv_list_bugs(
    workspace: String,
    offset: usize,
    limit: usize,
    query: Option<String>,
) -> Result<htyenv::dashboard::DocPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        htyenv::dashboard::list_docs(
            std::path::Path::new(&workspace),
            htyenv::dashboard::BUGS_DIR,
            false,
            offset,
            limit,
            query.as_deref(),
            None,
        )
    })
    .await
    .map_err(|error| format!("hty环境 Bugs 查询任务失败：{error}"))?
}

/// hty环境仪表盘:技术债分类页分页查询。
#[tauri::command]
async fn htyenv_list_debts(
    workspace: String,
    offset: usize,
    limit: usize,
    query: Option<String>,
) -> Result<htyenv::dashboard::DocPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        htyenv::dashboard::list_docs(
            std::path::Path::new(&workspace),
            htyenv::dashboard::DEBTS_DIR,
            false,
            offset,
            limit,
            query.as_deref(),
            None,
        )
    })
    .await
    .map_err(|error| format!("hty环境技术债查询任务失败：{error}"))?
}

/// hty环境仪表盘:Skills 常态清单(以 canonical 真版为扫描权威)。
#[tauri::command]
async fn htyenv_workspace_skills(
    workspace: String,
) -> Result<Vec<htyenv::dashboard::WorkspaceSkillInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        htyenv::dashboard::workspace_skills(std::path::Path::new(&workspace))
    })
    .await
    .map_err(|error| format!("hty环境 Skills 清单任务失败：{error}"))?
}

/// hty环境:canonical skill 上下架(plan-5 决策 1A:manifest enabled + 薄壳增删)。
#[tauri::command]
async fn htyenv_set_skill_enabled(
    workspace: String,
    skill_id: String,
    enabled: bool,
) -> Result<htyenv::adapters::SyncOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        htyenv::adapters::set_skill_enabled(std::path::Path::new(&workspace), &skill_id, enabled)
    })
    .await
    .map_err(|error| format!("hty环境启停任务失败：{error}"))?
}

/// hty环境:canonical 模板应用(清单内启用、其余登记项停用)。返回 [outcome, warnings]。
#[tauri::command]
async fn htyenv_apply_enabled_set(
    workspace: String,
    enabled_ids: Vec<String>,
) -> Result<(htyenv::adapters::SyncOutcome, Vec<String>), String> {
    tauri::async_runtime::spawn_blocking(move || {
        htyenv::adapters::apply_enabled_set(std::path::Path::new(&workspace), &enabled_ids)
    })
    .await
    .map_err(|error| format!("hty环境模板应用任务失败：{error}"))?
}

/// hty环境:库 skill 清单(全局库管理视图)。
#[tauri::command]
async fn htyenv_library_skills(
    library_dir: Option<String>,
) -> Result<Vec<htyenv::library::LibrarySkillInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = htyenv::library::resolve_library_dir(library_dir.as_deref())?;
        htyenv::library::list_library_skills(&dir)
    })
    .await
    .map_err(|error| format!("hty环境库清单任务失败：{error}"))?
}

/// hty环境:从库删除 skill(登记+实体;确认交互在前端)。
#[tauri::command]
async fn htyenv_library_delete_skill(
    skill_id: String,
    library_dir: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = htyenv::library::resolve_library_dir(library_dir.as_deref())?;
        htyenv::library::delete_library_skill(&dir, &skill_id)
    })
    .await
    .map_err(|error| format!("hty环境库删除任务失败：{error}"))?
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
/// force_lossy / max_bytes / max_open_bytes 可选（invoke 侧 forceLossy / maxBytes / maxOpenBytes），
/// 缺省 = 不强制 / 编辑上限 10MB / 可打开上限 512MB（超编辑上限但可打开 → viewable=true 供分流）。
#[tauri::command]
fn read_text_file(
    path: String,
    force_lossy: Option<bool>,
    max_bytes: Option<u64>,
    max_open_bytes: Option<u64>,
) -> Result<fs_tree::ReadTextResult, String> {
    fs_tree::read_text_file(&path, force_lossy.unwrap_or(false), max_bytes, max_open_bytes)
}

/// plan-1：打开大文本文档（流式建行索引，不整读入内存）→ 句柄 + 元信息 + 首屏行。
/// 只服务只读虚拟预览；扫描耗时与体积线性（50MB 数百 ms 级），走 spawn_blocking 不占 IPC 线程。
#[tauri::command]
async fn open_text_document(
    state: State<'_, AppState>,
    path: String,
    force_lossy: Option<bool>,
    max_open_bytes: Option<u64>,
) -> Result<large_text::OpenResult, String> {
    let reg = state.large_docs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        large_text::open_doc(&reg, &path, force_lossy.unwrap_or(false), max_open_bytes)
    })
    .await
    .map_err(|error| format!("大文件打开任务失败：{error}"))?
}

/// plan-1：按行范围读取（虚拟滚动数据源）。句柄失效返回 "doc-invalid: " 前缀错误供前端识别重开。
#[tauri::command]
async fn read_text_lines(
    state: State<'_, AppState>,
    doc_id: u64,
    start_line: u64,
    count: u64,
) -> Result<large_text::ReadLinesResult, String> {
    let reg = state.large_docs.clone();
    tauri::async_runtime::spawn_blocking(move || reg.read_lines(doc_id, start_line, count))
        .await
        .map_err(|error| format!("大文件取行任务失败：{error}"))?
}

/// plan-1：释放文档句柄（前端面板卸载时调用；漏调由 Rust 侧 LRU 上限兜底）。
#[tauri::command]
fn close_text_document(state: State<'_, AppState>, doc_id: u64) {
    state.large_docs.close(doc_id);
}

/// md 预览里的相对链接解析用：判断某路径是否为已存在的文件（目录不算）。
/// 同一个链接可能相对"当前文件所在目录"也可能相对"工作区根"，前端按序探测取存在的那个。
#[tauri::command]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
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

/// 剪贴板图片存到 `<工作区>/.htybox/<subdir>/`，返回绝对路径（剪贴板无图返回 Err）。
/// `subdir` 缺省/`None`/`""` → `"tmp"`（终端/Flow）；书签传 `"bookmarks"`（无 48h 清理）。
/// 重活（PowerShell 读图 + PNG 落盘）走 spawn_blocking，避免同步命令堵死 UI。
#[tauri::command]
async fn save_clipboard_image(
    workspace_dir: String,
    subdir: Option<String>,
) -> Result<String, String> {
    let sub = subdir.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        fs_tree::save_clipboard_image(&workspace_dir, &sub)
    })
    .await
    .map_err(|error| format!("剪贴板图片落盘任务失败：{error}"))?
}

/// 设置「全局截图快捷键」开关：开=注册 Ctrl+Shift+A，关=注销（释放给飞书等）。
#[tauri::command]
fn set_screenshot_hotkey_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    match screenshot::set_hotkey_enabled(&app, enabled) {
        Ok(()) => Ok(()),
        Err(e) => {
            if enabled {
                let _ = app.emit("screenshot-hotkey-failed", ());
            }
            Err(e)
        }
    }
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

/// 列本工作区 kimi 会话（<KIMI_CODE_HOME|~/.kimi-code>/sessions 按 state.json 的 workDir|cwd）。
#[tauri::command]
fn list_kimi_sessions(cwd: String) -> Vec<sessions::SessionRef> {
    sessions::list_kimi_sessions(&cwd)
}

/// 删除 kimi 会话（删整个 session 目录入回收站 + session_index.jsonl 剔行）。
#[tauri::command]
fn delete_kimi_session(path: String) -> Result<(), String> {
    sessions::delete_kimi_session(&path)
}

/// 列本工作区 hermes 会话（HERMES_HOME/state.db 的 sessions 表按 cwd）。
#[tauri::command]
fn list_hermes_sessions(cwd: String) -> Vec<sessions::SessionRef> {
    sessions::list_hermes_sessions(&cwd)
}

/// 删除 hermes 会话（按 id 从 state.db 删 messages+sessions 行）。
#[tauri::command]
fn delete_hermes_session(id: String) -> Result<(), String> {
    sessions::delete_hermes_session(&id)
}

/// 运行后捕获 agent(claude/codex/cursor/kimi/hermes) 在 cwd 下、启动时刻之后新生成的会话 id（前端关联终端用）。
#[tauri::command]
fn capture_session_ids(agent: String, cwd: String, since_ms: i64) -> Vec<String> {
    sessions::capture_session_ids(&agent, &cwd, since_ms)
}

/// 按 PTY 精确认领 session：claude 走 sessions/<pid>.json；codex/cursor/kimi 走子树进程创建时间↔会话 createdAt。
#[tauri::command]
fn map_agent_sessions_by_pty(
    agent: String,
    cwd: String,
    since_ms: i64,
    pty_pids: Vec<u32>,
) -> Vec<sessions::PtySessionMap> {
    sessions::map_agent_sessions_by_pty(&agent, &cwd, since_ms, &pty_pids)
}

/// 兼容旧前端：等同 `map_agent_sessions_by_pty("claude", …)`。
#[tauri::command]
fn map_claude_sessions_by_pty(
    cwd: String,
    since_ms: i64,
    pty_pids: Vec<u32>,
) -> Vec<sessions::PtySessionMap> {
    sessions::map_claude_sessions_by_pty(&cwd, since_ms, &pty_pids)
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

/// 读 JSON 配置对象：文件不存在 → 空对象；**存在但解析失败 → 改名 `.bak` 后重建**。
///
/// 绝不把解析失败当空对象直接重建 —— 这些配置是**跨 agent 共享文件**，同一份 `.mcp.json`
/// 还有别的自动写入者（Unity 侧 EditorMcpKit 写 `hty-unity-mcp-kit`、Hephaestus BugFixDaemon
/// 写 `unity-editor`），用户也可能手写其它 server。静默重建会连带抹掉这些条目且无从恢复；
/// 改名保留原文件，至少可人工找回。
fn load_json_object_or_backup(path: &std::path::Path) -> serde_json::Value {
    let text = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return serde_json::json!({}), // 不存在 = 正常首次创建
    };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) if v.is_object() => v,
        _ => {
            let _ = std::fs::rename(path, path.with_extension("bak"));
            serde_json::json!({})
        }
    }
}

/// 原子落盘：先写同目录 `.tmp`，再 rename 覆盖目标（Windows 上 rename 覆盖是原子的）。
///
/// 直接 `fs::write` 会留下「文件已截断、内容只写了一半」的时间窗；这些配置被多方并发读写，
/// 他方恰在此刻读到就会判定损坏并重建，从而丢掉全部条目。rename 保证读者要么看到旧版、
/// 要么看到新版，不存在中间态。
fn write_atomic(path: &std::path::Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 把 htybox 这个 MCP server **合并**进 `<cwd>/.mcp.json`（保留用户已有的 server，如 unity-mcp）。
/// 用 `${HTYBOX_MCP_TOKEN}` 占位，token 由每个终端进程的环境变量提供 → 一份配置可区分多 agent。
fn write_mcp_json(cwd: &str, url: &str) -> Result<(), String> {
    let path = std::path::Path::new(cwd).join(".mcp.json");
    let mut root = load_json_object_or_backup(&path);
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
    write_atomic(&path, &pretty)
}

/// 把 htybox 这个 MCP server **合并**进 `<cwd>/.codex/config.toml`（保留用户已有配置）。
/// codex 不读 .mcp.json，用 `[mcp_servers.htybox]` 的 url + bearer_token_env_var；token 走
/// `HTYBOX_MCP_TOKEN` 环境变量。仅在 codex 信任该项目时此文件才被加载。
fn write_codex_config(cwd: &str, url: &str) -> Result<(), String> {
    let dir = std::path::Path::new(cwd).join(".codex");
    let path = dir.join("config.toml");
    // 同 load_json_object_or_backup 的理由：解析失败改名 .bak 保留原文件，不静默重建
    let mut doc: toml_edit::DocumentMut = match std::fs::read_to_string(&path) {
        Ok(s) => match s.parse::<toml_edit::DocumentMut>() {
            Ok(d) => d,
            Err(_) => {
                let _ = std::fs::rename(&path, path.with_extension("bak"));
                toml_edit::DocumentMut::default()
            }
        },
        Err(_) => toml_edit::DocumentMut::default(),
    };

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
    write_atomic(&path, &doc.to_string())
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
    let mut root = load_json_object_or_backup(&path);
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
    write_atomic(&path, &pretty)
}

/// 把 htybox 这个 MCP server **合并**进 `<cwd>/.kimi-code/mcp.json`（保留用户已有配置）。
/// kimi 官方契约：项目级 `.kimi-code/mcp.json` 的 mcpServers；HTTP server 用 `url` +
/// `bearerTokenEnvVar`（kimi 原生字段，token 走 `HTYBOX_MCP_TOKEN` 环境变量，比 headers 占位符更干净）。
fn write_kimi_config(cwd: &str, url: &str) -> Result<(), String> {
    let dir = std::path::Path::new(cwd).join(".kimi-code");
    let path = dir.join("mcp.json");
    let mut root = load_json_object_or_backup(&path);
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
            "bearerTokenEnvVar": "HTYBOX_MCP_TOKEN"
        }),
    );
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    write_atomic(&path, &pretty)
}

/// 把 htybox 合并进 `%HERMES_HOME%/config.yaml` 的 `mcp_servers`（全局，非项目级）。
/// HTTP：`url` + `headers.Authorization: Bearer ${HTYBOX_MCP_TOKEN}`（Hermes 官方契约 + env 替换）。
/// 用字符串手术写入，避免 serde_yaml 整文件重写抹掉用户注释。
fn write_hermes_config(_cwd: &str, url: &str) -> Result<(), String> {
    let home = sessions::hermes_home().ok_or_else(|| "无 hermes 数据目录".to_string())?;
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let path = home.join("config.yaml");
    let mut text = std::fs::read_to_string(&path).unwrap_or_default();
    let safe_url = url.replace('\\', "\\\\").replace('"', "\\\"");
    let entry = format!(
        "  htybox:\n    url: \"{safe_url}\"\n    headers:\n      Authorization: \"Bearer ${{HTYBOX_MCP_TOKEN}}\"\n"
    );
    if text.contains("\n  htybox:") || text.starts_with("  htybox:") {
        // 已有 htybox：只替换其 url 行（保留其余字段/注释布局）
        let mut out = String::with_capacity(text.len() + 32);
        let mut in_htybox = false;
        let mut replaced_url = false;
        for line in text.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("htybox:") && (line.starts_with("  htybox:") || line == "  htybox:")
            {
                in_htybox = true;
                out.push_str(line);
                out.push('\n');
                continue;
            }
            if in_htybox {
                if !line.is_empty()
                    && !line.starts_with(' ')
                    && !line.starts_with('\t')
                {
                    in_htybox = false;
                } else if trimmed.starts_with("url:") && !replaced_url {
                    out.push_str("    url: \"");
                    out.push_str(&safe_url);
                    out.push_str("\"\n");
                    replaced_url = true;
                    continue;
                } else if !line.starts_with("    ")
                    && !line.starts_with('\t')
                    && !line.is_empty()
                    && !trimmed.starts_with('#')
                {
                    // 同级其他 server key（两空格）
                    if line.starts_with("  ") && trimmed.contains(':') && !line.starts_with("    ") {
                        in_htybox = false;
                    }
                }
            }
            out.push_str(line);
            out.push('\n');
        }
        if !replaced_url {
            return Err("config.yaml 已有 htybox 但未找到 url 行".into());
        }
        text = out;
    } else if let Some(idx) = text.find("mcp_servers:") {
        let insert_at = text[idx..]
            .find('\n')
            .map(|i| idx + i + 1)
            .unwrap_or(text.len());
        text.insert_str(insert_at, &entry);
    } else {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str("\nmcp_servers:\n");
        text.push_str(&entry);
    }
    write_atomic(&path, &text)
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
    write_cursor_config(&cwd, &url)?; // cursor 读
    write_kimi_config(&cwd, &url)?; // kimi 读
    write_hermes_config(&cwd, &url) // hermes 读全局 config.yaml
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
            large_docs: Arc::new(large_text::DocRegistry::default()),
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
            // 全局框选截图：只挂插件+handler；是否 register 由前端设置同步（见 set_screenshot_hotkey_enabled）
            {
                use tauri_plugin_global_shortcut::ShortcutState;
                if let Err(e) = app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, _shortcut, event| {
                            if event.state == ShortcutState::Pressed {
                                screenshot::on_hotkey(app);
                            }
                        })
                        .build(),
                ) {
                    eprintln!("[screenshot] global-shortcut plugin init failed: {e}");
                    let _ = app.emit("screenshot-hotkey-failed", ());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            terminal_pty_pid,
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
            list_canonical_memory_tree,
            htyenv_status,
            htyenv_check,
            htyenv_sync,
            htyenv_verify,
            htyenv_library_status,
            htyenv_collect_skill,
            htyenv_fetch_skill,
            htyenv_init_preview,
            htyenv_init_execute,
            htyenv_complete_preview,
            htyenv_complete_execute,
            htyenv_managed_merge_brief,
            htyenv_managed_reconcile,
            htyenv_compare,
            htyenv_update_from_library,
            htyenv_backflow_to_library,
            htyenv_conflict_brief,
            htyenv_dashboard_data,
            htyenv_list_plans,
            htyenv_list_bugs,
            htyenv_list_debts,
            htyenv_workspace_skills,
            htyenv_set_skill_enabled,
            htyenv_apply_enabled_set,
            htyenv_library_skills,
            htyenv_library_delete_skill,
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
            open_text_document,
            read_text_lines,
            close_text_document,
            write_text_file,
            file_exists,
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
            set_screenshot_hotkey_enabled,
            watch_file,
            unwatch_file,
            list_all_files,
            count_workspace_files,
            list_claude_sessions,
            list_codex_sessions,
            list_cursor_sessions,
            list_kimi_sessions,
            list_hermes_sessions,
            delete_claude_session,
            delete_codex_session,
            delete_cursor_session,
            delete_kimi_session,
            delete_hermes_session,
            capture_session_ids,
            map_agent_sessions_by_pty,
            map_claude_sessions_by_pty,
            detect_agents,
            install_agent,
            update_agent,
            agent_accounts_list,
            agent_accounts_save_apikey,
            agent_accounts_rename,
            agent_accounts_remove,
            agent_accounts_apply,
            agent_accounts_login_start,
            agent_accounts_login_poll,
            agent_accounts_login_cancel,
            agent_accounts_export,
            agent_accounts_import,
            mcp_broker_url,
            setup_mcp_agent,
            write_agent_brief,
            broker_snapshot,
            agent_exited
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
