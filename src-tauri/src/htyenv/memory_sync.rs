// htyenv/memory_sync.rs —— 记忆单向收敛(sync-all ③ 同语义):canonical memory → Claude 产品缓存。
// 缺失补齐(write 模式)/同内容跳过/同名异内容只报 CONFLICT 不覆盖/缓存多出只报 UNCURATED 不删;
// imports/ 不下发;MEMORY.md 特判:canonical(契约段+索引正文)须包含缓存正文,不下发不覆盖。
// 缓存目录由调用方经 catalog::resolve_claude_project_in_home 解析后传入(引擎不自算 slug,保持与 catalog 解耦)。
use std::fs;
use std::path::Path;

use serde::Serialize;

use super::manifest;
use super::write_atomic;

const MEMORY_MD: &str = "MEMORY.md";
const MEMORY_DIR: &str = "memory";
const IMPORTS_DIR: &str = "imports";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MemoryMdStatus {
    /// canonical(契约段+索引正文)包含缓存正文(TrimStart BOM 后 Contains)
    Consistent,
    /// 索引正文两侧不一致 → 人工裁决
    Conflict,
    CanonicalMissing,
    CacheMissing,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySyncReport {
    pub cache_dir: String,
    pub canonical_present: bool,
    /// 缓存缺失的相对路径:write 模式=本轮已补齐;check 模式=将补齐
    pub filled: Vec<String>,
    pub same: usize,
    /// 同名异内容(只报告绝不覆盖)
    pub conflicts: Vec<String>,
    /// 缓存多出、canonical 无(只报告绝不删)
    pub uncurated: Vec<String>,
    pub memory_md: MemoryMdStatus,
}

/// 单向收敛主入口;write=false 为只读对账(零写入),write=true 仅执行"缺失补齐"。
pub fn converge_memory(
    workspace: &Path,
    cache_memory_dir: &Path,
    write: bool,
) -> Result<MemorySyncReport, String> {
    let src = manifest::env_root(workspace).join(MEMORY_DIR);
    let mut report = MemorySyncReport {
        cache_dir: cache_memory_dir.display().to_string(),
        canonical_present: src.is_dir(),
        filled: Vec::new(),
        same: 0,
        conflicts: Vec::new(),
        uncurated: Vec::new(),
        memory_md: MemoryMdStatus::CanonicalMissing,
    };
    if report.canonical_present {
        for rel in walk_rel_files(&src)? {
            if rel == MEMORY_MD || has_component(&rel, IMPORTS_DIR) {
                continue;
            }
            let src_file = src.join(&rel);
            let dst_file = cache_memory_dir.join(&rel);
            if !dst_file.is_file() {
                if write {
                    if let Some(parent) = dst_file.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
                    }
                    let bytes = fs::read(&src_file)
                        .map_err(|e| format!("读取 {} 失败: {e}", src_file.display()))?;
                    write_atomic(&dst_file, &bytes)?;
                }
                report.filled.push(rel);
            } else {
                let src_bytes = fs::read(&src_file)
                    .map_err(|e| format!("读取 {} 失败: {e}", src_file.display()))?;
                let dst_bytes = fs::read(&dst_file)
                    .map_err(|e| format!("读取 {} 失败: {e}", dst_file.display()))?;
                if src_bytes == dst_bytes {
                    report.same += 1;
                } else {
                    report.conflicts.push(rel);
                }
            }
        }
    }
    if cache_memory_dir.is_dir() {
        for rel in walk_rel_files(cache_memory_dir)? {
            if rel == MEMORY_MD {
                continue;
            }
            if !src.join(&rel).is_file() {
                report.uncurated.push(rel);
            }
        }
    }
    report.memory_md = memory_md_status(&src, cache_memory_dir)?;
    Ok(report)
}

/// 根下全部文件的相对路径('/'分隔,升序;含隐藏文件,不跟符号链接)。
fn walk_rel_files(root: &Path) -> Result<Vec<String>, String> {
    let mut rels = Vec::new();
    for item in walkdir::WalkDir::new(root) {
        let item = item.map_err(|e| format!("遍历 {} 失败: {e}", root.display()))?;
        if !item.file_type().is_file() {
            continue;
        }
        let rel = item
            .path()
            .strip_prefix(root)
            .map_err(|e| format!("相对化 {} 失败: {e}", item.path().display()))?
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        rels.push(rel);
    }
    rels.sort();
    Ok(rels)
}

fn has_component(rel: &str, component: &str) -> bool {
    rel.split('/').any(|part| part == component)
}

/// MEMORY.md 特判(sync-all ③):canonical 须包含缓存正文(缓存去 BOM 后 Contains),两侧文本按 lossy UTF-8 读取。
fn memory_md_status(src: &Path, cache: &Path) -> Result<MemoryMdStatus, String> {
    let src_file = src.join(MEMORY_MD);
    let cache_file = cache.join(MEMORY_MD);
    if !src_file.is_file() {
        return Ok(MemoryMdStatus::CanonicalMissing);
    }
    if !cache_file.is_file() {
        return Ok(MemoryMdStatus::CacheMissing);
    }
    let canonical_text = String::from_utf8_lossy(
        &fs::read(&src_file).map_err(|e| format!("读取 {} 失败: {e}", src_file.display()))?,
    )
    .into_owned();
    let cache_text = String::from_utf8_lossy(
        &fs::read(&cache_file).map_err(|e| format!("读取 {} 失败: {e}", cache_file.display()))?,
    )
    .into_owned();
    Ok(
        if canonical_text.contains(cache_text.trim_start_matches('\u{feff}')) {
            MemoryMdStatus::Consistent
        } else {
            MemoryMdStatus::Conflict
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn write(path: &PathBuf, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().to_path_buf();
        let src = ws.join(manifest::ENV_DIR).join(MEMORY_DIR);
        let cache = tmp.path().join("cache-memory");
        // canonical:契约段+索引正文 / 四态文件 / imports 排除项
        write(&src.join(MEMORY_MD), "# 契约段\n单向导入契约…\n# 索引\n- a\n");
        write(&src.join("index_0/x.md"), "same");
        write(&src.join("index_0/y.md"), "canonical-y");
        write(&src.join("index_1/z.md"), "fill-me");
        write(&src.join("imports/i.md"), "never-downsync");
        // cache:MEMORY.md 为 canonical 的子串(索引正文) / x 同 / y 异 / w 多出
        write(&cache.join(MEMORY_MD), "# 索引\n- a\n");
        write(&cache.join("index_0/x.md"), "same");
        write(&cache.join("index_0/y.md"), "cache-y");
        write(&cache.join("index_2/w.md"), "uncurated");
        (tmp, ws, src, cache)
    }

    #[test]
    fn check_reports_four_states_without_writing() {
        let (_tmp, ws, _src, cache) = setup();
        let report = converge_memory(&ws, &cache, false).unwrap();
        assert!(report.canonical_present);
        assert_eq!(report.filled, vec!["index_1/z.md".to_string()]);
        assert_eq!(report.same, 1);
        assert_eq!(report.conflicts, vec!["index_0/y.md".to_string()]);
        assert_eq!(report.uncurated, vec!["index_2/w.md".to_string()]);
        assert_eq!(report.memory_md, MemoryMdStatus::Consistent);
        // 只读:未落盘任何文件
        assert!(!cache.join("index_1/z.md").exists());
    }

    #[test]
    fn write_fills_missing_only_and_is_idempotent() {
        let (_tmp, ws, _src, cache) = setup();
        let first = converge_memory(&ws, &cache, true).unwrap();
        assert_eq!(first.filled, vec!["index_1/z.md".to_string()]);
        assert_eq!(fs::read_to_string(cache.join("index_1/z.md")).unwrap(), "fill-me");
        // CONFLICT 未被覆盖;UNCURATED 未被删;imports 未下发;MEMORY.md 未下发
        assert_eq!(fs::read_to_string(cache.join("index_0/y.md")).unwrap(), "cache-y");
        assert!(cache.join("index_2/w.md").exists());
        assert!(!cache.join("imports/i.md").exists());
        assert_eq!(fs::read_to_string(cache.join(MEMORY_MD)).unwrap(), "# 索引\n- a\n");
        let second = converge_memory(&ws, &cache, true).unwrap();
        assert!(second.filled.is_empty(), "二跑应零补齐");
        assert_eq!(second.same, 2);
        assert_eq!(second.conflicts, vec!["index_0/y.md".to_string()]);
    }

    #[test]
    fn memory_md_conflict_and_missing_states() {
        let (_tmp, ws, src, cache) = setup();
        write(&cache.join(MEMORY_MD), "\u{feff}# 索引\n- a\n");
        assert_eq!(
            converge_memory(&ws, &cache, false).unwrap().memory_md,
            MemoryMdStatus::Consistent,
            "缓存 BOM 应被 TrimStart 后再包含判定"
        );
        write(&cache.join(MEMORY_MD), "# 索引\n- 别的\n");
        assert_eq!(converge_memory(&ws, &cache, false).unwrap().memory_md, MemoryMdStatus::Conflict);
        fs::remove_file(cache.join(MEMORY_MD)).unwrap();
        assert_eq!(converge_memory(&ws, &cache, false).unwrap().memory_md, MemoryMdStatus::CacheMissing);
        fs::remove_file(src.join(MEMORY_MD)).unwrap();
        assert_eq!(converge_memory(&ws, &cache, false).unwrap().memory_md, MemoryMdStatus::CanonicalMissing);
    }

    #[test]
    fn absent_canonical_reports_cache_as_uncurated() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("cache-memory");
        write(&cache.join("index_0/x.md"), "x");
        let report = converge_memory(tmp.path(), &cache, false).unwrap();
        assert!(!report.canonical_present);
        assert!(report.filled.is_empty());
        assert_eq!(report.uncurated, vec!["index_0/x.md".to_string()]);
        assert_eq!(report.memory_md, MemoryMdStatus::CanonicalMissing);
    }
}
