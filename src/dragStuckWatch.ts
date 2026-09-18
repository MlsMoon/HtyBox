/**
 * 拖拽卡死判定(纯逻辑,Node 可测;接线见 dragStuckRecovery.ts)。
 *
 * 背景:偶发地,系统拖拽会话结束不了——鼠标已松开却仍被它独占,于是点击任何地方都无效
 * (终端照常输出,因为渲染与宿主线程都活着)。会话在 WebView2 内部,HtyBox 只能检测并打断。
 *
 * 判定要两条证据同时成立,缺一不可:
 *  ① 页面仍在收到拖拽事件 —— 「会话确实还活着」(该状态下只有拖拽类事件还会派发);由调用侧保证:
 *     只在拖拽事件里采样。
 *  ② 鼠标主键已物理松开且持续 stuckMs —— 「用户已经放手」;由调用侧从系统查询后传入。
 * 只有 ② 会在「dragend 丢失」时误判(会话其实早已结束),届时注入 Esc 会打断终端里正在跑的回合;
 * 只有 ① 无法区分正常长拖拽。两条合一才是「会话活着但用户已放手」= 卡死。
 */

/** 本次采样应采取的动作:注入 Esc 取消 / 提示用户手按 Esc / 无动作。 */
export type StuckAction = "none" | "cancel" | "prompt";

export interface DragStuckWatch {
  /** 一次采样:主键是否按下 + 当前时刻(ms);返回应采取的动作。 */
  sample(buttonDown: boolean, now: number): StuckAction;
  /** 拖拽开始/结束(dragstart / drop / dragend)时复位。 */
  reset(): void;
}

/**
 * @param stuckMs 主键持续松开多久判定卡死(正常拖拽松手后会话在毫秒级结束)
 * @param promptAfterEscMs 注入 Esc 后仍卡死多久 → 认定注入无效,转显式提示
 */
export function createDragStuckWatch(
  stuckMs = 1000,
  promptAfterEscMs = 1000,
): DragStuckWatch {
  let upSince: number | undefined; // 主键持续松开的起点
  let escAt: number | undefined; // 已注入 Esc 的时刻
  let prompted = false;
  return {
    sample(buttonDown, now) {
      if (buttonDown) {
        upSince = undefined; // 仍按着 = 正常拖拽
        return "none";
      }
      if (upSince === undefined) upSince = now;
      if (now - upSince < stuckMs) return "none";
      if (escAt === undefined) {
        escAt = now;
        return "cancel";
      }
      if (!prompted && now - escAt >= promptAfterEscMs) {
        prompted = true;
        return "prompt"; // 注入没解开 → 让用户自己按 Esc
      }
      return "none";
    },
    reset() {
      upSince = undefined;
      escAt = undefined;
      prompted = false;
    },
  };
}
