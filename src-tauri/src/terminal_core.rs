//! 终端核心（L2）：终端的**唯一数据源**。
//!
//! 每终端 = 一个 PTY + scrollback 环形缓冲 + `revision` 序列号 + `broadcast` 广播。
//! 读线程是唯一生产者，扇出到三处：① scrollback（历史）② 本地 Tauri `Channel`（无损直通，
//! 保持现有前端体验）③ `broadcast`（远程 WS 订阅者，慢者经快照重放对齐）。
//! 本地与远程都是同一 core 的订阅者（单源多视图），不存在两套数据。

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

use crate::pty::{open_pty, SpawnOptions, TermId};

const SCROLLBACK_CAP: usize = 1024 * 1024; // 每终端 scrollback 字节上限（1 MiB）
const BROADCAST_CAP: usize = 2048; // 广播缓冲消息数（慢订阅者超限→Lagged，由 ws_host 重发快照对齐）

/// 终端元信息（list / rename 用）。
#[derive(Clone)]
pub struct TermMeta {
    pub title: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub workspace_id: Option<String>,
}

/// scrollback 环形缓冲：保留最近若干 (revision, 原始字节) 块，总字节封顶。
struct Scrollback {
    buf: VecDeque<(u64, Vec<u8>)>,
    bytes: usize,
    cap: usize,
}

impl Scrollback {
    fn new(cap: usize) -> Self {
        Self { buf: VecDeque::new(), bytes: 0, cap }
    }
    fn push(&mut self, rev: u64, data: &[u8]) {
        self.buf.push_back((rev, data.to_vec()));
        self.bytes += data.len();
        while self.bytes > self.cap {
            match self.buf.pop_front() {
                Some((_, old)) => self.bytes -= old.len(),
                None => break,
            }
        }
    }
    /// 当前 scrollback 的原始字节拼接（用于 Restore 重放）。
    fn concat(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.bytes);
        for (_, d) in &self.buf {
            out.extend_from_slice(d);
        }
        out
    }
}

struct TermEntry {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    scrollback: Arc<Mutex<Scrollback>>,
    revision: Arc<AtomicU64>,
    tx: broadcast::Sender<(u64, Vec<u8>)>,
    resize_tx: broadcast::Sender<(u16, u16)>, // L4 修复：PTY 尺寸(桌面独占)变化广播给远程订阅者
    meta: Mutex<TermMeta>,
}

/// 一次订阅：当前 scrollback 快照 + 基线 revision（≤baseline 已在快照内）+ 实时增量流。
pub struct Subscription {
    pub snapshot: Vec<u8>,
    pub baseline: u64,
    pub rx: broadcast::Receiver<(u64, Vec<u8>)>,
    /// 订阅时的当前尺寸（客户端据此设置自身渲染网格，不回改 PTY）。
    pub cols: u16,
    pub rows: u16,
    /// PTY 尺寸变化流（桌面 resize 时推送，远程渲染器跟随）。
    pub resize_rx: broadcast::Receiver<(u16, u16)>,
}

/// 终端核心管理器（取代 M1 的 PtyManager）。
#[derive(Default)]
pub struct TerminalCore {
    sessions: Mutex<HashMap<TermId, TermEntry>>,
    app: Mutex<Option<AppHandle>>, // setup 后注入：子进程退出 emit "terminal-exit"
}

impl TerminalCore {
    pub fn set_app(&self, app: AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }

    /// 创建终端。`local`=本地前端的无损 Channel（远程创建时为 None）。
    pub fn create(
        &self,
        id: TermId,
        opts: SpawnOptions,
        local: Option<Channel<Vec<u8>>>,
        workspace_id: Option<String>,
    ) -> Result<(), String> {
        let meta = TermMeta {
            title: id.clone(),
            cwd: opts.cwd.clone().unwrap_or_default(),
            cols: if opts.cols == 0 { 80 } else { opts.cols },
            rows: if opts.rows == 0 { 24 } else { opts.rows },
            workspace_id,
        };
        let parts = open_pty(opts)?;
        let scrollback = Arc::new(Mutex::new(Scrollback::new(SCROLLBACK_CAP)));
        let revision = Arc::new(AtomicU64::new(0));
        let (tx, _) = broadcast::channel(BROADCAST_CAP);
        let (resize_tx, _) = broadcast::channel(BROADCAST_CAP);

        // 读线程：唯一生产者，扇出 scrollback + 本地 Channel + broadcast。
        let mut reader = parts.reader;
        let sb = scrollback.clone();
        let rev = revision.clone();
        let txc = tx.clone();
        let exit_app = self.app.lock().unwrap().clone();
        let exit_id = id.clone();
        let mut local = local;
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break, // EOF / 读错误 → 子进程结束
                    Ok(n) => {
                        let bytes = buf[..n].to_vec();
                        // revision 自增 + 落 scrollback 在同一把锁内（保证 subscribe 原子）
                        let r = {
                            let mut g = sb.lock().unwrap();
                            let r = rev.fetch_add(1, Ordering::Relaxed) + 1;
                            g.push(r, &bytes);
                            r
                        };
                        // 本地无损直通：前端通道关了(刷新)只停本地、reader 继续供远程
                        if let Some(ch) = &local {
                            if ch.send(bytes.clone()).is_err() {
                                local = None;
                            }
                        }
                        let _ = txc.send((r, bytes)); // 无订阅者→Err，忽略
                    }
                }
            }
            if let Some(app) = exit_app {
                let _ = app.emit("terminal-exit", &exit_id);
            }
        });

        self.sessions.lock().unwrap().insert(
            id,
            TermEntry {
                writer: parts.writer,
                master: parts.master,
                child: parts.child,
                scrollback,
                revision,
                tx,
                resize_tx,
                meta: Mutex::new(meta),
            },
        );
        Ok(())
    }

    /// 向终端写入（用户输入）。
    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        let e = map.get_mut(id).ok_or("no such terminal")?;
        e.writer.write_all(data).map_err(|e| e.to_string())?;
        e.writer.flush().map_err(|e| e.to_string())
    }

    /// 调整终端尺寸（同步更新 meta）。
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.sessions.lock().unwrap();
        let e = map.get(id).ok_or("no such terminal")?;
        e.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let mut m = e.meta.lock().unwrap();
        m.cols = cols;
        m.rows = rows;
        drop(m);
        let _ = e.resize_tx.send((cols, rows)); // 通知远程订阅者跟随桌面尺寸
        Ok(())
    }

    /// 关闭终端（杀子进程 + 移除）。
    pub fn close(&self, id: &str) -> Result<(), String> {
        if let Some(mut e) = self.sessions.lock().unwrap().remove(id) {
            let _ = e.child.kill();
        }
        Ok(())
    }

    /// PTY 直接子进程 pid（Windows 上一般为 powershell.exe；其下再挂 claude.exe）。
    pub fn pty_pid(&self, id: &str) -> Option<u32> {
        let map = self.sessions.lock().ok()?;
        map.get(id)?.child.process_id()
    }

    /// 重命名（更新 meta.title）。
    pub fn rename(&self, id: &str, title: String) -> Result<(), String> {
        let map = self.sessions.lock().unwrap();
        let e = map.get(id).ok_or("no such terminal")?;
        e.meta.lock().unwrap().title = title;
        Ok(())
    }

    /// 列出所有终端 (id, meta)。
    pub fn list(&self) -> Vec<(TermId, TermMeta)> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(id, e)| (id.clone(), e.meta.lock().unwrap().clone()))
            .collect()
    }

    /// 订阅：返回 scrollback 快照 + 基线 revision + 实时增量流。
    /// 持 scrollback 锁期间一次性 subscribe + 读 baseline + 取快照，与读线程 push 原子（不重不漏）。
    pub fn subscribe(&self, id: &str) -> Option<Subscription> {
        let map = self.sessions.lock().unwrap();
        let e = map.get(id)?;
        let sb = e.scrollback.lock().unwrap();
        let rx = e.tx.subscribe();
        let resize_rx = e.resize_tx.subscribe();
        let baseline = e.revision.load(Ordering::Relaxed);
        let snapshot = sb.concat();
        let (cols, rows) = {
            let m = e.meta.lock().unwrap();
            (m.cols, m.rows)
        };
        Some(Subscription { snapshot, baseline, rx, cols, rows, resize_rx })
    }

    /// 取最新快照（慢订阅者 Lagged 后重新对齐用）。
    pub fn snapshot(&self, id: &str) -> Option<(u64, Vec<u8>)> {
        let map = self.sessions.lock().unwrap();
        let e = map.get(id)?;
        let sb = e.scrollback.lock().unwrap();
        Some((e.revision.load(Ordering::Relaxed), sb.concat()))
    }
}
