import { useRef } from "react";

/** 遮罩"点击外部关闭"统一判定:mousedown 与 mouseup 都落在遮罩自身才触发 onDismiss。
 *  修「弹窗内按住拖到窗口外松开被误关」—— Chromium 对 down/up 目标不同的点击,把 click
 *  派发到两者最近公共祖先(父子遮罩结构下 = 遮罩本身),内容层 stopPropagation 不在事件
 *  路径上、拦不住;故弃用 click,改 mouseup 双条件判定。顺带收获"遮罩按下、拖回弹窗内
 *  松开 = 反悔不关"。新弹窗遮罩一律 {...useMaskDismiss(onClose)},勿再直挂 onClick。 */
export function useMaskDismiss(onDismiss: () => void) {
  const downOnMask = useRef(false);
  return {
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      downOnMask.current = e.target === e.currentTarget;
    },
    onMouseUp: (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const fire = downOnMask.current && e.target === e.currentTarget;
      downOnMask.current = false;
      if (fire) onDismiss();
    },
  };
}
