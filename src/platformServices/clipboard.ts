import { invoke, isTauri } from "@tauri-apps/api/core";

/** 系统文本剪贴板统一入口：桌面包走平台层，浏览器开发环境回退 Web Clipboard API。 */
export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) {
    return invoke<void>("write_clipboard_text", { text });
  }
  if (!navigator.clipboard?.writeText) throw new Error("浏览器不支持写入剪贴板");
  return navigator.clipboard.writeText(text);
}

export async function readClipboardText(): Promise<string> {
  if (isTauri()) {
    return invoke<string>("read_clipboard_text");
  }
  if (!navigator.clipboard?.readText) throw new Error("浏览器不支持读取剪贴板");
  return navigator.clipboard.readText();
}
