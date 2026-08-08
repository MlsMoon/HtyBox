//! Agent 账号 / API Key 预设（cc-switch 式一键切换）—— 第一期只实装 kimi，架构按 agent 维度组织。
//!
//! 预设存储：`config_dir/HtyBox/agent-accounts.json`（tmp+rename 原子写，同 lib.rs write_atomic 范式）。
//! kimi 现场：`~/.kimi-code/`（`KIMI_CODE_HOME` 优先）—— OAuth = `credentials/kimi-code.json`，
//! API Key = `config.toml` 的 `[providers."managed:kimi-code"] api_key/base_url`，两者互斥生效。
//! 隔离登录：`KIMI_CODE_HOME=<staging> kimi login`（device-code），现场零接触，成功读 staging 凭证存预设。

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use time::format_description::well_known::Rfc3339;

const STORE_VERSION: u32 = 1;
const KIMI_PROVIDER: &str = "managed:kimi-code";
const KIMI_DEFAULT_BASE_URL: &str = "https://api.kimi.com/coding/v1";
const LOGIN_STAGING_PREFIX: &str = "kimi-login-";

// ---------- 预设数据模型（磁盘格式） ----------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PresetKind {
    Oauth,
    Apikey,
}

impl PresetKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Oauth => "oauth",
            Self::Apikey => "apikey",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPreset {
    pub id: String,
    pub name: String,
    pub kind: PresetKind,
    pub created_at: String,
    pub updated_at: String,
    /// kind=oauth：`credentials/kimi-code.json` 原文快照
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_json: Option<String>,
    /// kind=apikey
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentPresets {
    #[serde(default)]
    presets: Vec<AccountPreset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountsFile {
    version: u32,
    #[serde(default)]
    agents: BTreeMap<String, AgentPresets>,
}

impl Default for AccountsFile {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            agents: BTreeMap::new(),
        }
    }
}

// ---------- 前端视图模型（不含明文密钥） ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetView {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub updated_at: String,
    /// 掩码提示：oauth=access_token 前 8 位；apikey=sk-••••+末 4 位
    pub hint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentState {
    /// "oauth" | "apikey" | "none"
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_preset_id: Option<String>,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub presets: Vec<PresetView>,
    pub current: CurrentState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub mode: String,
    /// 切换前自动存档的「自动快照」预设名（当前登录未匹配任何预设时产生）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_archived: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPoll {
    /// "waiting" | "success" | "failed"
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

// ---------- 基础工具 ----------

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "unknown".to_string())
}

/// 自动快照名用的时间串（time crate 未启用 local-offset，统一 UTC）。
fn now_short() -> String {
    let fmt = time::format_description::parse_borrowed::<2>("[year]-[month]-[day] [hour]:[minute]")
        .expect("静态时间格式串必须合法");
    time::OffsetDateTime::now_utc()
        .format(&fmt)
        .unwrap_or_else(|_| now_rfc3339())
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn new_preset_id() -> String {
    format!("p{:x}", now_millis())
}

/// 掩码：>8 字符露前 4 + 末 4，否则全掩。
fn mask_secret(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() <= 8 {
        return "••••••••".to_string();
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().skip(chars.len() - 4).collect();
    format!("{head}••••••••{tail}")
}

fn mask_token(token: &str) -> String {
    let head: String = token.chars().take(8).collect();
    if head.is_empty() {
        "••••••••".to_string()
    } else {
        format!("{head}***…")
    }
}

// ---------- 预设存储（原子读写） ----------

fn store_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or_else(|| "无法定位系统配置目录".to_string())?
        .join("HtyBox")
        .join("agent-accounts.json"))
}

fn tmp_root() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or_else(|| "无法定位系统配置目录".to_string())?
        .join("HtyBox")
        .join("tmp"))
}

fn load_store() -> Result<AccountsFile, String> {
    let path = store_path()?;
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(AccountsFile::default()),
        Err(e) => return Err(format!("读取预设存储失败：{e}")),
    };
    // 解析失败改名 .bak 保留原文件，不静默重建（同 lib.rs load_json_object_or_backup 纪律）
    match serde_json::from_str::<AccountsFile>(&text) {
        Ok(file) => Ok(file),
        Err(_) => {
            let _ = fs::rename(&path, path.with_extension("bak"));
            Ok(AccountsFile::default())
        }
    }
}

fn save_store(file: &AccountsFile) -> Result<(), String> {
    let path = store_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建预设目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入预设临时文件失败：{e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("落盘预设存储失败：{e}"))
}

// ---------- kimi 现场 ----------

fn kimi_home() -> Result<PathBuf, String> {
    if let Ok(custom) = std::env::var("KIMI_CODE_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    Ok(dirs::home_dir()
        .ok_or_else(|| "无法定位用户主目录".to_string())?
        .join(".kimi-code"))
}

fn kimi_config_path() -> Result<PathBuf, String> {
    Ok(kimi_home()?.join("config.toml"))
}

fn kimi_credentials_path() -> Result<PathBuf, String> {
    Ok(kimi_home()?.join("credentials").join("kimi-code.json"))
}

/// 现场生效态：api_key 非空 → apikey（不再看 credentials）；否则 credentials 存在 → oauth；皆无 → none。
struct LiveState {
    mode: &'static str,
    api_key: Option<String>,
    oauth_raw: Option<String>,
}

fn detect_live() -> LiveState {
    if let Ok(path) = kimi_config_path() {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(doc) = text.parse::<toml_edit::DocumentMut>() {
                let key = doc
                    .get("providers")
                    .and_then(|p| p.get(KIMI_PROVIDER))
                    .and_then(|t| t.get("api_key"))
                    .and_then(|i| i.as_str())
                    .map(str::trim)
                    .filter(|k| !k.is_empty());
                if let Some(key) = key {
                    return LiveState {
                        mode: "apikey",
                        api_key: Some(key.to_string()),
                        oauth_raw: None,
                    };
                }
            }
        }
    }
    if let Ok(path) = kimi_credentials_path() {
        if let Ok(raw) = fs::read_to_string(&path) {
            return LiveState {
                mode: "oauth",
                api_key: None,
                oauth_raw: Some(raw),
            };
        }
    }
    LiveState {
        mode: "none",
        api_key: None,
        oauth_raw: None,
    }
}

/// 保留式改写 config.toml 的 api_key/base_url（toml_edit 保其余字段；同 lib.rs write_codex_config 范式）。
fn write_kimi_api_key(api_key: &str, base_url: &str) -> Result<(), String> {
    let path = kimi_config_path()?;
    if !path.exists() {
        return Err("未找到 ~/.kimi-code/config.toml，请先运行一次 kimi 完成初始化".to_string());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取 config.toml 失败：{e}"))?;
    let mut doc = match text.parse::<toml_edit::DocumentMut>() {
        Ok(d) => d,
        Err(_) => {
            let _ = fs::rename(&path, path.with_extension("bak"));
            return Err("config.toml 解析失败，已备份为 config.toml.bak，请检查".to_string());
        }
    };
    let root = doc.as_table_mut();
    if !root.contains_key("providers") {
        let mut providers = toml_edit::Table::new();
        providers.set_implicit(true);
        root.insert("providers", toml_edit::Item::Table(providers));
    }
    let providers = root
        .get_mut("providers")
        .and_then(|i| i.as_table_mut())
        .ok_or_else(|| "config.toml 的 providers 不是表".to_string())?;
    if !providers.contains_key(KIMI_PROVIDER) {
        let mut provider = toml_edit::Table::new();
        provider.insert("type", toml_edit::value("kimi"));
        providers.insert(KIMI_PROVIDER, toml_edit::Item::Table(provider));
    }
    let provider = providers
        .get_mut(KIMI_PROVIDER)
        .and_then(|i| i.as_table_mut())
        .ok_or_else(|| format!("config.toml 的 providers.{KIMI_PROVIDER} 不是表"))?;
    provider.insert("api_key", toml_edit::value(api_key));
    provider.insert("base_url", toml_edit::value(base_url));
    write_atomic(&path, &doc.to_string())
}

/// 切回 OAuth：api_key 置空（kimi 以空串表"走 OAuth"，与本机出厂配置一致）；config.toml 缺失时无需处理。
fn clear_kimi_api_key() -> Result<(), String> {
    let path = kimi_config_path()?;
    if !path.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取 config.toml 失败：{e}"))?;
    let mut doc = match text.parse::<toml_edit::DocumentMut>() {
        Ok(d) => d,
        Err(_) => {
            let _ = fs::rename(&path, path.with_extension("bak"));
            return Err("config.toml 解析失败，已备份为 config.toml.bak，请检查".to_string());
        }
    };
    if let Some(provider) = doc
        .get_mut("providers")
        .and_then(|p| p.get_mut(KIMI_PROVIDER))
        .and_then(|t| t.as_table_mut())
    {
        provider.insert("api_key", toml_edit::value(""));
    }
    write_atomic(&path, &doc.to_string())
}

/// 原子落盘（同 lib.rs write_atomic：先写同目录 .tmp 再 rename 覆盖）。
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|e| format!("写入临时文件失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("落盘失败：{e}"))
}

fn preset_view(p: &AccountPreset) -> PresetView {
    let hint = match p.kind {
        PresetKind::Oauth => p
            .oauth_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|v| v.get("access_token").and_then(|t| t.as_str()).map(str::to_string))
            .map(|t| mask_token(&t))
            .unwrap_or_else(|| "••••••••".to_string()),
        PresetKind::Apikey => p
            .api_key
            .as_deref()
            .map(mask_secret)
            .unwrap_or_else(|| "••••••••".to_string()),
    };
    PresetView {
        id: p.id.clone(),
        name: p.name.clone(),
        kind: p.kind.as_str().to_string(),
        updated_at: p.updated_at.clone(),
        hint,
        base_url: p.base_url.clone(),
    }
}

// ---------- 命令实现 ----------

fn ensure_kimi(agent: &str) -> Result<(), String> {
    if agent != "kimi" {
        return Err(format!("agent「{agent}」的账号预设暂未支持（第一期仅 kimi）"));
    }
    Ok(())
}

/// 匹配现场与预设：oauth 比 credentials 原文、apikey 比 api_key 串。
fn match_current(presets: &[AccountPreset], live: &LiveState) -> Option<String> {
    presets
        .iter()
        .find(|p| match (&p.kind, live.mode) {
            (PresetKind::Oauth, "oauth") => {
                p.oauth_json.as_deref().is_some() && p.oauth_json.as_deref() == live.oauth_raw.as_deref()
            }
            (PresetKind::Apikey, "apikey") => {
                p.api_key.as_deref().is_some() && p.api_key.as_deref() == live.api_key.as_deref()
            }
            _ => false,
        })
        .map(|p| p.id.clone())
}

pub fn list(agent: &str) -> Result<ListResult, String> {
    ensure_kimi(agent)?;
    cleanup_orphan_stagings();
    let store = load_store()?;
    let presets = store
        .agents
        .get(agent)
        .map(|a| a.presets.clone())
        .unwrap_or_default();
    let live = detect_live();
    let matched = match_current(&presets, &live);
    let hint = match live.mode {
        "apikey" => live
            .api_key
            .as_deref()
            .map(mask_secret)
            .unwrap_or_else(|| "••••••••".to_string()),
        "oauth" => live
            .oauth_raw
            .as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|v| v.get("access_token").and_then(|t| t.as_str()).map(str::to_string))
            .map(|t| mask_token(&t))
            .unwrap_or_else(|| "••••••••".to_string()),
        _ => String::new(),
    };
    Ok(ListResult {
        presets: presets.iter().map(preset_view).collect(),
        current: CurrentState {
            mode: live.mode.to_string(),
            matched_preset_id: matched,
            hint,
        },
    })
}

/// 新建 / 更新 API Key 预设。id 空 = 新建；更新时 api_key 传空串 = 保持原 key 不变。
pub fn save_apikey(
    agent: &str,
    id: Option<String>,
    name: &str,
    api_key: &str,
    base_url: Option<String>,
) -> Result<(), String> {
    ensure_kimi(agent)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("预设名称不能为空".to_string());
    }
    let base_url = base_url
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    let mut store = load_store()?;
    let entry = store.agents.entry(agent.to_string()).or_default();
    let now = now_rfc3339();
    match id {
        Some(id) => {
            let preset = entry
                .presets
                .iter_mut()
                .find(|p| p.id == id && p.kind == PresetKind::Apikey)
                .ok_or_else(|| "预设不存在".to_string())?;
            preset.name = name.to_string();
            if !api_key.trim().is_empty() {
                preset.api_key = Some(api_key.trim().to_string());
            }
            preset.base_url = base_url;
            preset.updated_at = now;
        }
        None => {
            if api_key.trim().is_empty() {
                return Err("API Key 不能为空".to_string());
            }
            entry.presets.push(AccountPreset {
                id: new_preset_id(),
                name: name.to_string(),
                kind: PresetKind::Apikey,
                created_at: now.clone(),
                updated_at: now,
                oauth_json: None,
                api_key: Some(api_key.trim().to_string()),
                base_url,
            });
        }
    }
    save_store(&store)
}

pub fn rename(agent: &str, id: &str, name: &str) -> Result<(), String> {
    ensure_kimi(agent)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("预设名称不能为空".to_string());
    }
    let mut store = load_store()?;
    let preset = store
        .agents
        .get_mut(agent)
        .and_then(|a| a.presets.iter_mut().find(|p| p.id == id))
        .ok_or_else(|| "预设不存在".to_string())?;
    preset.name = name.to_string();
    preset.updated_at = now_rfc3339();
    save_store(&store)
}

pub fn remove(agent: &str, id: &str) -> Result<(), String> {
    ensure_kimi(agent)?;
    let mut store = load_store()?;
    let entry = store.agents.get_mut(agent).ok_or_else(|| "预设不存在".to_string())?;
    let before = entry.presets.len();
    entry.presets.retain(|p| p.id != id);
    if entry.presets.len() == before {
        return Err("预设不存在".to_string());
    }
    save_store(&store)
}

/// 一键切换（互斥）：
/// 1. 当前 OAuth 匹配某预设 → 用现场最新凭证重快照回该预设（refresh_token 保鲜）；
///    不匹配任何预设 → 自动存「自动快照 <时间>」（不丢账号）。
/// 2. 目标 apikey → 写 config.toml api_key/base_url + 撤下 credentials；
///    目标 oauth → api_key 置空 + 恢复 credentials 快照。
/// 先落盘预设（含自动存档）再写现场 —— 现场写失败也不丢快照。
pub fn apply(agent: &str, id: &str) -> Result<ApplyResult, String> {
    ensure_kimi(agent)?;
    let mut store = load_store()?;
    let entry = store.agents.entry(agent.to_string()).or_default();
    let target = entry
        .presets
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| "预设不存在".to_string())?;
    let live = detect_live();
    if match_current(&entry.presets, &live).as_deref() == Some(id) {
        return Ok(ApplyResult {
            mode: target.kind.as_str().to_string(),
            auto_archived: None,
        });
    }

    let mut auto_archived: Option<String> = None;
    if live.mode == "oauth" {
        if let Some(raw) = live.oauth_raw.as_deref() {
            if let Some(source) = entry
                .presets
                .iter_mut()
                .find(|p| p.kind == PresetKind::Oauth && p.oauth_json.as_deref() == Some(raw))
            {
                // 现场可能被 kimi refresh 覆写过 —— 以现场最新为准重快照
                source.updated_at = now_rfc3339();
            } else {
                let name = format!("自动快照 {}", now_short());
                entry.presets.push(AccountPreset {
                    id: new_preset_id(),
                    name: name.clone(),
                    kind: PresetKind::Oauth,
                    created_at: now_rfc3339(),
                    updated_at: now_rfc3339(),
                    oauth_json: Some(raw.to_string()),
                    api_key: None,
                    base_url: None,
                });
                auto_archived = Some(name);
            }
        }
    }
    save_store(&store)?;

    match target.kind {
        PresetKind::Apikey => {
            let key = target.api_key.as_deref().unwrap_or_default();
            if key.is_empty() {
                return Err("预设缺少 API Key".to_string());
            }
            let base_url = target
                .base_url
                .as_deref()
                .unwrap_or(KIMI_DEFAULT_BASE_URL);
            write_kimi_api_key(key, base_url)?;
            let cred = kimi_credentials_path()?;
            if cred.exists() {
                fs::remove_file(&cred).map_err(|e| format!("撤下当前登录凭证失败：{e}"))?;
            }
        }
        PresetKind::Oauth => {
            let snapshot = target
                .oauth_json
                .as_deref()
                .ok_or_else(|| "预设缺少登录凭证快照".to_string())?;
            clear_kimi_api_key()?;
            write_atomic(&kimi_credentials_path()?, snapshot)?;
        }
    }
    Ok(ApplyResult {
        mode: target.kind.as_str().to_string(),
        auto_archived,
    })
}

// ---------- 隔离登录（KIMI_CODE_HOME staging + kimi login） ----------

#[derive(Debug, Default)]
struct LoginShared {
    url: Option<String>,
    user_code: Option<String>,
}

struct LoginSession {
    name: String,
    staging: PathBuf,
    child: Child,
    shared: Arc<Mutex<LoginShared>>,
}

static LOGINS: OnceLock<Mutex<HashMap<String, LoginSession>>> = OnceLock::new();

fn logins() -> &'static Mutex<HashMap<String, LoginSession>> {
    LOGINS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 清理非活跃登录的 staging 孤儿目录（应用崩溃/强杀残留）。
fn cleanup_orphan_stagings() {
    let active: Vec<PathBuf> = logins()
        .lock()
        .map(|m| m.values().map(|s| s.staging.clone()).collect())
        .unwrap_or_default();
    let Ok(root) = tmp_root() else { return };
    let Ok(entries) = fs::read_dir(&root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_staging = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(LOGIN_STAGING_PREFIX));
        if is_staging && path.is_dir() && !active.contains(&path) {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

/// 启动隔离登录：staging 作 KIMI_CODE_HOME spawn `kimi login`（device-code），
/// stdout 后台行读取解析授权 URL / user_code（仅展示增强；成功判定靠隔离凭证有效，
/// 不依赖进程退出 —— CLI 登录成功后可能挂住不退出）。stdin 置空防子进程等输入挂住。
pub fn login_start(agent: &str, name: &str) -> Result<String, String> {
    ensure_kimi(agent)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("预设名称不能为空".to_string());
    }
    cleanup_orphan_stagings();
    let staging = tmp_root()?.join(format!("{LOGIN_STAGING_PREFIX}{:x}", now_millis()));
    fs::create_dir_all(&staging).map_err(|e| format!("创建登录隔离目录失败：{e}"))?;

    // 通过平台 shell 启动，兼容 Windows 的 .cmd shim 和 macOS 的 Unix PATH。
    let mut child = crate::platform_services::platform_services().agent_command(
        "kimi",
        &["login", "2>&1"],
        &crate::agent_env::fresh_path(),
    )
        .env("KIMI_CODE_HOME", &staging)
        .env("CI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 kimi login 失败（kimi 是否已安装并在 PATH）：{e}"))?;

    let shared = Arc::new(Mutex::new(LoginShared::default()));
    if let Some(stdout) = child.stdout.take() {
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let mut guard = match shared.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                // Opening browser for Kimi device login: <URL>?user_code=XXXX-XXXX
                if guard.url.is_none() {
                    if let Some(rest) = line.strip_prefix("Opening browser") {
                        if let Some(idx) = rest.find("http") {
                            guard.url = Some(rest[idx..].trim().to_string());
                        }
                    }
                }
                // ... paste the URL above and enter code: XXXX-XXXX
                if guard.user_code.is_none() {
                    if let Some(idx) = line.find("enter code:") {
                        guard.user_code = Some(line[idx + "enter code:".len()..].trim().to_string());
                    }
                }
            }
        });
    }

    let handle = format!("login-{:x}", now_millis());
    logins()
        .lock()
        .map_err(|_| "登录会话表锁定失败".to_string())?
        .insert(
            handle.clone(),
            LoginSession {
                name: name.to_string(),
                staging,
                child,
                shared,
            },
        );
    Ok(handle)
}

/// 终止登录进程；Windows 平台实现会额外处理 cmd 子树，避免 staging 文件句柄残留。
fn kill_process_tree(child: &mut Child) {
    crate::platform_services::platform_services().kill_process_tree(child);
}

/// 清理登录隔离目录。调用点须已将会话移出登录表 —— 本函数绝不触碰登录表，
/// 否则调用方持锁时在此重入 logins().lock() 即死锁（std Mutex 不可重入）。
/// 进程句柄释放有延迟（实测需数秒）：后台线程长窗口重试删除（不阻塞调用方），
/// 残留由 cleanup_orphan_stagings 兜底。
fn login_cleanup(session: &LoginSession) {
    let staging = session.staging.clone();
    std::thread::spawn(move || {
        for _ in 0..30 {
            if fs::remove_dir_all(&staging).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}

pub fn login_poll(handle: &str) -> Result<LoginPoll, String> {
    let mut map = logins().lock().map_err(|_| "登录会话表锁定失败".to_string())?;
    let session = map
        .get_mut(handle)
        .ok_or_else(|| "登录会话不存在或已结束".to_string())?;
    let (url, user_code) = session
        .shared
        .lock()
        .map(|s| (s.url.clone(), s.user_code.clone()))
        .unwrap_or((None, None));
    let base = LoginPoll {
        status: String::new(),
        url,
        user_code,
        detail: None,
    };
    let exited = match session.child.try_wait() {
        Ok(v) => v,
        Err(e) => return Err(format!("查询登录进程状态失败：{e}")),
    };

    // 成功主判据：隔离凭证已落盘且含 access_token（授权即完成；
    // 进程仍活着则 kill 收编 —— CLI 登录成功后可能挂住不退出）。
    // 凭证读到一半时 JSON 解析失败按"未就绪"处理，下一票再读。
    let cred_raw = fs::read_to_string(session.staging.join("credentials").join("kimi-code.json"))
        .ok()
        .filter(|raw| {
            serde_json::from_str::<serde_json::Value>(raw)
                .ok()
                .and_then(|v| v.get("access_token").and_then(|t| t.as_str()).map(str::to_string))
                .is_some()
        });
    if let Some(raw) = cred_raw {
        if exited.is_none() {
            kill_process_tree(&mut session.child);
        }
        // 存为 oauth 预设（name 来自 start）
        let mut store = load_store()?;
        let entry = store.agents.entry("kimi".to_string()).or_default();
        let now = now_rfc3339();
        entry.presets.push(AccountPreset {
            id: new_preset_id(),
            name: session.name.clone(),
            kind: PresetKind::Oauth,
            created_at: now.clone(),
            updated_at: now,
            oauth_json: Some(raw),
            api_key: None,
            base_url: None,
        });
        save_store(&store)?;
        let session = map.remove(handle).expect("session 刚取过必在");
        drop(map);
        login_cleanup(&session);
        return Ok(LoginPoll {
            status: "success".to_string(),
            ..base
        });
    }

    // 无有效凭证：进程已退出 → 失败/取消；进程活着 → 继续等
    match exited {
        Some(_) => {
            let session = map.remove(handle).expect("session 刚取过必在");
            drop(map);
            login_cleanup(&session);
            Ok(LoginPoll {
                status: "failed".to_string(),
                detail: Some("kimi login 失败或已取消".to_string()),
                ..base
            })
        }
        None => Ok(LoginPoll {
            status: "waiting".to_string(),
            ..base
        }),
    }
}

pub fn login_cancel(handle: &str) -> Result<(), String> {
    let session = logins()
        .lock()
        .map_err(|_| "登录会话表锁定失败".to_string())?
        .remove(handle);
    if let Some(mut session) = session {
        kill_process_tree(&mut session.child);
        login_cleanup(&session);
    }
    Ok(())
}

// ---------- 导入导出（复用 portable_archive 版本化 ZIP 基建） ----------

const ACCOUNTS_PAYLOAD: &str = "payload/agent-accounts.json";

/// 导出全部预设为 `.htybox-accounts` 包，返回最终文件路径。
pub fn export_package(destination: &str) -> Result<String, String> {
    use crate::portable_archive::{
        write_package, AccountsManifest, ArchiveLimits, PackageKind, PackageSource,
        PortableManifest, ACCOUNTS_EXTENSION, PACKAGE_VERSION,
    };
    let store = load_store()?;
    let preset_count: usize = store.agents.values().map(|a| a.presets.len()).sum();
    let data = serde_json::to_vec_pretty(&store).map_err(|e| e.to_string())?;
    let manifest = PortableManifest::Accounts(AccountsManifest {
        version: PACKAGE_VERSION,
        kind: PackageKind::Accounts,
        exported_at_ms: now_millis() as i64,
        preset_count,
        entries: vec![],
    });
    let result = write_package(
        Path::new(destination),
        ACCOUNTS_EXTENSION,
        manifest,
        vec![PackageSource::Bytes {
            archive_path: ACCOUNTS_PAYLOAD.to_string(),
            data,
        }],
        ArchiveLimits::accounts(),
    )?;
    Ok(result.path.display().to_string())
}

/// 导入 `.htybox-accounts` 包：整包快照替换当前预设，失败原子回滚。返回导入的预设数。
pub fn import_package(source: &str) -> Result<usize, String> {
    use crate::portable_archive::{extract_package, ArchiveLimits, ACCOUNTS_FORMAT};
    let staging = tempfile::Builder::new()
        .prefix("accounts-import-")
        .tempdir_in(tmp_root()?)
        .map_err(|e| format!("创建导入 staging 失败：{e}"))?;
    let extract_to = staging.path().join("extract");
    extract_package(
        Path::new(source),
        &extract_to,
        Some(ACCOUNTS_FORMAT),
        ArchiveLimits::accounts(),
    )?;
    let payload = extract_to.join(ACCOUNTS_PAYLOAD);
    let text = fs::read_to_string(&payload).map_err(|e| format!("包内缺少预设数据：{e}"))?;
    let file = serde_json::from_str::<AccountsFile>(&text)
        .map_err(|e| format!("包内预设数据损坏：{e}"))?;
    if file.version != STORE_VERSION {
        return Err(format!("不支持的预设数据版本：{}", file.version));
    }
    let preset_count: usize = file.agents.values().map(|a| a.presets.len()).sum();

    // 快照替换 + 原子回滚：先备份当前，写失败则恢复
    let store = store_path()?;
    let backup = store.with_extension("import-backup");
    let had_backup = store.exists();
    if had_backup {
        fs::copy(&store, &backup).map_err(|e| format!("备份当前预设失败：{e}"))?;
    }
    let written = save_store(&file);
    match written {
        Ok(()) => {
            if had_backup {
                let _ = fs::remove_file(&backup);
            }
            Ok(preset_count)
        }
        Err(e) => {
            if had_backup {
                let _ = fs::rename(&backup, &store);
            }
            Err(format!("导入落盘失败（已回滚原预设）：{e}"))
        }
    }
}
