// 主窗 ⇄ 内容预览窗口的通信契约（纯常量与类型，无副作用）。
// 两侧各自 import 本模块：主窗侧状态机在 previewWindow.ts，预览窗侧在 components/PreviewApp.tsx。
// 单独成文件是为了让预览窗不必拖进主窗那套窗口状态机。

/** 主窗 → 预览窗：打开这个文件 */
export const EV_OPEN_FILE = "preview:open-file";
/** 主窗 → 预览窗：接管这批编辑器（含未保存内容） */
export const EV_ADOPT = "preview:adopt";
/** 预览窗 → 主窗：我已就绪，可以推送 */
export const EV_READY = "preview:ready";
/** 预览窗 → 主窗：用户主动关闭了我 */
export const EV_CLOSED = "preview:closed";

/** 迁移 / 复原一个编辑器所需的最小信息（未保存内容随行，不落盘）。 */
export interface AdoptItem {
  path: string;
  /** 有未保存改动时随行的缓冲内容；干净的编辑器不带，由预览窗自行读盘 */
  content?: string;
}
