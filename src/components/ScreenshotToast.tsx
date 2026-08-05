import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * 全局截图成功提示：右上角非模态「已复制」，约 1.8s 自消。
 * 后端仅在触发瞬间主窗可见且聚焦时 emit；取消 / 后台截成不会到这里。
 */
export default function ScreenshotToast() {
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (text: string) => {
      setMsg(text);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 1800);
    };
    const u1 = listen("screenshot-copied", () => show("已复制"));
    const u2 = listen("screenshot-hotkey-failed", () =>
      show("截图快捷键注册失败（可能被占用）"),
    );
    return () => {
      if (timer) clearTimeout(timer);
      void u1.then((f) => f());
      void u2.then((f) => f());
    };
  }, []);

  if (!msg) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-14 z-[90] flex w-72 flex-col gap-2">
      <div
        className="flex items-center gap-2 rounded-lg border border-[var(--accent-border)] bg-[var(--elevated)] px-3 py-2 shadow-lg"
        role="status"
        aria-live="polite"
      >
        <span className="text-xs text-[var(--text-2)]">{msg}</span>
      </div>
    </div>
  );
}
