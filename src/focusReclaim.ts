/**
 * 终端焦点归位判定(纯逻辑,Node 可测)。
 *
 * 背景:xterm 的键盘输入依赖其 helper textarea 持有 DOM 焦点;但点已激活标签、
 * 标签栏/面板死区、弹层遮罩外点或弹层按钮关闭后,焦点会静默落到 body,从此键盘全灭
 * (终端画面正常但打不了字)。本判定决定「这次 pointerdown 之后是否应把焦点还给活动终端」。
 *
 * 规则(任一不满足即不归位):
 *  - tabSelectable=开:该模式语义就是键盘归 UI(标签),归位会破坏 Delete 关标签;
 *  - 判定时刻焦点必须「未落在有意义目标上」(body/html,或 dockview chrome 容器——它们带
 *    tabindex 但不是输入目标;由调用侧的 focusIsBody 判定,标签内的重命名输入框是硬控件不算);
 *  - 目标仍连接:必须在 dock 容器内且不是可交互控件(不抢用户有意的焦点转移);
 *  - 目标已卸载:仅当它属于弹层(遮罩外点关弹层 / 弹层按钮关闭),弹层是终端相邻的瞬态交互。
 */

/** 结构化最小元素接口:真 Element 天然满足,测试可用桩实现(免 DOM)。 */
export interface ElLike {
  closest(selector: string): ElLike | null;
  readonly isConnected: boolean;
}

export interface FocusReclaimInput {
  /** pointerdown 目标(判定时刻可能已随弹层卸载) */
  target: ElLike | null;
  /** pointerdown 时刻目标是否在 dock 容器内(卸载后无法再判,须提前记录) */
  targetWasInScope: boolean;
  /** 判定时刻焦点是否「未落在有意义目标上」(body/html/dockview 标签——标签 tabindex=0 会吃焦点) */
  focusIsBody: boolean;
  tabSelectable: boolean;
}

export const HARD_CONTROL_SELECTOR = "input,textarea,button,select,a,[contenteditable]";
const OVERLAY_SELECTOR = "[data-hty-overlay]";

export function shouldReclaimFocus(i: FocusReclaimInput): boolean {
  if (i.tabSelectable || !i.focusIsBody || !i.target) return false;
  if (!i.target.isConnected) return i.target.closest(OVERLAY_SELECTOR) !== null;
  // 硬控件(含标签内的重命名输入框等):用户有意的焦点目标,不抢。
  // dockview 标签/分组/标签栏等 chrome 容器虽带 tabindex,但不是输入目标——焦点落上面=流落,归位;
  // 编辑器面板的保护由调用侧「活动面板无 termId 则不动作」承担,不在本函数重复。
  return i.targetWasInScope && !i.target.closest(HARD_CONTROL_SELECTOR);
}
