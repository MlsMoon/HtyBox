import { useEffect, useRef } from "react";

/** 双击 Shift（320ms 内连按两次、忽略长按重复）触发。
 *  主窗与内容预览窗口共用同一实现，保证两个窗口唤起全局文件搜索的手感完全一致。 */
export function useDoubleShift(onTrigger: () => void): void {
  const cb = useRef(onTrigger);
  cb.current = onTrigger;
  useEffect(() => {
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Shift") {
        last = 0; // 中间夹了别的键 → 不算连击
        return;
      }
      if (e.repeat) return;
      const now = Date.now();
      if (now - last < 320) {
        last = 0;
        cb.current();
      } else {
        last = now;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
