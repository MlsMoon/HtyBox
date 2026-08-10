//! 本机 WS Host（L2）：把 `htybox-link` 协议暴露给客户端（仅 `127.0.0.1` 明文）。
//!
//! 跑在 Tauri 自带的 tokio runtime 上（`tauri::async_runtime::spawn`）。单条 WS 混合
//! JSON-RPC（文本帧）+ 二进制终端帧；终端数据来自共享的 `TerminalCore`（与本地前端同源）。
//! 配对 / E2E / LAN / relay 留后续阶段；本阶段安全边界 = 本机 + Host 头白名单。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::host_identity::HostIdentity;
use crate::pty::SpawnOptions;
use crate::terminal_core::TerminalCore;
use htybox_link::e2e::{public_from_b64, E2eeHello, E2eeReady, SalsaBox};
use htybox_link::frame::{open_frame, seal_frame, InnerKind};
use htybox_link::handshake::{Features, Hello, ServerInfo};
use htybox_link::rpc::{
    self, types, CreateTerminalParams, RenameTerminalParams, Response as RpcResponse, RestoreMode,
    SubscribeTerminalParams, SubscribeTerminalResult, TerminalInfo, TerminalListResult, TerminalRef,
    WorkspacesResult,
};
use htybox_link::terminal::{decode_frame, encode_resize, encode_revision_frame, Opcode, Resize};

static NEXT_TERM: AtomicU64 = AtomicU64::new(1);
fn new_term_id() -> String {
    format!("wsterm-{}", NEXT_TERM.fetch_add(1, Ordering::Relaxed))
}
fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "HtyBox Host".to_string())
}

/// 同步绑定端口（6767 起，占用 +1 探测）。`lan=true` 绑 `0.0.0.0`(覆盖本地+局域网)，否则仅 `127.0.0.1`。
pub fn bind(lan: bool) -> std::net::TcpListener {
    let host: &str = if lan { "0.0.0.0" } else { "127.0.0.1" };
    for port in 6767..6867u16 {
        if let Ok(l) = std::net::TcpListener::bind((host, port)) {
            return l;
        }
    }
    std::net::TcpListener::bind((host, 0)).expect("ws host bind")
}

/// axum 共享状态：终端核心 + Host 身份。
#[derive(Clone)]
struct WsState {
    core: Arc<TerminalCore>,
    identity: Arc<HostIdentity>,
    workspaces: Arc<Mutex<WorkspacesResult>>,
}

/// 在 tokio 上跑 axum WS server（消费 `bind()` 得到的 std listener）。
pub async fn serve(
    std_listener: std::net::TcpListener,
    core: Arc<TerminalCore>,
    identity: Arc<HostIdentity>,
    workspaces: Arc<Mutex<WorkspacesResult>>,
) {
    if std_listener.set_nonblocking(true).is_err() {
        return;
    }
    let listener = match tokio::net::TcpListener::from_std(std_listener) {
        Ok(l) => l,
        Err(_) => return,
    };
    let app = Router::new().route("/ws", any(ws_upgrade)).with_state(WsState { core, identity, workspaces });
    let _ = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await;
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(st): State<WsState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !host_allowed(&headers, &addr) {
        return (StatusCode::FORBIDDEN, "host not allowed").into_response();
    }
    let is_remote = !addr.ip().is_loopback();
    ws.on_upgrade(move |socket| handle_conn(socket, st.core, st.identity, st.workspaces, is_remote))
}

/// 本机连接：Host 头须 localhost（防浏览器 DNS rebinding）。远程(LAN)：放行——E2E + 公钥信任另行强制。
fn host_allowed(headers: &HeaderMap, addr: &SocketAddr) -> bool {
    if !addr.ip().is_loopback() {
        return true;
    }
    match headers.get(axum::http::header::HOST).and_then(|v| v.to_str().ok()) {
        None => true,
        Some(h) => {
            let host = h.rsplit_once(':').map(|(a, _)| a).unwrap_or(h);
            matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
        }
    }
}

/// 出站消息：按是否加密封装为 WS Text/Binary（明文）或密文信封。
enum Outbound {
    Json(String),
    Terminal(Vec<u8>),
}

/// transport 无关的规范化 WS 消息：axum 入站（LAN/本机）与 tokio-tungstenite 出站
/// （relay 数据 socket）共用核心 [`run_conn`]，各自适配器只做 `WsMsg` ↔ 具体帧的转换。
pub(crate) enum WsMsg {
    Text(String),
    Binary(Vec<u8>),
    Close,
}

/// 把一条出站业务消息按 cipher 封装为规范化 WS 帧（加密→密文二进制；明文→Text/Binary）。
fn outbound_to_wsmsg(cipher: &Option<Arc<SalsaBox>>, o: Outbound) -> WsMsg {
    match (cipher, o) {
        (Some(b), Outbound::Json(s)) => WsMsg::Binary(seal_frame(b, InnerKind::Json, s.as_bytes())),
        (Some(b), Outbound::Terminal(t)) => WsMsg::Binary(seal_frame(b, InnerKind::Terminal, &t)),
        (None, Outbound::Json(s)) => WsMsg::Text(s),
        (None, Outbound::Terminal(t)) => WsMsg::Binary(t),
    }
}

/// 校验 `e2ee_hello` 并用 Host 私钥协商加密盒；非 e2ee_hello/公钥无效返回 None。
fn try_make_box(identity: &HostIdentity, text: &str) -> Option<SalsaBox> {
    let hello: E2eeHello = serde_json::from_str(text).ok()?;
    if hello.kind != E2eeHello::TYPE {
        return None;
    }
    let client_pub = public_from_b64(&hello.key).ok()?;
    Some(identity.keypair().box_with(&client_pub))
}

/// 单连接状态（read loop 单线程持有；forwarder 任务只持 out 克隆，不碰这些 map）。
struct Conn {
    core: Arc<TerminalCore>,
    server_id: String, // 与配对 offer 一致（identity.server_id()），供 server_info（spec §3.2）
    workspaces: Arc<Mutex<WorkspacesResult>>, // L5-4P：桌面发布的工作区，host.workspaces.list 返回
    out: mpsc::UnboundedSender<Outbound>,
    cipher: Option<Arc<SalsaBox>>, // Some = E2E 加密通道（read loop 解，writer 封）
    next_slot: u8,
    slot_term: HashMap<u8, String>,
    forwarders: HashMap<u8, JoinHandle<()>>,
}

/// axum 入站连接适配器（LAN/本机）：把 axum `WebSocket` 桥接到 transport 无关核心 [`run_conn`]。
async fn handle_conn(
    socket: WebSocket,
    core: Arc<TerminalCore>,
    identity: Arc<HostIdentity>,
    workspaces: Arc<Mutex<WorkspacesResult>>,
    is_remote: bool,
) {
    let (mut sink, mut stream) = socket.split();
    let (in_tx, in_rx) = mpsc::unbounded_channel::<WsMsg>();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<WsMsg>();

    // reader：axum 帧 → 规范化 WsMsg
    let reader = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            let wm = match msg {
                Message::Text(t) => WsMsg::Text(t.to_string()),
                Message::Binary(b) => WsMsg::Binary(b.as_ref().to_vec()),
                Message::Close(_) => break,
                _ => continue,
            };
            if in_tx.send(wm).is_err() {
                return;
            }
        }
        let _ = in_tx.send(WsMsg::Close);
    });

    // writer：规范化 WsMsg → axum 帧
    let writer = tokio::spawn(async move {
        while let Some(wm) = out_rx.recv().await {
            let msg = match wm {
                WsMsg::Text(s) => Message::Text(s.into()),
                WsMsg::Binary(b) => Message::Binary(b.into()),
                WsMsg::Close => {
                    let _ = sink.send(Message::Close(None)).await;
                    break;
                }
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    run_conn(in_rx, out_tx, core, identity, workspaces, is_remote).await;
    reader.abort();
    writer.abort();
}

/// transport 无关的单连接核心：首帧 E2E 协商 → RPC/终端分发循环。
/// `inbound`/`outbound` 由各 transport 适配器桥接（axum 入站；relay 数据 socket = tokio-tungstenite 出站）。
pub(crate) async fn run_conn(
    mut inbound: mpsc::UnboundedReceiver<WsMsg>,
    outbound: mpsc::UnboundedSender<WsMsg>,
    core: Arc<TerminalCore>,
    identity: Arc<HostIdentity>,
    workspaces: Arc<Mutex<WorkspacesResult>>,
    is_remote: bool,
) {
    // ── E2E 协商（看首帧）：e2ee_hello→建盒+回 ready；远程无 E2E→拒；本机明文→首帧作业务 ──
    let mut cipher: Option<Arc<SalsaBox>> = None;
    let mut first_business: Option<WsMsg> = None;
    match inbound.recv().await {
        Some(WsMsg::Text(t)) => {
            if let Some(b) = try_make_box(&identity, &t) {
                let ready = serde_json::to_string(&E2eeReady::default()).unwrap_or_default();
                if outbound.send(WsMsg::Text(ready)).is_err() {
                    return;
                }
                cipher = Some(Arc::new(b));
            } else if is_remote {
                let _ = outbound.send(WsMsg::Close);
                return;
            } else {
                first_business = Some(WsMsg::Text(t));
            }
        }
        Some(other) => {
            if is_remote {
                let _ = outbound.send(WsMsg::Close);
                return;
            }
            first_business = Some(other);
        }
        None => return,
    }

    // ── 出站转换任务：Conn 的 Outbound → 规范化 WsMsg（按 cipher 封装）→ outbound ──
    let (conn_out_tx, mut conn_out_rx) = mpsc::unbounded_channel::<Outbound>();
    let cipher_w = cipher.clone();
    let outbound_w = outbound.clone();
    let converter = tokio::spawn(async move {
        while let Some(o) = conn_out_rx.recv().await {
            if outbound_w.send(outbound_to_wsmsg(&cipher_w, o)).is_err() {
                break;
            }
        }
    });

    let mut conn = Conn {
        core,
        server_id: identity.server_id().to_string(),
        workspaces,
        out: conn_out_tx,
        cipher,
        next_slot: 0,
        slot_term: HashMap::new(),
        forwarders: HashMap::new(),
    };
    if let Some(m) = first_business {
        conn.on_inbound(m);
    }
    while let Some(msg) = inbound.recv().await {
        if matches!(msg, WsMsg::Close) {
            break;
        }
        conn.on_inbound(msg);
    }
    for (_, h) in conn.forwarders.drain() {
        h.abort();
    }
    drop(conn); // 丢 conn_out_tx → 转换任务结束
    converter.abort();
}

impl Conn {
    fn send_json<T: Serialize>(&self, v: &T) {
        let _ = self.out.send(Outbound::Json(serde_json::to_string(v).unwrap_or_default()));
    }
    fn send_binary(&self, bytes: Vec<u8>) {
        let _ = self.out.send(Outbound::Terminal(bytes));
    }
    /// 入站分发：加密通道→`open_frame` 解后按 InnerKind 派发；明文→Text=JSON / Binary=终端帧。
    fn on_inbound(&mut self, msg: WsMsg) {
        match (&self.cipher, msg) {
            (Some(b), WsMsg::Binary(data)) => {
                if let Ok((kind, plain)) = open_frame(b, &data) {
                    match kind {
                        InnerKind::Json => {
                            if let Ok(s) = std::str::from_utf8(&plain) {
                                self.handle_text(s);
                            }
                        }
                        InnerKind::Terminal => self.handle_binary(&plain),
                    }
                }
            }
            (None, WsMsg::Text(t)) => self.handle_text(&t),
            (None, WsMsg::Binary(b)) => self.handle_binary(&b),
            _ => {}
        }
    }
    fn send_err(&self, req_id: &str, req_type: &str, error: &str, code: &str) {
        self.send_json(&rpc::RpcError {
            kind: "rpc_error".to_string(),
            request_id: if req_id.is_empty() { None } else { Some(req_id.to_string()) },
            request_type: req_type.to_string(),
            error: error.to_string(),
            code: code.to_string(),
        });
    }

    fn handle_text(&mut self, text: &str) {
        let v: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(_) => return,
        };
        let t = v.get("type").and_then(Value::as_str).unwrap_or("");
        let req_id = v.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();

        if t == Hello::TYPE {
            self.send_json(&ServerInfo::new(
                self.server_id.clone(),
                host_name(),
                env!("CARGO_PKG_VERSION"),
                Features { terminal_restore: true, pairing: false, relay: false },
            ));
            return;
        }

        match t {
            types::TERMINAL_CREATE_REQ => {
                let p: CreateTerminalParams = serde_json::from_value(v.clone()).unwrap_or_default();
                let id = new_term_id();
                let opts = SpawnOptions { shell: p.shell, cwd: p.cwd, cols: p.cols, rows: p.rows, env: p.env };
                match self.core.create(id.clone(), opts, None, p.workspace_id) {
                    Ok(()) => self.send_json(&RpcResponse::new(
                        types::TERMINAL_CREATE_RESP,
                        req_id,
                        rpc::CreateTerminalResult { terminal_id: id },
                    )),
                    Err(e) => self.send_err(&req_id, types::TERMINAL_CREATE_REQ, &e, "internal"),
                }
            }
            types::TERMINAL_LIST_REQ => {
                let terminals = self
                    .core
                    .list()
                    .into_iter()
                    .map(|(id, m)| TerminalInfo {
                        terminal_id: id,
                        title: m.title,
                        cwd: m.cwd,
                        cols: m.cols,
                        rows: m.rows,
                        workspace_id: m.workspace_id,
                    })
                    .collect();
                self.send_json(&RpcResponse::new(types::TERMINAL_LIST_RESP, req_id, TerminalListResult { terminals }));
            }
            types::TERMINAL_SUBSCRIBE_REQ => match serde_json::from_value::<SubscribeTerminalParams>(v.clone()) {
                Ok(p) => self.subscribe(&req_id, p),
                Err(_) => self.send_err(&req_id, types::TERMINAL_SUBSCRIBE_REQ, "bad subscribe params", "bad_request"),
            },
            types::TERMINAL_UNSUBSCRIBE_REQ => {
                if let Ok(p) = serde_json::from_value::<TerminalRef>(v.clone()) {
                    self.unsubscribe(&p.terminal_id);
                }
                self.send_json(&RpcResponse::new(types::TERMINAL_UNSUBSCRIBE_RESP, req_id, serde_json::json!({})));
            }
            types::TERMINAL_KILL_REQ => {
                if let Ok(p) = serde_json::from_value::<TerminalRef>(v.clone()) {
                    let _ = self.core.close(&p.terminal_id);
                }
                self.send_json(&RpcResponse::new(types::TERMINAL_KILL_RESP, req_id, serde_json::json!({})));
            }
            types::TERMINAL_RENAME_REQ => {
                if let Ok(p) = serde_json::from_value::<RenameTerminalParams>(v.clone()) {
                    let _ = self.core.rename(&p.terminal_id, p.title);
                }
                self.send_json(&RpcResponse::new(types::TERMINAL_RENAME_RESP, req_id, serde_json::json!({})));
            }
            types::HOST_WORKSPACES_LIST_REQ => {
                let result = self.workspaces.lock().map(|w| w.clone()).unwrap_or_default();
                self.send_json(&RpcResponse::new(types::HOST_WORKSPACES_LIST_RESP, req_id, result));
            }
            // L5-4P-2：只读 catalog（镜像桌面左侧 Content），复用桌面既有扫描逻辑。
            // 2026-07-12：桌面 Skill 面板已支持可配置根（settings.skillRoot）；本 RPC 仍走
            // scan_skills（固定 .claude + user/plugin），iOS 侧暂不跟随——见计划
            // configurable-skill-roots Step 5「桌面优先」。后续若双端对齐，需 Host 发布 skillRoot。
            types::CATALOG_SKILLS_LIST_REQ => {
                let dir = v.get("projectDir").and_then(Value::as_str).unwrap_or("");
                let skills = crate::catalog::scan_skills(if dir.is_empty() { None } else { Some(dir) });
                self.send_json(&RpcResponse::new(types::CATALOG_SKILLS_LIST_RESP, req_id, serde_json::json!({ "skills": skills })));
            }
            types::CATALOG_MEMORIES_LIST_REQ => {
                let slug = v.get("slug").and_then(Value::as_str).unwrap_or("");
                let memories = crate::catalog::scan_memories(slug);
                self.send_json(&RpcResponse::new(types::CATALOG_MEMORIES_LIST_RESP, req_id, serde_json::json!({ "memories": memories })));
            }
            types::CATALOG_FILES_LIST_REQ => {
                let dir = v.get("dir").and_then(Value::as_str).unwrap_or("");
                let entries = crate::fs_tree::list_dir(dir).unwrap_or_default();
                self.send_json(&RpcResponse::new(types::CATALOG_FILES_LIST_RESP, req_id, serde_json::json!({ "entries": entries })));
            }
            types::CATALOG_SESSIONS_LIST_REQ => {
                let cwd = v.get("cwd").and_then(Value::as_str).unwrap_or("");
                let claude = crate::sessions::list_claude_sessions(cwd);
                let codex = crate::sessions::list_codex_sessions(cwd);
                let opencode = crate::sessions::list_opencode_sessions(cwd);
                self.send_json(&RpcResponse::new(types::CATALOG_SESSIONS_LIST_RESP, req_id, serde_json::json!({ "claude": claude, "codex": codex, "opencode": opencode })));
            }
            other => {
                if !req_id.is_empty() {
                    self.send_err(&req_id, other, "unsupported rpc", "unsupported");
                }
            }
        }
    }

    fn subscribe(&mut self, req_id: &str, p: SubscribeTerminalParams) {
        let sub = match self.core.subscribe(&p.terminal_id) {
            Some(s) => s,
            None => {
                self.send_err(req_id, types::TERMINAL_SUBSCRIBE_REQ, "no such terminal", "not_found");
                return;
            }
        };
        let slot = self.next_slot;
        self.next_slot = self.next_slot.wrapping_add(1);
        self.slot_term.insert(slot, p.terminal_id.clone());
        self.send_json(&RpcResponse::new(
            types::TERMINAL_SUBSCRIBE_RESP,
            req_id,
            SubscribeTerminalResult { slot, revision: sub.baseline, cols: sub.cols, rows: sub.rows },
        ));
        // visible-snapshot → 先发 Restore（历史重放）；client 按 revision<=baseline 去重
        if matches!(p.restore, RestoreMode::VisibleSnapshot { .. }) && !sub.snapshot.is_empty() {
            self.send_binary(encode_revision_frame(Opcode::Restore, slot, sub.baseline, &sub.snapshot));
        }
        // forwarder：broadcast → Output 帧；Lagged → 重取快照发 Restore 对齐
        let out = self.out.clone();
        let core = self.core.clone();
        let term_id = p.terminal_id.clone();
        let mut rx = sub.rx;
        let mut resize_rx = sub.resize_rx;
        let h = tokio::spawn(async move {
            loop {
                tokio::select! {
                    out_evt = rx.recv() => match out_evt {
                        Ok((rev, bytes)) => {
                            let frame = encode_revision_frame(Opcode::Output, slot, rev, &bytes);
                            if out.send(Outbound::Terminal(frame)).is_err() {
                                break;
                            }
                        }
                        Err(RecvError::Lagged(_)) => {
                            if let Some((base, snap)) = core.snapshot(&term_id) {
                                let frame = encode_revision_frame(Opcode::Restore, slot, base, &snap);
                                if out.send(Outbound::Terminal(frame)).is_err() {
                                    break;
                                }
                            }
                        }
                        Err(RecvError::Closed) => break,
                    },
                    rsz_evt = resize_rx.recv() => match rsz_evt {
                        // 桌面 resize → 推 Resize 帧，远程渲染器跟随尺寸（不回改 PTY）
                        Ok((cols, rows)) => {
                            let frame = encode_resize(slot, &Resize { cols, rows });
                            if out.send(Outbound::Terminal(frame)).is_err() {
                                break;
                            }
                        }
                        Err(RecvError::Lagged(_)) => {} // 落后忽略，下次 resize 仍会推
                        Err(RecvError::Closed) => break,
                    },
                }
            }
        });
        self.forwarders.insert(slot, h);
    }

    fn unsubscribe(&mut self, terminal_id: &str) {
        let slots: Vec<u8> = self
            .slot_term
            .iter()
            .filter(|(_, t)| t.as_str() == terminal_id)
            .map(|(s, _)| *s)
            .collect();
        for s in slots {
            self.slot_term.remove(&s);
            if let Some(h) = self.forwarders.remove(&s) {
                h.abort();
            }
        }
    }

    fn handle_binary(&mut self, data: &[u8]) {
        let f = match decode_frame(data) {
            Ok(f) => f,
            Err(_) => return,
        };
        let term_id = match self.slot_term.get(&f.slot) {
            Some(t) => t.clone(),
            None => return,
        };
        match f.opcode {
            Opcode::Input => {
                let _ = self.core.write(&term_id, f.payload);
            }
            // Resize：远程仅镜像、不改 PTY 尺寸（桌面独占尺寸，避免拉锯压缩）；忽略
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use htybox_link::terminal::{encode_frame, split_revision};
    use std::time::Duration;
    use tokio_tungstenite::tungstenite::Message as TMsg;

    type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    fn start_host() -> u16 {
        let core = Arc::new(TerminalCore::default());
        let identity = Arc::new(HostIdentity::load_or_create());
        let listener = bind(false);
        let port = listener.local_addr().unwrap().port();
        let workspaces = Arc::new(Mutex::new(WorkspacesResult::default()));
        tokio::spawn(serve(listener, core, identity, workspaces));
        port
    }
    async fn connect(port: u16) -> Ws {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
            .await
            .unwrap();
        ws
    }
    async fn send_text(ws: &mut Ws, v: Value) {
        ws.send(TMsg::Text(v.to_string().into())).await.unwrap();
    }
    async fn recv_json(ws: &mut Ws) -> Value {
        loop {
            match ws.next().await {
                Some(Ok(TMsg::Text(t))) => return serde_json::from_str(&t).unwrap(),
                Some(Ok(_)) => continue,
                other => panic!("ws closed before json: {other:?}"),
            }
        }
    }
    async fn hello(ws: &mut Ws) {
        send_text(ws, serde_json::json!({"type":"hello","clientId":"t","clientType":"cli","protocolVersion":1,"appVersion":"test","capabilities":{"terminalBinary":true}})).await;
        assert_eq!(recv_json(ws).await["type"], "server_info");
    }
    async fn create_term(ws: &mut Ws) -> String {
        send_text(ws, serde_json::json!({"type":"terminal.create.request","requestId":"rc","cols":80,"rows":24})).await;
        let cr = recv_json(ws).await;
        assert_eq!(cr["type"], "terminal.create.response");
        cr["payload"]["terminalId"].as_str().unwrap().to_string()
    }
    async fn subscribe(ws: &mut Ws, term_id: &str, rid: &str) -> u8 {
        send_text(ws, serde_json::json!({"type":"terminal.subscribe.request","requestId":rid,"terminalId":term_id,"restore":{"mode":"visible-snapshot"}})).await;
        let sr = recv_json(ws).await;
        assert_eq!(sr["type"], "terminal.subscribe.response");
        sr["payload"]["slot"].as_u64().unwrap() as u8
    }
    async fn wait_marker(ws: &mut Ws, marker: &str) -> bool {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match ws.next().await {
                    Some(Ok(TMsg::Binary(b))) => {
                        if let Ok(f) = decode_frame(&b) {
                            if matches!(f.opcode, Opcode::Output | Opcode::Restore) {
                                if let Ok((_r, data)) = split_revision(f.payload) {
                                    if String::from_utf8_lossy(data).contains(marker) {
                                        return true;
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(_)) => continue,
                    _ => return false,
                }
            }
        })
        .await
        .unwrap_or(false)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_subscribe_input_output() {
        let port = start_host();
        let mut ws = connect(port).await;
        hello(&mut ws).await;
        let id = create_term(&mut ws).await;
        let slot = subscribe(&mut ws, &id, "rs").await;
        ws.send(TMsg::Binary(encode_frame(Opcode::Input, slot, b"echo HTYBOXOK\r\n").into()))
            .await
            .unwrap();
        assert!(wait_marker(&mut ws, "HTYBOXOK").await, "未收到回显 HTYBOXOK");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_clients_share_and_history() {
        let port = start_host();
        // A 建终端 + 订阅 + 产生历史输出
        let mut a = connect(port).await;
        hello(&mut a).await;
        let id = create_term(&mut a).await;
        let slot_a = subscribe(&mut a, &id, "ra").await;
        a.send(TMsg::Binary(encode_frame(Opcode::Input, slot_a, b"echo SHARED1\r\n").into()))
            .await
            .unwrap();
        assert!(wait_marker(&mut a, "SHARED1").await, "A 未见 SHARED1");
        // B 后加入、订阅同一终端 → visible-snapshot 历史重放应含 SHARED1
        let mut b = connect(port).await;
        hello(&mut b).await;
        let _slot_b = subscribe(&mut b, &id, "rb").await;
        assert!(wait_marker(&mut b, "SHARED1").await, "B 未在历史重放看到 SHARED1");
        // A 再输入 → B 实时可见
        a.send(TMsg::Binary(encode_frame(Opcode::Input, slot_a, b"echo SHARED2\r\n").into()))
            .await
            .unwrap();
        assert!(wait_marker(&mut b, "SHARED2").await, "B 未实时看到 SHARED2");
    }
}
