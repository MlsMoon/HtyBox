use std::process::{Command, Output, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

static REG_PATH_CACHE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);
const REG_PATH_TTL: Duration = Duration::from_secs(10);

fn output_with_timeout(mut command: Command, timeout: Duration) -> Option<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn registry_paths() -> Vec<String> {
    if let Ok(cache) = REG_PATH_CACHE.lock() {
        if let Some((at, paths)) = &*cache {
            if at.elapsed() < REG_PATH_TTL {
                return paths.clone();
            }
        }
    }
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path','User')); \
             [Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path','Machine'))",
        ])
        .creation_flags(0x0800_0000);
    let output = output_with_timeout(command, Duration::from_secs(10));
    let paths: Vec<String> = output
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .split([';', '\r', '\n'])
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if let Ok(mut cache) = REG_PATH_CACHE.lock() {
        *cache = Some((Instant::now(), paths.clone()));
    }
    paths
}

pub(super) fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
}

pub(super) fn standard_path() -> String {
    let mut parts: Vec<String> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
    for extra in registry_paths() {
        if !parts.iter().any(|path| path.eq_ignore_ascii_case(&extra)) {
            parts.push(extra);
        }
    }
    parts.join(";")
}
