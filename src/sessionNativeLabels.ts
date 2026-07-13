// Agent 会话的「原生显示名」缓存（claude ai-title / codex thread_name|首句 / cursor title）。
// 与 sessionTitles（用户手动重命名）分离：Tab 与 Session 列表同构权威 =
//   getSessionTitle(自定义) → getNativeSessionLabel(原生) →（无 sid 时才回退 OSC body）。
// 由 SessionPanel 在 list 加载成功后写入；codex watcher 静默重拉也会更新。

const EVT = "htybox:session-native-labels";

const labelKey = (agentKind: string, sessionId: string) => `${agentKind}:${sessionId}`;

const store: Record<string, string> = {};

/** 批量写入某 agent 当前列表的原生 label（覆盖该次 list 中出现的 id）。 */
export function setNativeSessionLabels(
  agentKind: string,
  entries: ReadonlyArray<{ id: string; label: string }>,
): void {
  let changed = false;
  for (const { id, label } of entries) {
    if (!id) continue;
    const k = labelKey(agentKind, id);
    const t = (label ?? "").trim();
    if (!t) {
      if (k in store) {
        delete store[k];
        changed = true;
      }
      continue;
    }
    if (store[k] !== t) {
      store[k] = t;
      changed = true;
    }
  }
  if (changed) window.dispatchEvent(new Event(EVT));
}

/** 取某会话原生 label；无则空串。 */
export function getNativeSessionLabel(agentKind: string, sessionId: string): string {
  if (!sessionId) return "";
  return store[labelKey(agentKind, sessionId)] || "";
}

/** 订阅原生 label 变化（终端 Tab 用于实时刷新）。返回取消函数。 */
export function onNativeSessionLabelsChange(fn: () => void): () => void {
  window.addEventListener(EVT, fn);
  return () => window.removeEventListener(EVT, fn);
}
