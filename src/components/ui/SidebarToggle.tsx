import { useCallback, useRef, useState } from "react";

/** 侧栏开关图标（PanelLeft 风格：open 时左栏格填实）。
 *  主窗左上角与内容预览窗口标题栏共用同一份，避免两处各画一个、观感不一致。
 *
 *  两态的区分必须一眼看出：图标只有 16px、左格实际不到 4px 宽，
 *  此前用 opacity 0.22 的 currentColor 填充等于没有（用户实测"一直是一个状态"），
 *  故改为接近实心；`currentColor` 保证浅色/深色主题下都跟随文字色可见。 */
export function SidebarToggleIcon({ open }: { open: boolean }) {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {open && <rect x="4" y="5" width="4" height="14" fill="currentColor" stroke="none" opacity="0.85" rx="0.8" />}
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );
}

/** 收起/展开的过渡时长，与 index.css `.htybox-sidebar-anim` 的 transition 对应。 */
const ANIM_MS = 280;

/**
 * 侧栏显隐 + 收放动画，主窗与内容预览窗口共用同一手感。
 *
 * 动画不是常挂的：`.htybox-sidebar-anim` 只在切换后的 {@link ANIM_MS} 内加到容器上，
 * 让 allotment 的 view 过渡 left/width；**拖分隔条时不挂**，否则拖拽会有迟滞。
 *
 * @param initial 初始可见性（惰性求值，通常从按工作区的持久化里读）
 * @param persist 可见性变化时落盘（主窗按活动工作区、预览窗按自身工作区）
 */
export function useSidebarToggle(initial: boolean | (() => boolean), persist: (visible: boolean) => void) {
  const [visible, setVisible] = useState(initial);
  const [animating, setAnimating] = useState(false);
  const persistRef = useRef(persist);
  persistRef.current = persist;

  /** 点按钮：切换 + 落盘 + 放一次过渡动画。 */
  const toggle = useCallback(() => {
    setAnimating(true);
    setVisible((v) => {
      const next = !v;
      persistRef.current(next);
      return next;
    });
    window.setTimeout(() => setAnimating(false), ANIM_MS);
  }, []);

  /** 拖分隔条到最小/拉开导致的显隐变化：同步并落盘，但不放动画（用户手正拖着）。 */
  const syncFromDrag = useCallback((v: boolean) => {
    setVisible(v);
    persistRef.current(v);
  }, []);

  return {
    visible,
    /** 拼到分栏容器 className 上（过渡期间才非空） */
    animClass: animating ? " htybox-sidebar-anim" : "",
    toggle,
    syncFromDrag,
    /** 外部原因直接设值（如切工作区读回该工作区的记忆），不落盘、不放动画 */
    setVisible,
  };
}
