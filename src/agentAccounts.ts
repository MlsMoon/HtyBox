// Agent 账号 / API Key 预设（cc-switch 式）前端封装 —— 类型对齐 src-tauri/agent_accounts.rs。
// 明文密钥不出 Rust：list 返回的是掩码视图；新建/更新把 key 交给 Rust 落盘。
import { invoke } from "@tauri-apps/api/core";

export type PresetKind = "oauth" | "apikey";

export interface PresetView {
  id: string;
  name: string;
  kind: PresetKind;
  updatedAt: string;
  /** 掩码提示（oauth=token 前 8 位；apikey=前 4+末 4 掩码） */
  hint: string;
  baseUrl?: string;
}

export interface CurrentState {
  mode: PresetKind | "none";
  matchedPresetId?: string;
  hint: string;
}

export interface ListResult {
  presets: PresetView[];
  current: CurrentState;
}

export interface ApplyResult {
  mode: PresetKind;
  /** 切换前自动存档的「自动快照」预设名（当前登录未匹配任何预设时产生） */
  autoArchived?: string;
}

export interface LoginPoll {
  status: "waiting" | "success" | "failed";
  url?: string;
  userCode?: string;
  detail?: string;
}

export const listAccounts = (agent: string): Promise<ListResult> =>
  invoke<ListResult>("agent_accounts_list", { agent });

/** 新建 / 更新 API Key 预设。id=null 新建；更新时 apiKey 传 "" = 保持原 key。 */
export const saveApikeyPreset = (
  agent: string,
  id: string | null,
  name: string,
  apiKey: string,
  baseUrl: string | null,
): Promise<void> =>
  invoke("agent_accounts_save_apikey", { agent, id, name, apiKey, baseUrl });

export const renamePreset = (agent: string, id: string, name: string): Promise<void> =>
  invoke("agent_accounts_rename", { agent, id, name });

export const removePreset = (agent: string, id: string): Promise<void> =>
  invoke("agent_accounts_remove", { agent, id });

export const applyPreset = (agent: string, id: string): Promise<ApplyResult> =>
  invoke<ApplyResult>("agent_accounts_apply", { agent, id });

/** 启动隔离登录（device-code），返回轮询句柄。 */
export const loginStart = (agent: string, name: string): Promise<string> =>
  invoke<string>("agent_accounts_login_start", { agent, name });

export const loginCancel = (handle: string): Promise<void> =>
  invoke("agent_accounts_login_cancel", { handle });

/** 导出全部预设为 .htybox-accounts 包，返回最终文件路径。 */
export const exportAccounts = (destination: string): Promise<string> =>
  invoke<string>("agent_accounts_export", { destination });

/** 导入 .htybox-accounts 包（快照替换当前全部预设），返回导入的预设数。 */
export const importAccounts = (source: string): Promise<number> =>
  invoke<number>("agent_accounts_import", { source });

/** 1s 轮询登录直到 success / failed；每票经 onTick 透出（拿到 url/userCode 后即可展示）。 */
export async function loginWait(
  handle: string,
  onTick: (p: LoginPoll) => void,
): Promise<LoginPoll> {
  for (;;) {
    const p = await invoke<LoginPoll>("agent_accounts_login_poll", { handle });
    onTick(p);
    if (p.status !== "waiting") return p;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
