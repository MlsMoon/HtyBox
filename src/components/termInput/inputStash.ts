import { useEffect, useRef } from "react";

/**
 * 跟踪 Left Ctrl 是否按下（keydown 落在字母键时 e.location 是字母而非 Ctrl，
 * 故需独立监听 ControlLeft）。
 */
export function useLeftCtrlHeld(): { current: boolean } {
  const held = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "ControlLeft") held.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "ControlLeft" || e.key === "Control") held.current = false;
    };
    const reset = () => {
      held.current = false;
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", reset);
    };
  }, []);
  return held;
}

export type StashMap = Record<string, string>;

/**
 * Left Ctrl+S：暂存并清空 / 再按恢复（对齐 Claude Code）。
 * Left Ctrl+Space：清空当前输入（不碰暂存）。
 * 返回 true = 已处理。
 */
export function handleInputStashKey(
  e: React.KeyboardEvent,
  leftCtrl: boolean,
  fieldId: string,
  text: string,
  stash: StashMap,
  setText: (t: string) => void,
): boolean {
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !leftCtrl) return false;
  const k = e.key;

  if (k === "s" || k === "S") {
    e.preventDefault();
    if (fieldId in stash) {
      // 再按：恢复记忆，清除暂存槽
      const saved = stash[fieldId]!;
      delete stash[fieldId];
      setText(saved);
    } else {
      // 首按：记忆当前并清空
      stash[fieldId] = text;
      setText("");
    }
    return true;
  }

  if (e.code === "Space") {
    e.preventDefault();
    setText("");
    return true;
  }

  return false;
}

/** 发送成功后取出暂存并清空槽；无暂存返回 null。 */
export function takeStash(stash: StashMap, fieldId: string): string | null {
  if (!(fieldId in stash)) return null;
  const v = stash[fieldId]!;
  delete stash[fieldId];
  return v;
}
