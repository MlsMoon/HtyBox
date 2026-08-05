// plan-4：Markdown 大文档分段渲染——lexer 全量一次（成本 97% 在此、一次性），parser 只对
// 视口内的 token 块执行（近乎免费），DOM 规模与文档长度解耦。消费 VirtualLines 不定高模式
// （per-unit 测高 + 估算兜底 + scrollTop 补偿）。
// 锚点：从 token.raw 提取显式 id 建 id→块号索引（现状 marked 不生成 heading id，见计划
// 决策 3 补录）；跳转未挂载块 = 估算位置滚过去 + 挂载后二次校正 scrollIntoView。
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { lexMarkdown, renderTokenBlock, onHighlighterReady } from "../mdRender";
import { VirtualLines, type VirtualLinesApi } from "./ui/VirtualLines";
import type { LineSource } from "../lineSource";

/** 每块顶层 token 数（决策 2 = A）；块高不均由挂载后实测根治。 */
const BLOCK_TOKENS = 50;
/** 块 HTML 缓存 LRU 上限（渲染产物约 3 倍膨胀，128 块封顶防超大文档攒满内存）。 */
const MAX_BLOCK_HTML = 128;
/** 未测块的估算高度：50 个顶层 token 的典型渲染高度量级，实测后即被真实值替换。 */
const BLOCK_ESTIMATE_PX = 600;

export interface MdBlockPreviewHandle {
  /** 页内锚点跳转：已挂载块直接 scrollIntoView；未挂载查索引滚到估算位置再二次校正。
   *  返回 false = 文档内无此 id（调用方保持现状静默语义）。 */
  scrollToAnchor(id: string): boolean;
}

interface MdBlockPreviewProps {
  content: string;
  initial?: { top: number };
  onScrollState?: (top: number) => void;
  /** 容器点击（链接分派委托，挂外层与现状一致）。 */
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

const MdBlockPreview = forwardRef<MdBlockPreviewHandle, MdBlockPreviewProps>(
  function MdBlockPreview({ content, initial, onScrollState, onClick }, ref) {
    const blocks = useMemo(() => {
      const tokens = lexMarkdown(content);
      const out: (typeof tokens)[number][][] = [];
      for (let i = 0; i < tokens.length; i += BLOCK_TOKENS) out.push(tokens.slice(i, i + BLOCK_TOKENS));
      return out;
    }, [content]);
    // 锚点索引：token.raw 内显式 id="…"（首见 id 归属其块）
    const anchorIndex = useMemo(() => {
      const m = new Map<string, number>();
      blocks.forEach((tks, bi) => {
        for (const t of tks) {
          const raw = (t as { raw?: string }).raw ?? "";
          for (const hit of raw.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) {
            if (!m.has(hit[1])) m.set(hit[1], bi);
          }
        }
      });
      return m;
    }, [blocks]);

    // 块 HTML 缓存（Map 序 = 写入序，近似 LRU）；语法就绪后整表作废让视口块换着色版
    const htmlCache = useRef(new Map<number, string>());
    const [, setHlTick] = useState(0);
    useEffect(() => {
      htmlCache.current.clear();
      return onHighlighterReady(() => {
        htmlCache.current.clear();
        setHlTick((n) => n + 1);
      });
    }, [blocks]);
    const blockHtml = (i: number): string => {
      const cache = htmlCache.current;
      let h = cache.get(i);
      if (h === undefined) {
        h = renderTokenBlock(blocks[i]);
        cache.set(i, h);
        while (cache.size > MAX_BLOCK_HTML) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
      return h;
    };

    // 块数据恒在内存：source 只提供计数语义（内容由 renderLine 按块号自取）
    const blockSource = useMemo<LineSource>(
      () => ({
        totalLines: blocks.length,
        peekLines: (start, count) =>
          new Array<string>(Math.max(0, Math.min(count, blocks.length - start))).fill(""),
        ensure: () => Promise.resolve(),
        dispose: () => {},
      }),
      [blocks],
    );

    const api = useRef<VirtualLinesApi | null>(null);
    useImperativeHandle(ref, () => ({
      scrollToAnchor(id: string): boolean {
        const host = api.current?.container;
        const hit = host?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
        if (hit) {
          hit.scrollIntoView({ behavior: "smooth", block: "start" });
          return true;
        }
        const bi = anchorIndex.get(id);
        if (bi === undefined) return false;
        api.current?.scrollToIndex(bi);
        // 二次校正：目标块挂载渲染出真实 DOM 后精确定位（估算高度会有偏差）
        let tries = 0;
        const settle = () => {
          const el = api.current?.container?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
          if (el) el.scrollIntoView({ block: "start" });
          else if (++tries < 30) requestAnimationFrame(settle);
        };
        requestAnimationFrame(settle);
        return true;
      },
    }));

    return (
      <div className="md-preview flex min-h-0 flex-1 flex-col" onClick={onClick}>
        <VirtualLines
          source={blockSource}
          className="min-h-0 flex-1 p-4 text-[13px] text-[var(--text)]"
          variable={{ estimate: BLOCK_ESTIMATE_PX }}
          overscan={2}
          renderLine={(i) => (
            <div key={i} data-bi={i} dangerouslySetInnerHTML={{ __html: blockHtml(i) }} />
          )}
          initial={initial}
          onScrollState={(top) => onScrollState?.(top)}
          apiRef={api}
        />
      </div>
    );
  },
);

export default MdBlockPreview;
