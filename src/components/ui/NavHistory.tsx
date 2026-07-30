import { useCallback, useRef, useState } from "react";

/** 历史栈上限。够覆盖一次阅读会话的来回跳转，又不让长期开着的窗口无界增长。 */
const MAX = 50;

/** 后退 / 前进箭头。用「横线 + 尖」而非纯 chevron —— 后者在本项目里是折叠/展开语义。 */
function NavArrowIcon({ dir }: { dir: "back" | "forward" }) {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      {dir === "back" ? <path d="M19 12H6M12 5l-7 7 7 7" /> : <path d="M5 12h13M12 5l7 7-7 7" />}
    </svg>
  );
}

/**
 * 游标式导航历史（与浏览器 / Rider 同语义），供内容预览窗口的前进 / 后退使用。
 *
 * 只管「谁被激活过」这一件事：滚动位置由 DockEditor 自己闭环记忆，本 hook 不感知，
 * 故任何 tab 切换都受益于位置记忆，历史栈也不必理解内容渲染时机。
 *
 * @param navigate 把游标指向的文件真正激活（面板已关则由调用方重开）。用 ref 存，
 *                 调用方不必为它做 useCallback 稳定化。
 */
export function useNavHistory(navigate: (path: string) => void) {
  const stackRef = useRef<string[]>([]);
  /** 当前所在条目下标；-1 = 栈空 */
  const cursorRef = useRef(-1);
  /** >0 表示正处在「导航自身引发的激活」窗口内，此间的激活变化不入栈 */
  const suppressRef = useRef(0);
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);

  const sync = useCallback(() => {
    setCanBack(cursorRef.current > 0);
    setCanForward(cursorRef.current >= 0 && cursorRef.current < stackRef.current.length - 1);
  }, []);

  /**
   * 抑制窗口：某些激活变化不该入栈——导航自身触发的 setActive / addPanel，
   * 以及关闭 tab 时 dockview 自动激活邻居（关闭是销毁不是导航）。
   *
   * dockview 同步派发 onDidActivePanelChange，但重开面板的激活可能落在后续微任务，
   * 故同步段结束后再排空一轮微任务才解除。不传 fn 即"只开一个覆盖本同步段的窗口"，
   * 供无可包裹目标的场景（如从 onWillMutateLayout 得知即将移除面板）使用。
   */
  const suppress = useCallback((fn?: () => void) => {
    suppressRef.current += 1;
    try {
      fn?.();
    } finally {
      void Promise.resolve().then(() => {
        suppressRef.current -= 1;
      });
    }
  }, []);

  /** 记一次导航。与当前条目同路径则忽略；游标不在末尾时截断右侧的前进分支（浏览器语义）。 */
  const record = useCallback(
    (path: string) => {
      if (suppressRef.current > 0) return;
      const stack = stackRef.current;
      if (stack[cursorRef.current] === path) return;
      stack.splice(cursorRef.current + 1);
      stack.push(path);
      if (stack.length > MAX) stack.shift();
      cursorRef.current = stack.length - 1;
      sync();
    },
    [sync],
  );

  const go = useCallback(
    (delta: number) => {
      const next = cursorRef.current + delta;
      const path = stackRef.current[next];
      if (path === undefined) return;
      cursorRef.current = next;
      sync();
      suppress(() => navRef.current(path));
    },
    [sync, suppress],
  );

  const back = useCallback(() => go(-1), [go]);
  const forward = useCallback(() => go(1), [go]);

  /**
   * 把历史压成「只有这一条」（或清空）。
   *
   * 供**恢复现场**的批量打开使用：复原上次的一批 Tab、接管主窗移交的一批编辑器，都会连续
   * 建面板并逐个短暂激活，若照常入栈，一开窗就能后退到那批文件里去——但用户并没有"一个个
   * 点开它们"，那是现场被一次性摆好，不是导航轨迹。压成当前停留的一条，后退按钮才如实置灰。
   */
  const reset = useCallback(
    (path?: string) => {
      stackRef.current = path ? [path] : [];
      cursorRef.current = path ? 0 : -1;
      sync();
    },
    [sync],
  );

  return { canBack, canForward, record, back, forward, suppress, reset };
}

function NavButton({ dir, enabled, onClick }: { dir: "back" | "forward"; enabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={!enabled}
      title={dir === "back" ? "后退（Alt+←）" : "前进（Alt+→）"}
      className={
        "flex h-full w-8 shrink-0 items-center justify-center transition-colors " +
        (enabled
          ? "text-[var(--text-2)] hover:bg-[var(--elevated)] hover:text-[var(--text)]"
          : "cursor-default text-[var(--text-3)] opacity-45")
      }
    >
      <NavArrowIcon dir={dir} />
    </button>
  );
}

/** 标题栏里的后退 / 前进按钮组，自带左右细分隔线把自己与相邻区块分开。 */
export function NavHistoryButtons(props: {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  return (
    <>
      <div className="my-2.5 w-px shrink-0 bg-[var(--border)]" />
      <NavButton dir="back" enabled={props.canBack} onClick={props.onBack} />
      <NavButton dir="forward" enabled={props.canForward} onClick={props.onForward} />
      <div className="my-2.5 w-px shrink-0 bg-[var(--border)]" />
    </>
  );
}
