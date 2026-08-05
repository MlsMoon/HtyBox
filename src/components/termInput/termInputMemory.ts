// 终端内置输入草稿记忆：按 termId 持久化（localStorage）。
// 应用/工作区关闭复原后仍在；仅用户关闭该终端面板时清空。
import type { StashMap } from "./inputStash";

export type TermInputMemory = {
  draft: string;
  attachments: string[];
  segInputs: Record<string, { text: string; atts: string[] }>;
  stash: StashMap;
};

const KEY = "htybox.termInputMemory.v1";

const EMPTY: TermInputMemory = {
  draft: "",
  attachments: [],
  segInputs: {},
  stash: {},
};

function isEmpty(m: TermInputMemory): boolean {
  return (
    !m.draft &&
    m.attachments.length === 0 &&
    Object.keys(m.segInputs).length === 0 &&
    Object.keys(m.stash).length === 0
  );
}

function clone(m: TermInputMemory): TermInputMemory {
  return {
    draft: m.draft,
    attachments: [...m.attachments],
    segInputs: Object.fromEntries(
      Object.entries(m.segInputs).map(([k, v]) => [k, { text: v.text, atts: [...v.atts] }]),
    ),
    stash: { ...m.stash },
  };
}

function load(): Record<string, TermInputMemory> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, unknown>;
    const out: Record<string, TermInputMemory> = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [tid, v] of Object.entries(raw)) {
      if (!v || typeof v !== "object") continue;
      const o = v as Partial<TermInputMemory>;
      out[tid] = {
        draft: typeof o.draft === "string" ? o.draft : "",
        attachments: Array.isArray(o.attachments)
          ? o.attachments.filter((x): x is string => typeof x === "string")
          : [],
        segInputs:
          o.segInputs && typeof o.segInputs === "object"
            ? Object.fromEntries(
                Object.entries(o.segInputs).map(([k, seg]) => {
                  const s = seg as { text?: unknown; atts?: unknown };
                  return [
                    k,
                    {
                      text: typeof s?.text === "string" ? s.text : "",
                      atts: Array.isArray(s?.atts)
                        ? s.atts.filter((x): x is string => typeof x === "string")
                        : [],
                    },
                  ];
                }),
              )
            : {},
        stash:
          o.stash && typeof o.stash === "object"
            ? Object.fromEntries(
                Object.entries(o.stash).filter(
                  (e): e is [string, string] => typeof e[1] === "string",
                ),
              )
            : {},
      };
    }
    return out;
  } catch {
    return {};
  }
}

let store: Record<string, TermInputMemory> = load();
/** 本会话内已关闭的 termId：挡住卸载瞬间的最后一次落盘写回。 */
const closed = new Set<string>();

function commit(termId: string, mem: TermInputMemory | undefined): void {
  const next = { ...store };
  if (mem && !isEmpty(mem)) next[termId] = clone(mem);
  else delete next[termId];
  store = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}

export function getTermInputMemory(termId: string): TermInputMemory {
  const m = store[termId];
  return m ? clone(m) : clone(EMPTY);
}

/** 写入草稿；全空则删除该终端条目。 */
export function setTermInputMemory(termId: string, mem: TermInputMemory): void {
  if (closed.has(termId)) return;
  commit(termId, mem);
}

/** 终端面板关闭时调用（工作区整体关闭复原路径不要调）。 */
export function clearTermInputMemory(termId: string): void {
  closed.add(termId);
  commit(termId, undefined);
}
