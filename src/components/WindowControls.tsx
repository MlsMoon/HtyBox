import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const win = getCurrentWindow();

/** 自绘窗口控制（最小化 / 最大化-还原 / 关闭）——配合 decorations:false 的无边框窗口。
 *  扁平 Win 风格按钮、贴右上角；关闭悬停红。父容器的空白区用 data-tauri-drag-region 拖动。 */
export default function WindowControls() {
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    let un: (() => void) | undefined;
    const sync = () => win.isMaximized().then(setMaxed).catch(() => {});
    sync();
    win
      .onResized(sync)
      .then((u) => {
        un = u;
      })
      .catch(() => {});
    return () => un?.();
  }, []);

  const btn =
    "flex h-full w-[46px] items-center justify-center text-[var(--text-2)] transition-colors";

  return (
    <div className="flex h-full shrink-0 items-stretch self-stretch">
      <button
        onClick={() => win.minimize()}
        title="最小化"
        className={btn + " hover:bg-[var(--border-soft)] hover:text-[var(--text)]"}
      >
        <svg className="h-2.5 w-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1">
          <path d="M0.5 5h9" />
        </svg>
      </button>
      <button
        onClick={() => win.toggleMaximize()}
        title={maxed ? "还原" : "最大化"}
        className={btn + " hover:bg-[var(--border-soft)] hover:text-[var(--text)]"}
      >
        {maxed ? (
          <svg className="h-2.5 w-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1">
            <rect x="0.75" y="2.75" width="6.5" height="6.5" rx="0.5" />
            <path d="M2.75 2.75V0.75h6.5v6.5h-2" />
          </svg>
        ) : (
          <svg className="h-2.5 w-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1">
            <rect x="0.75" y="0.75" width="8.5" height="8.5" rx="0.5" />
          </svg>
        )}
      </button>
      <button
        onClick={() => win.close()}
        title="关闭"
        className={btn + " hover:bg-[var(--danger)] hover:text-white"}
      >
        <svg className="h-2.5 w-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1">
          <path d="M1 1l8 8M9 1l-8 8" />
        </svg>
      </button>
    </div>
  );
}
