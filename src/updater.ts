import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// 记住被「跳过」的版本号：同一版本不再自动弹窗（但左上角标仍提示，可手动触发）
const SKIP_KEY = "htybox.update.skipped";

export function getSkippedVersion(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

export function setSkippedVersion(v: string | null): void {
  try {
    if (v) localStorage.setItem(SKIP_KEY, v);
    else localStorage.removeItem(SKIP_KEY);
  } catch {
    /* ignore */
  }
}

/** 主动检查的三态结果：发现新版本 / 已是最新 / 检查失败（离线、端点不可达等）。 */
export type UpdateCheckResult =
  | { status: "update"; update: Update }
  | { status: "none" }
  | { status: "error"; message: string };

/** 三态检查更新（设置界面「立即检查」用）：区分"没有新版"与"没查着"。 */
export async function checkForUpdateDetailed(timeoutMs = 15000): Promise<UpdateCheckResult> {
  try {
    const u = await check({ timeout: timeoutMs });
    return u ? { status: "update", update: u } : { status: "none" };
  } catch (e) {
    return { status: "error", message: String(e) };
  }
}

/** 检查更新：有可用更新返回 Update，无更新 / 端点不可达 / 出错一律返回 null（启动静默检查用，不打扰用户）。 */
export async function checkForUpdate(): Promise<Update | null> {
  const r = await checkForUpdateDetailed();
  return r.status === "update" ? r.update : null;
}

export { relaunch };
export type { Update };
