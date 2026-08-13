//! M8：工作区文件树（懒加载，一层）。供「文件」页签按需展开目录、拖文件进终端注入。

use std::path::{Path, PathBuf};

use base64::prelude::{Engine as _, BASE64_STANDARD};
use serde::Serialize;
use walkdir::WalkDir;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// 列出某目录的直接子项（不递归）。目录在前、再文件；同类按名称不分大小写升序。
/// 包含点文件/点目录（如 `.claude`）。读失败返回 Err 供前端行内提示。
pub fn list_dir(path: &str) -> Result<Vec<DirEntry>, String> {
    let rd = std::fs::read_dir(path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        let Some(name) = p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
        else {
            continue;
        };
        out.push(DirEntry {
            name,
            path: p.to_string_lossy().into_owned(),
            is_dir: p.is_dir(), // 跟随符号链接：指向目录的链接也算目录
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

// ---------------- M9：文件读写 / 增删改 ----------------

const DEFAULT_MAX_EDIT_BYTES: u64 = 10 * 1024 * 1024; // 默认编辑上限 10MB（前端经全局设置传入覆盖）

/// 只读预览可打开上限默认值 512MB（主题群全局决策 1；前端经设置 maxOpenMB 传入覆盖）：
/// 分片读后打开成本与体积基本脱钩，唯行索引（约 8 字节/行）在此量级开始显著占内存。
/// 放本模块（而非 large_text）以保持依赖单向：large_text → fs_tree。
pub const DEFAULT_MAX_OPEN_BYTES: u64 = 512 * 1024 * 1024;

/// 内容判定失败（含 NUL / 非法 UTF-8）时仍直接以文本有损打开的扩展名——
/// 用户直观认为是文本的格式，不再挡"二进制"占位；白名单外靠 force_lossy 逃生门。
const TEXT_EXTS: &[&str] = &[
    "svg", "xml", "html", "htm", "txt", "log", "md", "markdown", "json", "jsonl",
    "yaml", "yml", "toml", "csv", "tsv", "ini", "conf", "cfg", "gitignore",
    "gitattributes", "editorconfig", "env", "bat", "cmd", "ps1", "sh", "py",
    "js", "ts", "tsx", "jsx", "rs", "cs", "c", "h", "cpp", "hpp", "java", "kt",
    "go", "lua", "sql",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextResult {
    pub content: String,
    pub editable: bool,
    pub reason: Option<String>,
    /// editable=false 时前端是否可给「仍以文本方式打开」按钮（疑似二进制=可；过大=不可，正道是调设置上限）。
    pub can_force: bool,
    /// 内容经有损转换（坏字节以 U+FFFD 替换 / UTF-16 转码），保存会以转换后内容覆盖原字节。
    pub lossy: bool,
    /// lossy 时供编辑器警告条显示的文案。
    pub warning: Option<String>,
    /// 超出编辑上限但未超可打开上限：可走大文件只读虚拟预览（前端据此分流，不再死挡占位）。
    pub viewable: bool,
    /// 文件字节数（plan-5：前端据此决定是否提供「仍要编辑」入口——极端体积不让用户确认后卡死）。
    pub size_bytes: u64,
}

/// 有损打开时的坏字符清洗：除 \t\n\r 外的 C0 控制字符、DEL、U+FFFE/FFFF 一并替换为 U+FFFD。
/// 这些字符是合法 UTF-8（from_utf8_lossy 不会动它们），但既是 XML 1.0 非法字符——
/// 残留一个就让整个 SVG/XML 预览报 parsererror——在文本文件里也只会是损坏产物；
/// 统一替换后坏 SVG 无需手修即可直接预览，编辑视图中坏字节可见、可删。
/// （fs_tree 全量路径与 large_text 分片路径共用的判定原子）
pub fn replace_invalid_text_chars(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\t' | '\n' | '\r' => c,
            '\0'..='\u{1F}' | '\u{7F}' | '\u{FFFE}' | '\u{FFFF}' => '\u{FFFD}',
            _ => c,
        })
        .collect()
}

/// UTF-16 BOM 探测：Some(true)=LE、Some(false)=BE、None=非 UTF-16 BOM 开头。
/// （共用判定原子：read_text_file 据此转码；large_text 据此拒绝分片——UTF-16 字节偏移与逻辑行不线性对应）
pub fn utf16_bom(bytes: &[u8]) -> Option<bool> {
    if bytes.len() >= 2 && bytes[..2] == [0xFF, 0xFE] {
        Some(true)
    } else if bytes.len() >= 2 && bytes[..2] == [0xFE, 0xFF] {
        Some(false)
    } else {
        None
    }
}

/// 严格文本判定：不含 NUL 且合法 UTF-8 → Ok(无损字符串)；否则 Err(原字节)（疑似二进制，走有损/拒绝分支）。
/// （共用判定原子：两条读取路径对「什么算二进制」必须是同一份实现，杜绝行为漂移）
pub fn strict_utf8_text(bytes: Vec<u8>) -> Result<String, Vec<u8>> {
    let has_nul = bytes.contains(&0);
    match String::from_utf8(bytes) {
        Ok(s) if !has_nul => Ok(s),
        Ok(s) => Err(s.into_bytes()),
        Err(e) => Err(e.into_bytes()),
    }
}

/// TEXT_EXTS 白名单判定：内容判定失败（含 NUL / 非法 UTF-8）时是否仍按文本有损打开（共用判定原子）。
pub fn is_text_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| TEXT_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

/// 读文本文件。目录 → Err；超上限 → 不可编辑（引导调设置）；UTF-16 BOM → 转码打开；
/// 疑似二进制（含 NUL / 非法 UTF-8）→ 文本扩展名白名单或 force_lossy 时有损打开，否则占位但可强制。
pub fn read_text_file(
    path: &str,
    force_lossy: bool,
    max_bytes: Option<u64>,
    max_open_bytes: Option<u64>,
) -> Result<ReadTextResult, String> {
    let p = Path::new(path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("是目录，无法作为文本打开".into());
    }
    let size_bytes = meta.len();
    let ok_text = move |content: String, lossy: bool, warning: Option<String>| ReadTextResult {
        content,
        editable: true,
        reason: None,
        can_force: false,
        lossy,
        warning,
        viewable: false,
        size_bytes,
    };
    let blocked = move |reason: String, can_force: bool| ReadTextResult {
        content: String::new(),
        editable: false,
        reason: Some(reason),
        can_force,
        lossy: false,
        warning: None,
        viewable: false,
        size_bytes,
    };
    let limit = max_bytes.unwrap_or(DEFAULT_MAX_EDIT_BYTES);
    if meta.len() > limit {
        // 双阈值语义（主题群全局决策 1）：超编辑上限但在可打开上限内 → viewable=true，
        // 前端可走分片只读虚拟预览；超可打开上限 → 如实拒绝并指引设置。
        let open_limit = max_open_bytes.unwrap_or(DEFAULT_MAX_OPEN_BYTES);
        let viewable = meta.len() <= open_limit;
        let reason = if viewable {
            format!(
                "文件较大（{} KB），超出编辑上限（{} MB）",
                meta.len() / 1024,
                limit / 1024 / 1024
            )
        } else {
            format!(
                "文件过大（{} MB），超出可打开上限（{} MB），可在设置中调整",
                meta.len() / 1024 / 1024,
                open_limit / 1024 / 1024
            )
        };
        return Ok(ReadTextResult {
            viewable,
            ..blocked(reason, false)
        });
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    // UTF-16 BOM（Windows 日志常见，如 PowerShell 5 重定向输出）：转码显示，保存写回 UTF-8。
    if let Some(le) = utf16_bom(&bytes) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| {
                if le {
                    u16::from_le_bytes([c[0], c[1]])
                } else {
                    u16::from_be_bytes([c[0], c[1]])
                }
            })
            .collect();
        let label = if le { "UTF-16 LE" } else { "UTF-16 BE" };
        return Ok(ok_text(
            String::from_utf16_lossy(&units),
            true,
            Some(format!("{label} 编码：已转码显示，保存将以 UTF-8 写回")),
        ));
    }
    // 严格路径：不含 NUL 且合法 UTF-8 —— 绝大多数文件，无损打开。
    match strict_utf8_text(bytes) {
        Ok(content) => Ok(ok_text(content, false, None)),
        // 疑似二进制（含 NUL 或非法 UTF-8）：白名单扩展名 / 强制 → 有损打开，否则占位 + 可强制。
        Err(bytes) => {
            if force_lossy || is_text_ext(p) {
                let content = replace_invalid_text_chars(&String::from_utf8_lossy(&bytes));
                Ok(ok_text(
                    content,
                    true,
                    Some("包含无效编码字节，已以 � 替换显示；保存将写回替换后的内容".into()),
                ))
            } else {
                Ok(blocked("检测到二进制内容".into(), true))
            }
        }
    }
}

pub fn write_text_file(path: &str, content: &str) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024; // 20MB：base64 走 IPC，过大易卡，超过不预览

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadImageResult {
    pub data_url: String,
    pub ok: bool,
    pub reason: Option<String>,
}

/// 扩展名 → WebView 可渲染的图片 MIME；非受支持图片返回 None（svg 由文本预览另行处理）。
fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// 读图片为 base64 data URL（供「文件」页签预览）。
/// 非图片/目录/超大 → ok=false + reason（不回数据）；读失败 → Err 供行内提示。
pub fn read_image_data_url(path: &str) -> Result<ReadImageResult, String> {
    let p = Path::new(path);
    let fail = |reason: String| ReadImageResult {
        data_url: String::new(),
        ok: false,
        reason: Some(reason),
    };
    let Some(mime) = image_mime(p) else {
        return Ok(fail("不是受支持的图片格式".to_string()));
    };
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("是目录，无法作为图片打开".into());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Ok(fail(format!(
            "图片过大（{} MB），不支持预览",
            meta.len() / 1024 / 1024
        )));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let b64 = BASE64_STANDARD.encode(&bytes);
    Ok(ReadImageResult {
        data_url: format!("data:{mime};base64,{b64}"),
        ok: true,
        reason: None,
    })
}

/// 校验新名安全（防越界/非法）。
fn sanitize_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty()
        || n.contains('/')
        || n.contains('\\')
        || n == "."
        || n == ".."
        || n.contains("..")
    {
        return Err(format!("非法名称：{name}"));
    }
    Ok(n.to_string())
}

pub fn create_entry(parent_dir: &str, name: &str, is_dir: bool) -> Result<String, String> {
    let n = sanitize_name(name)?;
    let target = Path::new(parent_dir).join(&n);
    if target.exists() {
        return Err(format!("已存在：{n}"));
    }
    if is_dir {
        std::fs::create_dir(&target).map_err(|e| e.to_string())?;
    } else {
        std::fs::File::create(&target).map_err(|e| e.to_string())?;
    }
    Ok(target.to_string_lossy().into_owned())
}

pub fn rename_entry(path: &str, new_name: &str) -> Result<String, String> {
    let n = sanitize_name(new_name)?;
    let p = Path::new(path);
    let parent = p.parent().ok_or("无父目录")?;
    let target = parent.join(&n);
    if target.exists() {
        return Err(format!("已存在：{n}"));
    }
    std::fs::rename(p, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

pub fn delete_entry(path: &str) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

/// 目标目录里求不冲突的名字：name、name (2)、name (3)…（文件保留扩展名）。
fn unique_in_dir(dest_dir: &Path, file_name: &str) -> PathBuf {
    let first = dest_dir.join(file_name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match file_name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (file_name.to_string(), String::new()),
    };
    let mut i = 2;
    loop {
        let c = dest_dir.join(format!("{stem} ({i}){ext}"));
        if !c.exists() {
            return c;
        }
        i += 1;
    }
}

fn copy_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for e in std::fs::read_dir(src).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            copy_recursive(&e.path(), &dst.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// 移动进目标目录（同卷 rename，跨卷回退 copy+删）。禁止移进自身/子目录。
pub fn move_entry(src: &str, dest_dir: &str) -> Result<String, String> {
    let s = Path::new(src);
    let dest = Path::new(dest_dir);
    if dest == s || dest.starts_with(s) {
        return Err("不能移动到自身或其子目录".into());
    }
    let name = s.file_name().ok_or("无效源")?.to_os_string();
    let target = dest.join(&name);
    if target.exists() {
        return Err(format!("目标已存在同名项：{}", name.to_string_lossy()));
    }
    if std::fs::rename(s, &target).is_err() {
        copy_recursive(s, &target)?;
        let r = if s.is_dir() {
            std::fs::remove_dir_all(s)
        } else {
            std::fs::remove_file(s)
        };
        r.map_err(|e| e.to_string())?;
    }
    Ok(target.to_string_lossy().into_owned())
}

/// 复制进目标目录（同名自动改名）。禁止复制进自身/子目录。
pub fn copy_entry(src: &str, dest_dir: &str) -> Result<String, String> {
    let s = Path::new(src);
    let dest = Path::new(dest_dir);
    if dest == s || dest.starts_with(s) {
        return Err("不能复制到自身或其子目录".into());
    }
    let name = s
        .file_name()
        .ok_or("无效源")?
        .to_string_lossy()
        .into_owned();
    let target = unique_in_dir(dest, &name);
    copy_recursive(s, &target)?;
    Ok(target.to_string_lossy().into_owned())
}

/// 写 OS 拖入文件的字节到目标目录（同名自动改名）。
pub fn import_dropped_file(dest_dir: &str, name: &str, bytes: Vec<u8>) -> Result<String, String> {
    let n = sanitize_name(name)?;
    let target = unique_in_dir(Path::new(dest_dir), &n);
    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// 为拖入的文件夹在目标目录创建去重后的顶层目录，返回其绝对路径。
/// 之后该文件夹内的每一项都用 `import_dropped_entry` 写到这个返回值之下，
/// 以保持「整个文件夹同名只去重一次、内部结构原样保留」。
pub fn import_make_dir(dest_dir: &str, name: &str) -> Result<String, String> {
    let n = sanitize_name(name)?;
    let target = unique_in_dir(Path::new(dest_dir), &n);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// 把拖入文件夹里的一项写到导入根 `base_dir` 之下，按相对路径保留层级。
/// `rel_path` 以 '/' 分隔，逐段经 `sanitize_name` 校验防越界；
/// `is_dir=true` 仅创建目录（用于保留空子目录），否则写文件字节并自动建父目录。
pub fn import_dropped_entry(
    base_dir: &str,
    rel_path: &str,
    is_dir: bool,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let mut target = PathBuf::from(base_dir);
    for seg in rel_path.split('/') {
        if seg.is_empty() {
            continue;
        }
        target.push(sanitize_name(seg)?);
    }
    if is_dir {
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    } else {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 在系统资源管理器中定位该文件/目录。
pub fn reveal_in_explorer(path: &str) -> Result<(), String> {
    crate::platform_services::platform_services().reveal_path(path)
}

/// 把系统剪贴板中的图片（截图等位图）存到工作区 `.htybox/<subdir>/`，返回绝对路径。
/// - `subdir == "tmp"`（默认）：`clip-<ts>.png`，落盘后清理超过 48h 的旧文件（终端/Flow 临时图）
/// - `subdir == "bookmarks"`：`bm-<ts>.png`，**不做** 48h 清理（书签长期附件，生命周期跟书签删）
/// 其它 subdir 拒绝（防任意路径写入）。读取走目标平台的剪贴板实现。
/// 本函数由 Tauri 命令经 `spawn_blocking` 调用（勿在 UI/IPC 热路径同步跑）。无损 PNG。
pub fn save_clipboard_image(workspace_dir: &str, subdir: &str) -> Result<String, String> {
    crate::platform_services::platform_services().save_clipboard_image(workspace_dir, subdir)
}

// ---------------- M9：全局文件搜索（双击 Shift）----------------

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    ".plastic",
    "target",
    "Library",
    "Temp",
    "Obj",
    "obj",
    "Build",
    "Builds",
    "Logs",
    "dist",
    "build",
    ".next",
    "bin",
    ".cache",
    ".vs",
    "MemoryCaptures",
    "UserSettings",
];
// 遍历防爆硬上限：正常工作区（已剔除噪声目录/忽略名单）远不及；仅防病态目录把扫描拖死。
const HARD_WALK_CAP: usize = 5_000_000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub name: String,
    pub rel: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ListFilesResult {
    /// 收集到的前 max_files 个文件（供 quick-open 列表/过滤）。
    pub files: Vec<FileRef>,
    /// 工作区有效文件真实总数（即使 files 因 max_files 截断也照数完），供前端显示/判断是否截断。
    pub total: usize,
    /// 收集到的前 max_files 个文件夹（与 files 同口径过滤；供 quick-open 搜索/定位）。
    pub folders: Vec<FileRef>,
    /// 工作区文件夹真实总数（独立于 total「文件数」语义）。
    pub folder_total: usize,
}

/// 路径 → FileRef（name/rel/path），文件与文件夹收集共用，避免重复样板。
fn make_file_ref(p: &Path, root_path: &Path) -> FileRef {
    FileRef {
        name: p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string(),
        rel: p
            .strip_prefix(root_path)
            .ok()
            .and_then(|r| r.to_str())
            .unwrap_or("")
            .to_string(),
        path: p.to_string_lossy().into_owned(),
    }
}

/// 遍历工作区「有效文件」（统一口径）：跳 SKIP_DIRS（任意层级噪声目录）
/// + 用户忽略名单 folderset（仅 root 一级目录，与文件树「顶层忽略」一致）
/// + extset（任意层级按扩展名）。返回 (前 max_collect 个 FileRef, 有效文件真实总数)。
fn walk_files(
    root: &str,
    skip_folders: Vec<String>,
    skip_exts: Vec<String>,
    max_collect: usize,
) -> ListFilesResult {
    use std::collections::HashSet;
    let root_path = Path::new(root);
    let folderset: HashSet<String> = skip_folders.into_iter().collect();
    let extset: HashSet<String> = skip_exts.into_iter().map(|e| e.to_lowercase()).collect();
    let mut out = Vec::new();
    let mut total = 0usize;
    let mut folders = Vec::new();
    let mut folder_total = 0usize;
    let walker = WalkDir::new(root_path).into_iter().filter_entry(|e| {
        if e.file_type().is_dir() {
            if let Some(n) = e.file_name().to_str() {
                // 噪声目录（node_modules/.git/Library/Temp…）：任意层级都跳。
                if SKIP_DIRS.contains(&n) {
                    return false;
                }
                // 用户忽略名单：仅作用于 root 一级目录（depth==1），与文件树「顶层文件夹忽略」语义对齐；
                // 否则深层同名目录（如各子工程内的 Packages）会被全层级误杀——文件树看得到却搜不到。
                if e.depth() == 1 && folderset.contains(n) {
                    return false;
                }
            }
        }
        true
    });
    for entry in walker.filter_map(|e| e.ok()) {
        if total + folder_total >= HARD_WALK_CAP {
            break;
        }
        let ft = entry.file_type();
        let p = entry.path();
        // 文件夹：filter_entry 已剔噪声/忽略名单（与文件同口径），独立计数收集；跳 root 自身（depth==0）。
        if ft.is_dir() {
            if entry.depth() == 0 {
                continue;
            }
            folder_total += 1;
            if folders.len() < max_collect {
                folders.push(make_file_ref(p, root_path));
            }
            continue;
        }
        if !ft.is_file() {
            continue;
        }
        if !extset.is_empty() {
            if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                if extset.contains(&ext.to_lowercase()) {
                    continue;
                }
            }
        }
        total += 1;
        if out.len() >= max_collect {
            continue; // 已达收集上限：只继续计数得真实总数，不再收集 FileRef
        }
        out.push(make_file_ref(p, root_path));
    }
    ListFilesResult {
        files: out,
        total,
        folders,
        folder_total,
    }
}

/// 列工作区文件供 quick-open：收集前 max_files 个 + 返回有效文件真实总数。
/// skip_folders=忽略的文件夹名（仅匹配 root 一级目录，与文件树「顶层忽略」一致）；
/// skip_exts=忽略的扩展名（不含点，作用于所有层级文件）；max_files=收集上限（全局设置，默认 10 万）。
pub fn list_all_files(
    root: &str,
    skip_folders: Vec<String>,
    skip_exts: Vec<String>,
    max_files: usize,
) -> ListFilesResult {
    walk_files(root, skip_folders, skip_exts, max_files)
}

/// 只统计工作区有效文件总数（不收集列表，供设置面板「当前工作区文件数」显示）。
pub fn count_workspace_files(
    root: &str,
    skip_folders: Vec<String>,
    skip_exts: Vec<String>,
) -> usize {
    walk_files(root, skip_folders, skip_exts, 0).total
}
