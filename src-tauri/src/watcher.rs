//! 监听 skill / memory / Codex 会话名索引，防抖后向前端发刷新事件（M3b）。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter};

fn watch_path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches("//?/")
        .to_lowercase()
}

fn is_codex_session_index(path: &Path, codex_root: &Path) -> bool {
    watch_path_key(path) == watch_path_key(&codex_root.join("session_index.jsonl"))
}

/// `projects/<slug>/memory` 本身或其任意后代才是原生 Memory 变化。
/// 同级导入 staging/old/conflict 即使内部含 `payload/memory` 也不能暴露。
fn is_claude_memory_path(path: &Path, projects_root: &Path) -> bool {
    let path = watch_path_key(path);
    let root = watch_path_key(projects_root)
        .trim_end_matches('/')
        .to_string();
    let Some(relative) = path.strip_prefix(&format!("{root}/")) else {
        return false;
    };
    let mut parts = relative.split('/');
    let Some(slug) = parts.next() else {
        return false;
    };
    let Some(memory) = parts.next() else {
        return false;
    };
    !slug.is_empty() && memory == "memory"
}

fn claude_memory_watch_root(claude: &Path, projects: &Path) -> Option<std::path::PathBuf> {
    if projects.is_dir() {
        Some(projects.to_path_buf())
    } else if claude.is_dir() {
        // Watching the nearest existing Claude ancestor lets an externally
        // created `projects/<slug>/memory` become visible without an app restart.
        Some(claude.to_path_buf())
    } else {
        // A first in-app import explicitly emits `memory-changed` in the Step 6
        // wrapper. External creation before `.claude` exists requires restart.
        None
    }
}

pub fn start(app: AppHandle) {
    let _ = FILE_APP.set(app.clone()); // 供 watch_file 的回调 emit "file-changed"
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let claude = home.join(".claude");
    let claude_projects = claude.join("projects");
    let codex = home.join(".codex");
    let codex_for_handler = codex.clone();
    let projects_for_handler = claude_projects.clone();

    let handler_app = app.clone();
    let debouncer = new_debouncer(
        Duration::from_millis(500),
        move |res: DebounceEventResult| {
            let Ok(events) = res else {
                return;
            };
            let mut skills = false;
            let mut memory = false;
            let mut codex_sessions = false;
            for e in &events {
                let p = e.path.to_string_lossy().replace('\\', "/");
                if p.contains("/.claude/skills/") || p.contains("/plugins/") {
                    skills = true;
                }
                if is_claude_memory_path(&e.path, &projects_for_handler) {
                    memory = true;
                }
                if is_codex_session_index(&e.path, &codex_for_handler) {
                    codex_sessions = true;
                }
            }
            if skills {
                let _ = handler_app.emit("skills-changed", ());
            }
            if memory {
                let _ = handler_app.emit("memory-changed", ());
            }
            if codex_sessions {
                let _ = handler_app.emit("codex-sessions-changed", ());
            }
        },
    );

    let Ok(mut debouncer) = debouncer else {
        return;
    };
    let w = debouncer.watcher();
    // 目录不存在时 watch 报错，忽略即可
    let _ = w.watch(&claude.join("skills"), RecursiveMode::Recursive);
    let _ = w.watch(
        &claude.join("plugins").join("marketplaces"),
        RecursiveMode::Recursive,
    );
    if let Some(memory_watch_root) = claude_memory_watch_root(&claude, &claude_projects) {
        let _ = w.watch(&memory_watch_root, RecursiveMode::Recursive);
    }
    // Codex 自动命名或 `/rename` 会更新根目录下的索引；监听目录可兼容索引尚未创建的情况。
    let _ = w.watch(&codex, RecursiveMode::NonRecursive);

    // 保活到进程结束：drop 会停止监听
    std::mem::forget(debouncer);
}

// ---------------- M9：编辑器打开文件的按需监听 ----------------
// 外部修改「打开中的文件」时 emit "file-changed"(payload=路径)，编辑器收到后重读。
// 单文件监听底层是监听其父目录，故回调里按已注册路径过滤后再发事件，避免误报同目录其它文件。

static WATCHED: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
static FILE_DEBOUNCER: OnceLock<Mutex<Option<Debouncer<RecommendedWatcher>>>> = OnceLock::new();
static FILE_APP: OnceLock<AppHandle> = OnceLock::new();

fn norm(p: &str) -> String {
    p.replace('\\', "/")
}
fn watched() -> &'static Mutex<HashMap<String, usize>> {
    WATCHED.get_or_init(|| Mutex::new(HashMap::new()))
}
fn file_debouncer() -> &'static Mutex<Option<Debouncer<RecommendedWatcher>>> {
    FILE_DEBOUNCER.get_or_init(|| Mutex::new(None))
}

// 懒建唯一的文件防抖器（首个被监听文件时创建）。锁序固定为 WATCHED → FILE_DEBOUNCER，回调只取 WATCHED，无死锁。
fn ensure_debouncer() -> Result<(), String> {
    let mut g = file_debouncer().lock().map_err(|e| e.to_string())?;
    if g.is_some() {
        return Ok(());
    }
    let d = new_debouncer(Duration::from_millis(300), |res: DebounceEventResult| {
        let Ok(events) = res else {
            return;
        };
        let Some(app) = FILE_APP.get() else {
            return;
        };
        let keys: Vec<String> = match watched().lock() {
            Ok(w) => w.keys().cloned().collect(),
            Err(_) => return,
        };
        let mut sent = HashSet::new();
        for e in &events {
            let p = norm(&e.path.to_string_lossy());
            if keys.contains(&p) && sent.insert(p.clone()) {
                let _ = app.emit("file-changed", p);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    *g = Some(d);
    Ok(())
}

/// 开始监听某文件（编辑器打开时调用）。同一文件多面板按引用计数，仅首个真正 watch。
pub fn watch_file(path: &str) -> Result<(), String> {
    ensure_debouncer()?;
    let key = norm(path);
    let mut w = watched().lock().map_err(|e| e.to_string())?;
    let c = w.entry(key).or_insert(0);
    *c += 1;
    if *c == 1 {
        if let Some(d) = file_debouncer().lock().map_err(|e| e.to_string())?.as_mut() {
            d.watcher()
                .watch(Path::new(path), RecursiveMode::NonRecursive)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 停止监听某文件（编辑器关闭时调用）。引用计数归零才真正 unwatch。
pub fn unwatch_file(path: &str) -> Result<(), String> {
    let key = norm(path);
    let mut w = watched().lock().map_err(|e| e.to_string())?;
    if let Some(c) = w.get_mut(&key) {
        *c -= 1;
        if *c == 0 {
            w.remove(&key);
            if let Some(d) = file_debouncer().lock().map_err(|e| e.to_string())?.as_mut() {
                let _ = d.watcher().unwatch(Path::new(path));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{claude_memory_watch_root, is_claude_memory_path, is_codex_session_index};
    use std::path::Path;

    #[test]
    fn only_codex_session_index_triggers_session_refresh() {
        let root = Path::new(r"C:\Users\tester\.codex");
        assert!(is_codex_session_index(
            Path::new(r"C:\Users\tester\.codex\session_index.jsonl"),
            root
        ));
        assert!(is_codex_session_index(
            Path::new(r"c:\users\TESTER\.codex\session_index.jsonl"),
            root
        ));
        assert!(!is_codex_session_index(
            Path::new(r"C:\Users\tester\.codex\state_5.sqlite"),
            root
        ));
        assert!(!is_codex_session_index(
            Path::new(r"C:\work\.codex\session_index.jsonl"),
            root
        ));
    }

    #[test]
    fn memory_root_and_descendants_trigger_but_transport_siblings_do_not() {
        let root = Path::new(r"C:\Users\tester\.claude\projects");
        assert!(is_claude_memory_path(
            Path::new(r"C:\Users\tester\.claude\projects\slug\memory"),
            root
        ));
        assert!(is_claude_memory_path(
            Path::new(r"c:\users\TESTER\.claude\projects\SLUG\MEMORY\nested\topic.md"),
            root
        ));
        assert!(!is_claude_memory_path(
            Path::new(r"C:\Users\tester\.claude\projects\slug\memory-old"),
            root
        ));
        assert!(!is_claude_memory_path(
            Path::new(
                r"C:\Users\tester\.claude\projects\slug\.htybox-stage-1\payload\memory\topic.md"
            ),
            root
        ));
        assert!(!is_claude_memory_path(
            Path::new(r"C:\elsewhere\projects\slug\memory\topic.md"),
            root
        ));
    }

    #[test]
    fn memory_watch_uses_projects_or_nearest_existing_claude_ancestor() {
        let fixture = tempfile::tempdir().unwrap();
        let claude = fixture.path().join(".claude");
        let projects = claude.join("projects");
        assert_eq!(claude_memory_watch_root(&claude, &projects), None);
        std::fs::create_dir(&claude).unwrap();
        assert_eq!(
            claude_memory_watch_root(&claude, &projects).as_deref(),
            Some(claude.as_path())
        );
        std::fs::create_dir(&projects).unwrap();
        assert_eq!(
            claude_memory_watch_root(&claude, &projects).as_deref(),
            Some(projects.as_path())
        );
    }
}
