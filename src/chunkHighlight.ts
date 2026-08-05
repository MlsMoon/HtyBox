// plan-3：分块高亮调度——块缓存（LRU）+ grammarState 链 + 跳转 grammarContextCode 兜底。
// 决策 2 = A：顺序可达用上一块末态精确串联（实测 0 错行且快于全量）；跳转到未算过的块用
// 前 CONTEXT_LINES 行做语法上下文（实测 0 错行，46ms 级）。块缓存被 LRU 逐出导致 state 链
// 断裂时天然退回上下文路径，不出错。
// 决策 3 = C：块 200 行（单块实测 ~16ms 贴一帧预算）+ 每帧最多算一块；未算好的行先显示
// 无高亮文本（高亮是增强不是前提），块就绪经 subscribe 通知重渲染。
import { highlightChunk, onHighlighterReady, type ChunkHighlightResult } from "./highlighter";
import type { LineSource } from "./lineSource";

const CHUNK_LINES = 200;
const CONTEXT_LINES = 200;
/** 块 HTML LRU 上限：128 块 × 200 行 = 2.56 万行着色 HTML 常驻上限，防超大文件攒满内存。 */
const MAX_CHUNKS = 128;

export interface ChunkHighlighter {
  /** 行的高亮 HTML（完整 `<span class="line" data-ln>`）；块未算好返回 undefined。 */
  lineHtml(line: number): string | undefined;
  /** 视口行区间变化：调度涉及块（含前后各一块预热）的计算。 */
  request(startLine: number, endLine: number): void;
  /** 订阅「有块就绪」，收到后重渲染换上着色行。返回取消订阅。 */
  subscribe(cb: () => void): () => void;
  dispose(): void;
}

/** 缓存条目：viaContext = 本块（或其 state 链上游）经 grammarContextCode 推断而非精确串联——
 *  超过上下文窗的巨型多行注释下可能着色不准；精确链推进到位后据此重算（自我纠正）。 */
interface ChunkEntry extends ChunkHighlightResult {
  viaContext: boolean;
}

export function createChunkHighlighter(source: LineSource, lang: string): ChunkHighlighter {
  const chunks = new Map<number, ChunkEntry>(); // Map 序 = 写入序（近似 LRU）
  const listeners = new Set<() => void>();
  let wanted: number[] = []; // 当前需要的块号（视口内优先在前）
  let pumping = false;
  let disposed = false;

  const notify = () => listeners.forEach((l) => l());
  const evict = () => {
    while (chunks.size > MAX_CHUNKS) {
      const oldest = chunks.keys().next().value;
      if (oldest === undefined) break;
      chunks.delete(oldest);
    }
  };

  /** 试算一块：源文本/上下文未到货则触发装载并返回 false（到货后回调重新 pump）。 */
  const computeChunk = (idx: number): boolean => {
    const start = idx * CHUNK_LINES;
    const count = Math.min(CHUNK_LINES, source.totalLines - start);
    if (count <= 0) return false;
    const texts = source.peekLines(start, count);
    if (texts.some((t) => t === undefined)) {
      source
        .ensure(start, count)
        .then(() => !disposed && pump())
        .catch(() => {}); // 取行失败由渲染主链路上报（VirtualLines.onError），此处不重复
      return false;
    }
    const prevEntry = chunks.get(idx - 1);
    const prev = prevEntry?.endState;
    let contextCode: string | undefined;
    if (!prev && idx > 0) {
      const ctxStart = Math.max(0, start - CONTEXT_LINES);
      const ctxTexts = source.peekLines(ctxStart, start - ctxStart);
      if (ctxTexts.some((t) => t === undefined)) {
        source
          .ensure(ctxStart, start - ctxStart)
          .then(() => !disposed && pump())
          .catch(() => {});
        return false;
      }
      contextCode = ctxTexts.join("\n");
    }
    const r = highlightChunk(texts.join("\n"), lang, start, { grammarState: prev, contextCode });
    if (!r) return false; // 语法未就绪：onHighlighterReady 会重新 pump
    // 污染标记：contextCode 推断、或上游 state 本身经推断 → 本块结果可被精确链覆盖
    const viaContext = idx > 0 && (!prevEntry || prevEntry.viaContext);
    chunks.delete(idx);
    chunks.set(idx, { ...r, viaContext });
    // 自我纠正：本块 state 精确时，下一块若是推断产物则作废重算（wanted 内的由 pump 续算），
    // 洗白潮随顺序滚动逐块向下传播
    if (!viaContext && chunks.get(idx + 1)?.viaContext) {
      chunks.delete(idx + 1);
      if (!wanted.includes(idx + 1)) wanted = [...wanted, idx + 1];
    }
    evict();
    return true;
  };

  /** 每帧最多算一块；算成了且还有欠账则续帧，全部在等外部条件时停（由回调唤醒）。 */
  const pump = () => {
    if (disposed || pumping) return;
    pumping = true;
    requestAnimationFrame(() => {
      pumping = false;
      if (disposed) return;
      let computed = false;
      for (const idx of wanted) {
        if (chunks.has(idx)) continue;
        computed = computeChunk(idx);
        break; // 单帧只处理一块（无论算成或转入等待）
      }
      if (computed) {
        notify();
        if (wanted.some((w) => !chunks.has(w))) pump();
      }
    });
  };

  const offReady = onHighlighterReady(() => pump());

  return {
    lineHtml(line) {
      return chunks.get(Math.floor(line / CHUNK_LINES))?.lines[line % CHUNK_LINES];
    },
    request(startLine, endLine) {
      if (endLine <= startLine) return;
      const first = Math.floor(startLine / CHUNK_LINES);
      const last = Math.floor((endLine - 1) / CHUNK_LINES);
      const maxChunk = Math.floor(Math.max(0, source.totalLines - 1) / CHUNK_LINES);
      const next: number[] = [];
      for (let c = first; c <= last; c++) next.push(c); // 视口块优先
      if (first > 0) next.push(first - 1); // 前后各一块空闲预热
      if (last < maxChunk) next.push(last + 1);
      wanted = next;
      pump();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      disposed = true;
      offReady();
      listeners.clear();
      chunks.clear();
    },
  };
}
