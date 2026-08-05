// plan-3：等高行只读预览——纯文本与代码共用同一条渲染管线（唯一区别 lang 是否为 null）。
// 数据源双模式：content 给定（≤ 编辑上限的常规文件）→ 内存源；undefined（超编辑上限的
// 大文件，Buf.viewable）→ plan-1 分片句柄。高亮按视口分块计算（chunkHighlight），未就绪
// 先显示无高亮文本；任何阶段内容先可读，不因高亮阻塞或留白。
import { useEffect, useMemo, useRef, useState } from "react";
import { VirtualLines } from "./ui/VirtualLines";
import { chunkedLineSource, memoryLineSource, type LineSource } from "../lineSource";
import { createChunkHighlighter } from "../chunkHighlight";
import { isDocInvalidError, openTextDocument } from "../catalog";
import { getSettings } from "../settings";

interface LinePreviewProps {
  path: string;
  /** 已在内存的内容；undefined = 大文件走分片句柄（openTextDocument）。 */
  content?: string;
  /** shiki 语言 id（langForPath 取）；null = 纯文本无高亮。 */
  lang: string | null;
  /** 阅读位置初始值（决策 4 = C：line 优先，换字体仍回同一行）。 */
  initial?: { top: number; line?: number };
  /** 滚动上报（调用方写 scrollStore）。 */
  onScrollState?: (top: number, line: number) => void;
}

type DocState =
  | { kind: "loading" }
  | { kind: "ready"; source: LineSource }
  | { kind: "error"; message: string };

export default function LinePreview({
  path,
  content,
  lang,
  initial,
  onScrollState,
}: LinePreviewProps) {
  const [doc, setDoc] = useState<DocState>({ kind: "loading" });
  // 句柄失效（外部修改/被 LRU 回收）→ 自动重新 open（对齐决策 3 = A 的前端半边）；500ms 防抖
  const [reopenTick, setReopenTick] = useState(0);
  const lastReopenRef = useRef(0);

  useEffect(() => {
    if (content !== undefined) {
      const source = memoryLineSource(content);
      setDoc({ kind: "ready", source });
      return () => source.dispose();
    }
    let alive = true;
    let source: LineSource | undefined;
    setDoc({ kind: "loading" });
    openTextDocument(path, { maxOpenBytes: getSettings().maxOpenMB * 1024 * 1024 })
      .then((r) => {
        if (!alive) return;
        if (!r.ok) {
          setDoc({ kind: "error", message: r.reason ?? "无法打开此文件" });
          return;
        }
        source = chunkedLineSource(r.docId, r.totalLines, r.headLines);
        setDoc({ kind: "ready", source });
      })
      .catch((e) => {
        if (alive) setDoc({ kind: "error", message: String(e) });
      });
    return () => {
      alive = false;
      source?.dispose();
    };
  }, [path, content, reopenTick]);

  const source = doc.kind === "ready" ? doc.source : null;
  const chunk = useMemo(
    () => (source && lang ? createChunkHighlighter(source, lang) : null),
    [source, lang],
  );
  useEffect(() => () => chunk?.dispose(), [chunk]);
  // 块就绪 → bump 重渲染，把无高亮行换成着色行（沿用 onHighlighterReady 同款通知范式）
  const [, setHlTick] = useState(0);
  useEffect(() => chunk?.subscribe(() => setHlTick((n) => n + 1)) ?? undefined, [chunk]);

  const handleError = (e: unknown) => {
    if (isDocInvalidError(e) && content === undefined) {
      const now = Date.now();
      if (now - lastReopenRef.current > 500) {
        lastReopenRef.current = now;
        setReopenTick((n) => n + 1);
      }
      return;
    }
    console.error("LinePreview: 取行失败", e);
  };

  if (doc.kind === "loading") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-[var(--text-3)]">
        正在建立行索引…
      </div>
    );
  }
  if (doc.kind === "error") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-[12px] text-[var(--text-3)]">
        {doc.message}
      </div>
    );
  }
  // 行号列宽按总行数位数动态设置（ch 随 --app-font 数字宽；44px 缺省仅覆盖非虚拟化路径）
  const lnW = `${Math.max(4, String(Math.max(1, doc.source.totalLines)).length)}ch`;
  return (
    <VirtualLines
      source={doc.source}
      className="code-preview min-h-0 flex-1"
      style={{ "--ln-w": lnW } as React.CSSProperties}
      renderLine={(i, text) => {
        const h = chunk?.lineHtml(i);
        return h !== undefined ? (
          <div key={i} dangerouslySetInnerHTML={{ __html: h }} />
        ) : (
          <div key={i}>
            <span className="line" data-ln={i + 1}>
              {text ?? ""}
            </span>
          </div>
        );
      }}
      onRange={(s, e) => chunk?.request(s, e)}
      initial={initial}
      onScrollState={onScrollState}
      onError={handleError}
    />
  );
}
