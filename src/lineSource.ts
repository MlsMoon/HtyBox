// plan-2：行数据源抽象——统一「内存字符串」与「Rust 分片句柄」为同一接口，
// 供虚拟滚动内核（VirtualLines）消费；内核只认 totalLines + peek/ensure，不关心数据来源。
import { closeTextDocument, readTextLines } from "./catalog";

export interface LineSource {
  readonly totalLines: number;
  /** 同步窥视 [start, start+count) 行：已就绪的给字符串，未到货的给 undefined（渲染骨架行）。 */
  peekLines(start: number, count: number): (string | undefined)[];
  /** 确保 [start, start+count) 行就绪：触发缺段请求（在途去重），全部到货后 resolve。
   *  句柄失效等错误原样 reject（用 catalog.isDocInvalidError 判定后重新 open）。 */
  ensure(start: number, count: number): Promise<void>;
  dispose(): void;
}

/** 与 Rust 侧行数口径一致的切行：末尾换行不多算一行；仅「后跟 \n」的行尾 \r 按 CRLF 去掉，
 *  裸尾 \r 非行终止符、保留（两侧口径必须一致，行号才能对得上）。 */
function splitLines(content: string): string[] {
  if (!content) return [];
  const parts = content.split("\n");
  const hadFinal = content.endsWith("\n");
  if (hadFinal) parts.pop();
  const lastIdx = parts.length - 1;
  return parts.map((s, i) =>
    (hadFinal || i < lastIdx) && s.endsWith("\r") ? s.slice(0, -1) : s,
  );
}

/** 内存字符串数据源：中等文件与已全量加载场景复用（peek 恒有值，ensure 即时）。 */
export function memoryLineSource(content: string): LineSource {
  const lines = splitLines(content);
  return {
    totalLines: lines.length,
    peekLines: (start, count) => lines.slice(start, start + count),
    ensure: () => Promise.resolve(),
    dispose: () => {},
  };
}

/** 分段缓存粒度（行）。 */
const SEG_LINES = 512;
/** 段缓存 LRU 上限：64 段 × 512 行 ≈ 3.3 万行常驻，防超大文件把全部行攒进前端内存。 */
const MAX_SEGS = 64;

/** Rust 分片句柄数据源：按 512 行一段缓存 + 在途请求去重；headLines 预填首屏免一次往返。 */
export function chunkedLineSource(
  docId: number,
  totalLines: number,
  headLines: string[],
): LineSource {
  // Map 迭代序 = 插入序，重新 set 移尾 → 写入序近似 LRU（视口附近段最近写入，逐出的是远处段）
  const segs = new Map<number, string[]>();
  const inflight = new Map<number, Promise<void>>();
  for (let s = 0; s * SEG_LINES < headLines.length; s++) {
    segs.set(s, headLines.slice(s * SEG_LINES, (s + 1) * SEG_LINES));
  }
  /** 段是否完整（headLines 预填的末段可能不满，peek 到 undefined 时须允许重新请求整段）。 */
  const segComplete = (idx: number, seg: string[] | undefined): boolean =>
    !!seg && seg.length >= Math.min(SEG_LINES, totalLines - idx * SEG_LINES);
  const evict = () => {
    while (segs.size > MAX_SEGS) {
      const oldest = segs.keys().next().value;
      if (oldest === undefined) break;
      segs.delete(oldest);
    }
  };
  const fetchSeg = (idx: number): Promise<void> => {
    const going = inflight.get(idx);
    if (going) return going;
    const start = idx * SEG_LINES;
    const p = readTextLines(docId, start, SEG_LINES)
      .then((r) => {
        if (r.startLine !== start) return; // 过期/错段响应直接丢弃（防乱序错行）
        segs.delete(idx);
        segs.set(idx, r.lines);
        evict();
      })
      .finally(() => {
        inflight.delete(idx);
      });
    inflight.set(idx, p);
    return p;
  };
  return {
    totalLines,
    peekLines(start, count) {
      const n = Math.max(0, Math.min(count, totalLines - start));
      const out: (string | undefined)[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const line = start + i;
        out[i] = segs.get(Math.floor(line / SEG_LINES))?.[line % SEG_LINES];
      }
      return out;
    },
    ensure(start, count) {
      const end = Math.min(start + count, totalLines);
      if (end <= start) return Promise.resolve();
      const jobs: Promise<void>[] = [];
      for (let s = Math.floor(start / SEG_LINES); s <= Math.floor((end - 1) / SEG_LINES); s++) {
        if (!segComplete(s, segs.get(s))) jobs.push(fetchSeg(s));
      }
      return jobs.length ? Promise.all(jobs).then(() => {}) : Promise.resolve();
    },
    dispose() {
      segs.clear();
      closeTextDocument(docId).catch(() => {});
    },
  };
}
