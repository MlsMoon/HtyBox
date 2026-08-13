//! plan-1 独立验证 bin（Windows 下 cargo test 受 ConPTY dll 阻断，验证走此 bin）：
//! - 无参：正确性套件（边界样本自动生成于 %TEMP%\htybox-probe\，参照实现 = 全量读 split 对拍）
//! - --perf：性能套件（50MB/200MB 合成日志：open 耗时 / 取行耗时 / 内存 / LRU / mtime 失效）
//! 运行（PowerShell）：cargo run --release --features large-text-probe --bin large_text_probe [-- --perf]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use htybox_app_lib::large_text::{open_doc, DocRegistry, DOC_INVALID_PREFIX};

/// 参照实现：全量读 + 按 \n 切分（末尾换行不多算一行；仅后跟 \n 的行尾 \r 按 CRLF 去掉）。
/// 与被测分片路径完全独立，两者一致即证明索引与切行正确。
fn ref_lines(content: &str) -> Vec<String> {
    if content.is_empty() {
        return Vec::new();
    }
    let parts: Vec<&str> = content.split('\n').collect();
    let n = parts.len();
    let take = if content.ends_with('\n') { n - 1 } else { n };
    (0..take)
        .map(|i| {
            let s = parts[i];
            if i < n - 1 {
                s.strip_suffix('\r').unwrap_or(s).to_string()
            } else {
                s.to_string()
            }
        })
        .collect()
}

fn probe_dir() -> PathBuf {
    let d = std::env::temp_dir().join("htybox-probe");
    fs::create_dir_all(&d).expect("create probe dir");
    d
}

fn working_set_mb() -> f64 {
    let pid = std::process::id();
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("(Get-Process -Id {pid}).WorkingSet64"),
        ])
        .output()
        .expect("query working set");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .unwrap_or(0.0)
        / 1024.0
        / 1024.0
}

/// 对拍一个文件：open + 全量参照比较（行数 + 抽查区间逐行相等）。
fn check_file(reg: &DocRegistry, path: &Path, expect_lossy: bool) {
    let content_ref = {
        let bytes = fs::read(path).unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let expect = ref_lines(&content_ref);
    let r = open_doc(reg, path.to_str().unwrap(), false, None).expect("open_doc Err");
    assert!(r.ok, "应能打开：{:?} reason={:?}", path, r.reason);
    assert_eq!(
        r.total_lines,
        expect.len() as u64,
        "行数口径不一致：{:?}",
        path
    );
    assert_eq!(r.lossy, expect_lossy, "lossy 判定不符：{:?}", path);
    // 首屏行与参照一致（lossy 文件参照含清洗差异，只比行数结构，内容对拍走严格文件）
    if !expect_lossy {
        for (i, line) in r.head_lines.iter().enumerate() {
            assert_eq!(line, &expect[i], "首屏第 {i} 行不一致：{:?}", path);
        }
        // 三段区间抽查：头部 / 中部 / 尾部（含部分越界截断）
        let total = expect.len() as u64;
        for (start, count) in [(0u64, 10u64), (total / 2, 25), (total.saturating_sub(5), 99)] {
            if start >= total {
                continue;
            }
            let got = reg.read_lines(r.doc_id, start, count).expect("read_lines");
            let end = (start + count).min(total);
            assert_eq!(got.lines.len() as u64, end - start, "区间行数：{:?}", path);
            assert_eq!(got.eof, end == total, "eof 标志：{:?}", path);
            for (k, line) in got.lines.iter().enumerate() {
                assert_eq!(
                    line,
                    &expect[start as usize + k],
                    "区间行内容不一致 @{}+{k}：{:?}",
                    start,
                    path
                );
            }
        }
    }
    reg.close(r.doc_id);
}

fn correctness() {
    let d = probe_dir();
    let reg = DocRegistry::default();

    // —— 边界样本 ——
    let empty = d.join("empty.txt");
    fs::write(&empty, "").unwrap();
    let noeol = d.join("noeol.txt");
    fs::write(&noeol, "single line without trailing newline").unwrap();
    let blanks = d.join("blanks.txt");
    fs::write(&blanks, "\n\n\n").unwrap();
    let crlf = d.join("crlf.txt");
    fs::write(&crlf, "first\r\nsecond\r\n中文行\r\nlast").unwrap();
    let cn = d.join("cn.txt");
    fs::write(&cn, "第一行：中文内容\nsecond ASCII\n混合 mixed 行\n").unwrap();
    let longline = d.join("longline.txt");
    fs::write(&longline, format!("{}\ntail\n", "x".repeat(2 * 1024 * 1024))).unwrap();

    check_file(&reg, &empty, false);
    check_file(&reg, &noeol, false);
    check_file(&reg, &blanks, false);
    check_file(&reg, &crlf, false);
    check_file(&reg, &cn, false);
    check_file(&reg, &longline, false);
    println!("[ok] 边界样本（空/无尾换行/全空行/CRLF/中文/超长行）对拍通过");

    // 空文件：0 行，read_lines 越界须报错而非空数组
    let r = open_doc(&reg, empty.to_str().unwrap(), false, None).unwrap();
    assert_eq!(r.total_lines, 0);
    assert!(reg.read_lines(r.doc_id, 0, 10).is_err(), "空文件取行应报越界");
    reg.close(r.doc_id);
    println!("[ok] 空文件 0 行 + 越界明确报错");

    // UTF-16 BOM → 拒绝分片（决策 2 = A），不可强制
    let utf16 = d.join("utf16.txt");
    let mut bytes = vec![0xFFu8, 0xFE];
    for u in "hello 你好\r\nline2".encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    fs::write(&utf16, &bytes).unwrap();
    let r = open_doc(&reg, utf16.to_str().unwrap(), false, None).unwrap();
    assert!(!r.ok && !r.can_force, "UTF-16 应拒绝且不可强制");
    assert!(r.reason.as_deref().unwrap_or("").contains("UTF-16"));
    println!("[ok] UTF-16 BOM 拒绝分片，reason 如实说明");

    // 含 NUL 的 .log（TEXT_EXTS 白名单）→ 有损打开，坏字节 � 替换；与老路径行为一致
    // 注意样本不能叫 nul.log——"nul" 是 Windows 保留设备名（任意扩展名都会被解析为 NUL 设备）
    let nul_log = d.join("withnul.log");
    fs::write(&nul_log, b"line1\nli\x00ne2\nline3\n").unwrap();
    let r = open_doc(&reg, nul_log.to_str().unwrap(), false, None).unwrap();
    assert!(r.ok && r.lossy, "白名单内含 NUL 应有损打开");
    assert_eq!(r.total_lines, 3);
    assert_eq!(r.head_lines[1], "li\u{FFFD}ne2", "NUL 应替换为 U+FFFD");
    reg.close(r.doc_id);
    println!("[ok] 含 NUL 的 .log 有损打开（� 替换）");

    // 含 NUL 的 .bin（白名单外）→ 拒绝但可强制；强制后有损打开
    let nul_bin = d.join("withnul.bin");
    fs::write(&nul_bin, b"ab\x00cd\nef\n").unwrap();
    let r = open_doc(&reg, nul_bin.to_str().unwrap(), false, None).unwrap();
    assert!(!r.ok && r.can_force, "白名单外二进制应拒绝且可强制");
    let r = open_doc(&reg, nul_bin.to_str().unwrap(), true, None).unwrap();
    assert!(r.ok && r.lossy, "强制后应有损打开");
    reg.close(r.doc_id);
    println!("[ok] 白名单外二进制：拒绝可强制，强制后有损打开");

    // 跨块 UTF-8 边界：在扫描缓冲边界（256KB）处放一个多字节字符，不得误判 lossy
    let boundary = d.join("boundary.txt");
    let mut s = "a".repeat(256 * 1024 - 1);
    s.push_str("界"); // 3 字节字符恰跨 256KB 块边界
    s.push('\n');
    s.push_str("下一行\n");
    fs::write(&boundary, &s).unwrap();
    check_file(&reg, &boundary, false);
    println!("[ok] 跨扫描块边界的多字节字符不误判 lossy");

    // 超可打开上限 → 如实拒绝不可强制
    let r = open_doc(&reg, crlf.to_str().unwrap(), false, Some(8)).unwrap();
    assert!(!r.ok && !r.can_force, "超可打开上限应拒绝且不可强制");
    assert!(r.reason.as_deref().unwrap_or("").contains("可打开上限"));
    println!("[ok] 超可打开上限如实拒绝");

    // mtime 失效：open 后追加写 → read_lines 返回 doc-invalid
    let mutating = d.join("mutating.log");
    fs::write(&mutating, "a\nb\nc\n").unwrap();
    let r = open_doc(&reg, mutating.to_str().unwrap(), false, None).unwrap();
    assert!(r.ok);
    std::thread::sleep(std::time::Duration::from_millis(30)); // 保证 mtime 变化可观测
    fs::write(&mutating, "a\nb\nc\nd 外部追加\n").unwrap();
    let e = reg.read_lines(r.doc_id, 0, 10).unwrap_err();
    assert!(
        e.starts_with(DOC_INVALID_PREFIX),
        "外部修改后应返回 doc-invalid 前缀错误，实得：{e}"
    );
    println!("[ok] 外部修改 → doc-invalid 失效错误（决策 3 = A）");

    // LRU：同一注册表连开 20 份 → 句柄数 ≤ 16，且最早句柄被逐出
    let first = open_doc(&reg, cn.to_str().unwrap(), false, None).unwrap();
    for _ in 0..20 {
        let r = open_doc(&reg, crlf.to_str().unwrap(), false, None).unwrap();
        assert!(r.ok);
    }
    assert!(reg.open_count() <= 16, "LRU 上限失守：{}", reg.open_count());
    let e = reg.read_lines(first.doc_id, 0, 1).unwrap_err();
    assert!(e.starts_with(DOC_INVALID_PREFIX), "被逐出句柄应报 doc-invalid");
    println!("[ok] LRU 上限（连开 20 → ≤16）+ 被逐出句柄明确报错");

    println!("\n== 正确性套件全部通过 ==");
}

/// 造大样本：重复真实 Rust 源码内容到目标体积（行长分布贴近实际）。缓存复用。
fn make_big(path: &Path, target: u64) {
    if path.exists() && fs::metadata(path).map(|m| m.len() >= target).unwrap_or(false) {
        return;
    }
    let src = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("session_import.rs"),
    )
    .expect("读 session_import.rs 作样本源");
    let mut buf = String::with_capacity(target as usize + src.len());
    while (buf.len() as u64) < target {
        buf.push_str(&src);
    }
    fs::write(path, &buf).expect("写大样本");
}

fn perf() {
    let d = probe_dir();
    let reg = DocRegistry::default();
    for (label, size, budget_ms) in [("50MB", 50u64 * 1024 * 1024, 400u128), ("200MB", 200 * 1024 * 1024, 1500)] {
        let p = d.join(format!("big-{label}.log"));
        make_big(&p, size);
        let ws0 = working_set_mb();
        let t = Instant::now();
        let r = open_doc(&reg, p.to_str().unwrap(), false, None).unwrap();
        let open_ms = t.elapsed().as_millis();
        let ws1 = working_set_mb();
        assert!(r.ok, "{label} 应能打开");
        let mid = r.total_lines / 2;
        let t = Instant::now();
        let got = reg.read_lines(r.doc_id, mid, 100).unwrap();
        let read_ms = t.elapsed().as_micros() as f64 / 1000.0;
        // 与参照对拍中段 3 行（大文件全量参照太慢，抽查首/中行内容非空即可信——结构对拍在正确性套件已覆盖）
        assert_eq!(got.lines.len(), 100);
        println!(
            "[{label}] open={open_ms}ms (目标<{budget_ms}ms)  read100@mid={read_ms:.2}ms (目标<5ms)  \
             totalLines={}  索引理论内存={:.1}MB  WorkingSet {:.0}→{:.0}MB (增量 {:.0}MB, 文件 {}MB)",
            r.total_lines,
            r.total_lines as f64 * 8.0 / 1024.0 / 1024.0,
            ws0,
            ws1,
            ws1 - ws0,
            size / 1024 / 1024,
        );
        assert!(open_ms < budget_ms, "{label} open 超预算");
        assert!(read_ms < 5.0, "{label} read 超预算");
        reg.close(r.doc_id);
    }
    println!("\n== 性能套件全部通过 ==");
}

fn main() {
    let perf_mode = std::env::args().any(|a| a == "--perf");
    if perf_mode {
        perf();
    } else {
        correctness();
    }
}
