//! plan-1：大文本文件分片读取——流式行索引 + 按行范围读 + 文档句柄生命周期（LRU 兜底）。
//! 定位：只服务「只读虚拟预览」（plan-2/3 的数据源）；编辑仍走 fs_tree::read_text_file 全量路径。
//! 编码/二进制判定原子（utf16_bom / strict_utf8_text / is_text_ext / replace_invalid_text_chars）
//! 与 fs_tree 共用同一实现，杜绝两条读取路径行为漂移。

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::Serialize;

use crate::fs_tree::{
    is_text_ext, replace_invalid_text_chars, strict_utf8_text, utf16_bom, DEFAULT_MAX_OPEN_BYTES,
};
/// 句柄注册表 LRU 上限（决策 4 = A）：防前端异常（崩溃/漏关/跨窗迁移遗漏）下索引常驻累积。
const MAX_OPEN_DOCS: usize = 16;
/// open 返回的首屏行数（省一次 IPC 往返，覆盖首屏 + overscan）。
const HEAD_LINES: u64 = 200;
/// 顺序扫描缓冲大小。
const SCAN_BUF_BYTES: usize = 256 * 1024;
/// 句柄失效错误前缀（外部修改 / 句柄不存在 / 内容与索引不一致）：
/// 前端据此识别「需重新 open」而非普通失败（catalog.ts 侧同步此字面量）。
pub const DOC_INVALID_PREFIX: &str = "doc-invalid: ";

/// 单文档行偏移索引 + 元信息（句柄背后的数据）。
struct DocIndex {
    path: String,
    total_bytes: u64,
    /// 每行起始字节偏移；行 i 的字节范围 = line_offsets[i] .. line_offsets[i+1]（末行到 total_bytes）。
    /// 行数口径 = 显示行数（与 Get-Content / 编辑器一致：末尾换行符不再多算一行）。
    line_offsets: Vec<u64>,
    /// 含 NUL / 非法 UTF-8（白名单或强制下仍打开）：取行时走有损转换 + 坏字符清洗。
    lossy: bool,
    /// 打开时的修改时间：取行前校验，外部修改 → 句柄失效，前端重新 open（决策 3 = A）。
    mtime: SystemTime,
    /// LRU 逐出依据（单调使用序号，open/read 时刷新）。
    last_used: u64,
}

/// 文档句柄注册表（挂 AppState）。Mutex 粒度 = 整表：命令频率低（滚动取行有前端分段缓存挡着）、
/// 临界区只做查表/插删，实际 IO 全部在锁外。
#[derive(Default)]
pub struct DocRegistry {
    docs: Mutex<HashMap<u64, DocIndex>>,
    next_id: AtomicU64,
    use_seq: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    /// false = 拒绝打开（reason 说明原因，can_force 表示可否强制有损重试）。
    pub ok: bool,
    pub doc_id: u64,
    pub total_lines: u64,
    pub total_bytes: u64,
    pub lossy: bool,
    /// lossy 时供前端警告条显示的文案。
    pub warning: Option<String>,
    pub reason: Option<String>,
    /// 对齐 read_text_file 语义：疑似二进制 = 可强制；UTF-16 / 超可打开上限 = 不可。
    pub can_force: bool,
    /// 首屏行（0 起，最多 HEAD_LINES 行）。
    pub head_lines: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReadLinesResult {
    pub lines: Vec<String>,
    pub start_line: u64,
    /// 本次返回已含最后一行。
    pub eof: bool,
}

/// 流式扫描产物。
struct ScanOutcome {
    line_offsets: Vec<u64>,
    lossy: bool,
}

/// 顺序扫描建行索引 + 内容判定，**绝不整读进内存**（设计原则 3）：
/// - 行偏移：首行起点 0；每个 `\n` 之后若仍有字节即是下一行起点
/// - 内容判定与全量路径严格同判：NUL 或非法 UTF-8 → lossy。UTF-8 合法性用 std from_utf8
///   分块校验（与 String::from_utf8 同一实现），块尾不完整序列搬到下一块块首续验
/// - `reject_on_binary`（白名单外且未强制）：首个坏字节即返回 Ok(None) 提前拒绝，省整段扫描
fn scan_index(
    file: &mut File,
    total_bytes: u64,
    reject_on_binary: bool,
) -> Result<Option<ScanOutcome>, String> {
    let mut line_offsets: Vec<u64> = Vec::new();
    if total_bytes > 0 {
        line_offsets.push(0);
    }
    // 头部预留 3 字节放上块尾部未完成的 UTF-8 序列，使校验数据逻辑连续
    let mut buf = vec![0u8; SCAN_BUF_BYTES + 3];
    let mut tail_len = 0usize; // buf[..tail_len] = 上块尾部未完成序列
    let mut file_pos: u64 = 0; // 本轮新读入数据（buf[tail_len]）对应的文件偏移
    let mut lossy = false;
    loop {
        let n = file
            .read(&mut buf[tail_len..tail_len + SCAN_BUF_BYTES])
            .map_err(|e| e.to_string())?;
        if n == 0 {
            // EOF 时仍残留未完成序列 = 文件以截断的多字节字符结尾 → 非法
            if tail_len > 0 && !lossy {
                lossy = true;
                if reject_on_binary {
                    return Ok(None);
                }
            }
            break;
        }
        // \n / NUL 只扫新读入部分（tail 在其原块已扫过）
        for (i, &b) in buf[tail_len..tail_len + n].iter().enumerate() {
            if b == b'\n' {
                let pos = file_pos + i as u64;
                if pos + 1 < total_bytes {
                    line_offsets.push(pos + 1);
                }
            } else if b == 0 && !lossy {
                lossy = true;
                if reject_on_binary {
                    return Ok(None);
                }
            }
        }
        // UTF-8 校验（tail + 新块连续检查）；一旦判定 lossy 即不再校验（只剩找 \n）
        if !lossy {
            let data_len = tail_len + n;
            match std::str::from_utf8(&buf[..data_len]) {
                Ok(_) => tail_len = 0,
                Err(e) => {
                    let valid = e.valid_up_to();
                    match e.error_len() {
                        Some(_) => {
                            // 真非法字节
                            lossy = true;
                            tail_len = 0;
                            if reject_on_binary {
                                return Ok(None);
                            }
                        }
                        None => {
                            // 尾部不完整序列（≤3 字节）→ 搬到 buf 头部，下一轮拼上新数据续验
                            buf.copy_within(valid..data_len, 0);
                            tail_len = data_len - valid;
                        }
                    }
                }
            }
        } else {
            tail_len = 0;
        }
        file_pos += n as u64;
    }
    Ok(Some(ScanOutcome { line_offsets, lossy }))
}

/// 读并转换连续行（不含行尾 `\n` / `\r\n`；裸尾 `\r` 非行终止符，保留）：
/// `line_starts` = 各行起始字节偏移（升序窗口），`block_end` = 末行结束偏移（含行尾符）。
/// 切行直接按索引偏移，不再扫描字节——索引即真相。
fn read_lines_io(
    file: &mut File,
    line_starts: &[u64],
    block_end: u64,
    lossy: bool,
) -> Result<Vec<String>, String> {
    if line_starts.is_empty() {
        return Ok(Vec::new());
    }
    let byte_start = line_starts[0];
    let mut raw = vec![0u8; (block_end - byte_start) as usize];
    file.seek(SeekFrom::Start(byte_start))
        .map_err(|e| e.to_string())?;
    file.read_exact(&mut raw).map_err(|e| e.to_string())?;
    let mut lines = Vec::with_capacity(line_starts.len());
    for i in 0..line_starts.len() {
        let s = (line_starts[i] - byte_start) as usize;
        let e = if i + 1 < line_starts.len() {
            (line_starts[i + 1] - byte_start) as usize
        } else {
            raw.len()
        };
        let mut seg = &raw[s..e];
        if seg.ends_with(b"\r\n") {
            seg = &seg[..seg.len() - 2];
        } else if seg.ends_with(b"\n") {
            seg = &seg[..seg.len() - 1];
        }
        let line = if lossy {
            replace_invalid_text_chars(&String::from_utf8_lossy(seg))
        } else {
            // 严格文档的行必为合法 UTF-8；失败 = 内容与索引不一致（外部原地改写而 mtime 未变）
            strict_utf8_text(seg.to_vec()).map_err(|_| {
                format!("{DOC_INVALID_PREFIX}文件内容与索引不一致（可能已被外部修改），请重新打开")
            })?
        };
        lines.push(line);
    }
    Ok(lines)
}

impl DocRegistry {
    /// 注册新句柄并返回 docId；超过 MAX_OPEN_DOCS 时逐出最久未用者（决策 4 = A 的兜底半边，
    /// 正常路径是前端面板卸载时显式 close_text_document）。
    fn register(&self, mut doc: DocIndex) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        doc.last_used = self.use_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let mut docs = self.docs.lock().unwrap();
        while docs.len() >= MAX_OPEN_DOCS {
            let Some((&evict, _)) = docs.iter().min_by_key(|(_, d)| d.last_used) else {
                break;
            };
            docs.remove(&evict);
        }
        docs.insert(id, doc);
        id
    }

    /// 按行范围读取（锁内只查表拷窗口偏移，文件 IO 全在锁外）：
    /// - 句柄不存在 / 文件已被外部修改 → DOC_INVALID 前缀错误，前端重新 open（决策 3 = A）
    /// - start 完全越界 → 明确错误，**不返回空数组冒充成功**；尾部部分越界 → 截到末行 + eof
    pub fn read_lines(
        &self,
        doc_id: u64,
        start_line: u64,
        count: u64,
    ) -> Result<ReadLinesResult, String> {
        let (path, mtime, lossy, starts, block_end, eof) = {
            let mut docs = self.docs.lock().unwrap();
            let Some(doc) = docs.get_mut(&doc_id) else {
                return Err(format!(
                    "{DOC_INVALID_PREFIX}文档句柄不存在或已被回收，请重新打开"
                ));
            };
            doc.last_used = self.use_seq.fetch_add(1, Ordering::Relaxed) + 1;
            let total_lines = doc.line_offsets.len() as u64;
            if start_line >= total_lines {
                return Err(format!(
                    "行范围越界：start={start_line}，总行数={total_lines}"
                ));
            }
            let end_line = start_line.saturating_add(count).min(total_lines);
            let starts = doc.line_offsets[start_line as usize..end_line as usize].to_vec();
            let block_end = doc
                .line_offsets
                .get(end_line as usize)
                .copied()
                .unwrap_or(doc.total_bytes);
            (
                doc.path.clone(),
                doc.mtime,
                doc.lossy,
                starts,
                block_end,
                end_line == total_lines,
            )
        };
        // mtime 校验：外部修改即失效（复用前端既有 file-changed 重开链路，不返回错乱内容）
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.modified().map_err(|e| e.to_string())? != mtime {
            self.docs.lock().unwrap().remove(&doc_id);
            return Err(format!("{DOC_INVALID_PREFIX}文件已被外部修改，请重新打开"));
        }
        let mut file = File::open(&path).map_err(|e| e.to_string())?;
        let lines = read_lines_io(&mut file, &starts, block_end, lossy)?;
        Ok(ReadLinesResult {
            lines,
            start_line,
            eof,
        })
    }

    /// 释放句柄（前端面板卸载时显式调用；幂等，不存在不报错）。
    pub fn close(&self, doc_id: u64) {
        self.docs.lock().unwrap().remove(&doc_id);
    }

    /// 当前句柄数（独立验证 bin 用：LRU 上限断言）。
    pub fn open_count(&self) -> usize {
        self.docs.lock().unwrap().len()
    }
}

/// 打开大文本文档：流式建行索引 → 注册句柄（LRU 逐出最久未用）→ 返回元信息 + 首屏行。
/// 目录 → Err；超可打开上限 / UTF-16 / 白名单外二进制 → ok=false 如实拒绝（不静默降级）。
pub fn open_doc(
    reg: &DocRegistry,
    path: &str,
    force_lossy: bool,
    max_open_bytes: Option<u64>,
) -> Result<OpenResult, String> {
    let p = Path::new(path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("是目录，无法作为文本打开".into());
    }
    let total_bytes = meta.len();
    let refuse = |reason: String, can_force: bool| OpenResult {
        ok: false,
        doc_id: 0,
        total_lines: 0,
        total_bytes,
        lossy: false,
        warning: None,
        reason: Some(reason),
        can_force,
        head_lines: Vec::new(),
    };
    let limit = max_open_bytes.unwrap_or(DEFAULT_MAX_OPEN_BYTES);
    if total_bytes > limit {
        return Ok(refuse(
            format!(
                "文件过大（{} MB），超出可打开上限（{} MB），可在设置中调整",
                total_bytes / 1024 / 1024,
                limit / 1024 / 1024
            ),
            false,
        ));
    }
    let mut file = File::open(p).map_err(|e| e.to_string())?;
    // UTF-16 BOM：分片不支持（字节偏移与转码后逻辑行不线性对应，决策 2 = A），如实说明出路
    let mut bom = [0u8; 2];
    let bom_n = file.read(&mut bom).map_err(|e| e.to_string())?;
    if utf16_bom(&bom[..bom_n]).is_some() {
        return Ok(refuse(
            "UTF-16 编码文件不支持分片预览：可先转码为 UTF-8，或在编辑上限内走普通打开".into(),
            false,
        ));
    }
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let reject_on_binary = !force_lossy && !is_text_ext(p);
    let Some(scan) = scan_index(&mut file, total_bytes, reject_on_binary)? else {
        return Ok(refuse("检测到二进制内容".into(), true));
    };
    let mtime = meta.modified().map_err(|e| e.to_string())?;
    let total_lines = scan.line_offsets.len() as u64;
    let head_count = HEAD_LINES.min(total_lines) as usize;
    let head_lines = if head_count > 0 {
        let block_end = scan
            .line_offsets
            .get(head_count)
            .copied()
            .unwrap_or(total_bytes);
        read_lines_io(&mut file, &scan.line_offsets[..head_count], block_end, scan.lossy)?
    } else {
        Vec::new()
    };
    let warning = scan
        .lossy
        .then(|| "包含无效编码字节，已以 � 替换显示".to_string());
    let doc_id = reg.register(DocIndex {
        path: path.to_string(),
        total_bytes,
        line_offsets: scan.line_offsets,
        lossy: scan.lossy,
        mtime,
        last_used: 0,
    });
    Ok(OpenResult {
        ok: true,
        doc_id,
        total_lines,
        total_bytes,
        lossy: scan.lossy,
        warning,
        reason: None,
        can_force: false,
        head_lines,
    })
}
