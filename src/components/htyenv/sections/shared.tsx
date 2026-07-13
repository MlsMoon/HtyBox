// 工作区环境视图各分类页共享件:分页导航(用户反馈:大数据量分页,不靠长滚动条)、
// 终端选择注入弹窗、只读文档预览弹窗、时间/路径简显工具。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { injectIntoTerminal, listEngines } from "../../terminalEngine";

export const fmtUtc = (utc?: string) =>
  utc && utc.length >= 16 ? utc.slice(5, 16).replace("T", " ") : "-";
export const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
/** 与后端 memory slug 算法一致(App.tsx 同款):把 : \ / _ 全替换成 - */
export const slugify = (p: string) => p.replace(/[:\\/_]/g, "-");

/** 页码条:首末 + 相邻 + 省略号;仅一页时如实不渲染(小数据量免分页)。 */
export function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  const nums = new Set<number>([1, pageCount, page - 1, page, page + 1]);
  const list = [...nums].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const cells: (number | "gap")[] = [];
  list.forEach((n, i) => {
    if (i > 0 && n - list[i - 1] > 1) cells.push("gap");
    cells.push(n);
  });
  return (
    <div className="flex items-center justify-center gap-1 pt-3">
      {cells.map((c, i) =>
        c === "gap" ? (
          <span key={`g${i}`} className="px-1 text-[11px] text-[var(--text-3)]">…</span>
        ) : (
          <button
            key={c}
            onClick={() => onPage(c)}
            className={
              "min-w-7 rounded-md px-2 py-1 text-[11px] transition-colors " +
              (c === page
                ? "border border-[var(--accent-border)] bg-[var(--accent-soft)] font-semibold text-[var(--accent-text)]"
                : "border border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--elevated)]")
            }
          >
            {c}
          </button>
        ),
      )}
    </div>
  );
}

/** 选择本工作区活跃终端并注入文本;无活跃终端时如实提示 + 提供复制。 */
export function InjectModal({
  wsId,
  text,
  title,
  onClose,
}: {
  wsId: string;
  text: string;
  title: string;
  onClose: () => void;
}) {
  const [terms] = useState(() => listEngines(wsId + "::"));
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="flex max-h-[76vh] w-[560px] max-w-[92vw] flex-col rounded-2xl bg-[var(--elevated)] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 text-sm font-semibold text-[var(--text)]">{title}</div>
        <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--surface)] p-3 text-[11px] leading-relaxed text-[var(--text-2)]">
          {text}
        </pre>
        {error && <div className="mt-2 break-all text-[11px] text-[var(--danger)]">{error}</div>}
        <div className="mt-3">
          {terms.length === 0 ? (
            <div className="text-[11px] text-[var(--text-3)]">
              该工作区当前没有运行中的终端——复制文本后切回正常工作模式粘贴,或先开一个终端再来注入。
            </div>
          ) : (
            <>
              <div className="mb-1.5 text-[11px] text-[var(--text-3)]">注入到哪个终端:</div>
              <div className="max-h-40 space-y-0.5 overflow-y-auto">
                {terms.map((t) => (
                  <button
                    key={t.termId}
                    onClick={() =>
                      injectIntoTerminal(t.termId, text)
                        .then(onClose)
                        .catch((e) => setError(String(e)))
                    }
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-[var(--surface)]"
                  >
                    <span className="rounded bg-[var(--surface-hover)] px-1.5 py-px text-[10px] text-[var(--text-2)]">
                      {t.agentKind ?? "shell"}
                    </span>
                    <span className="truncate font-mono text-[10px] text-[var(--text-3)]">{t.termId}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={() =>
              navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false))
            }
            className="rounded-md border border-[var(--accent-border)] px-3 py-1 text-[12px] text-[var(--accent-text)] hover:bg-[var(--accent-soft)]"
          >
            {copied ? "已复制" : "复制"}
          </button>
          <button onClick={onClose} className="rounded-md px-3 py-1 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface)]">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** 只读文档预览(read_text_file 复用;失败如实展示)。 */
export function PreviewModal({ path, onClose }: { path: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    invoke<{ content: string }>("read_text_file", { path })
      .then((r) => alive && setText(r.content))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [path]);
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="flex h-[78vh] w-[760px] max-w-[94vw] flex-col rounded-2xl bg-[var(--elevated)] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 truncate font-mono text-[11px] text-[var(--text-3)]" title={path}>{path}</div>
        {error ? (
          <div className="break-all text-[11px] text-[var(--danger)]">{error}</div>
        ) : text === null ? (
          <div className="py-6 text-center text-xs text-[var(--text-3)]">读取中…</div>
        ) : (
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--surface)] p-3 text-[11.5px] leading-relaxed text-[var(--text-2)]">
            {text}
          </pre>
        )}
        <div className="mt-3 flex justify-end">
          <button onClick={onClose} className="rounded-md px-3 py-1 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface)]">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
