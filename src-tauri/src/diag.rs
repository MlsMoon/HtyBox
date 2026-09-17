//! 拖放诊断（设置「拖放诊断日志」开启时才工作）：诊断日志追加 + 宿主 UI 线程看门狗
//! + `write_terminal` 耗时采样。排查「左栏拖到终端卡死」用：命中时能分辨卡在宿主事件线程
//!（看门狗记到停顿 / 写入耗时飙高）还是拖拽循环 / 渲染层（前端事件序列断在何处）。
//!
//! 日志：`config_dir()/HtyBox/logs/dragdrop-YYYYMMDD.log`（与 agent-accounts.json / global-env 同根），
//! 每行 = RFC3339(UTC) 时间戳 + 事件名 + JSON 明细；前端批量追加的行自带时间戳，原样落盘。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

static ENABLED: AtomicBool = AtomicBool::new(false);
static WATCHDOG_RUNNING: AtomicBool = AtomicBool::new(false);

/// 看门狗探活间隔。
const PING_INTERVAL: Duration = Duration::from_millis(200);
/// 探活回包超过此时长记「主线程停顿」。
const STALL_THRESHOLD: Duration = Duration::from_millis(500);
/// 单次探活最长等待（主线程彻底卡死时也要留下记录并继续下一轮）。
const PING_MAX_WAIT: Duration = Duration::from_secs(30);
/// `write_terminal` 耗时达到此值才记录。
const WRITE_SAMPLE_THRESHOLD: Duration = Duration::from_millis(20);

/// 诊断是否开启（hot path 只做一次原子读）。
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

fn stamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "unknown-time".into())
}

fn log_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or_else(|| "无法定位配置目录".to_string())?
        .join("HtyBox")
        .join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("创建诊断日志目录失败：{e}"))?;
    let today = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
    Ok(dir.join(format!(
        "dragdrop-{:04}{:02}{:02}.log",
        today.year(),
        today.month() as u8,
        today.day()
    )))
}

/// 追加若干行（行内容原样写入，调用方自带时间戳）。
pub fn append(lines: &[String]) -> Result<(), String> {
    let path = log_path()?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开诊断日志失败：{e}"))?;
    for line in lines {
        writeln!(f, "{line}").map_err(|e| format!("写诊断日志失败：{e}"))?;
    }
    Ok(())
}

fn append_own(line: String) {
    if let Err(e) = append(&[format!("{} {line}", stamp())]) {
        eprintln!("[diag] {e}");
    }
}

/// `write_terminal` 耗时采样：达到阈值或出错才记录；落盘交给阻塞线程池，不占宿主线程。
pub fn sample_write(id: &str, bytes: usize, elapsed: Duration, failed: bool) {
    if elapsed < WRITE_SAMPLE_THRESHOLD && !failed {
        return;
    }
    let line = format!(
        "write-terminal-slow {{\"termId\":{:?},\"bytes\":{bytes},\"ms\":{},\"failed\":{failed}}}",
        id,
        elapsed.as_millis()
    );
    tauri::async_runtime::spawn_blocking(move || append_own(line));
}

/// 开关看门狗：开启时起后台线程，周期性向宿主 UI 线程投递探活闭包，回包超过阈值记「主线程停顿」。
/// 关闭后线程在当前探活轮结束时退出；重复开启不会起第二条线程。
pub fn set_watchdog(app: AppHandle, on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
    if !on || WATCHDOG_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || {
        loop {
            if !ENABLED.load(Ordering::Relaxed) {
                WATCHDOG_RUNNING.store(false, Ordering::Release);
                // 关闭与再开启交错：若刚被再次开启且尚无人接手，自己接着跑
                if ENABLED.load(Ordering::Relaxed) && !WATCHDOG_RUNNING.swap(true, Ordering::AcqRel) {
                    continue;
                }
                return;
            }
            let pong = Arc::new(AtomicBool::new(false));
            let p = pong.clone();
            let sent = Instant::now();
            if app.run_on_main_thread(move || p.store(true, Ordering::Release)).is_err() {
                WATCHDOG_RUNNING.store(false, Ordering::Release);
                return; // 事件循环已结束
            }
            while !pong.load(Ordering::Acquire) && sent.elapsed() < PING_MAX_WAIT {
                std::thread::sleep(Duration::from_millis(20));
            }
            let latency = sent.elapsed();
            if latency >= STALL_THRESHOLD {
                append_own(format!(
                    "main-thread-stall {{\"ms\":{},\"ponged\":{}}}",
                    latency.as_millis(),
                    pong.load(Ordering::Acquire)
                ));
            }
            std::thread::sleep(PING_INTERVAL);
        }
    });
}
