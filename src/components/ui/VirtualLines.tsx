// plan-2：等高行虚拟滚动内核（自研零依赖，决策 1 = A：spacer 撑总高 + 切片 translateY 定位）。
// 只把视口 ± overscan 的行渲染进 DOM；行内容经 LineSource 按需取（缺行先渲染骨架、到货重渲）。
// 行高实测（决策 3 = A）：初始兜底常量 → 测切片内第一个真实行 → 字体变化 / 容器 resize 重测；
// detach（dockview 切走）期间测得 0 属正常态，保留上次有效值，attach 后 ResizeObserver 自动重测。
// plan-4 不定高模式（variable）：per-unit 实测高 + 估算兜底 + 前缀和定位 + 视口上方修正时
// scrollTop 补偿（防正在阅读的内容被顶走）——即 plan-2 决策 2 = B 预留扩展点的兑现。
import { useCallback, useEffect, useRef, useState } from "react";
import type { LineSource } from "../../lineSource";
import { useSettings } from "../../settings";

/** 行高兜底（--app-font 12.5px × line-height 1.45）：实测失败时使用，不静默。 */
const FALLBACK_LINE_H = 18.13;
/** 视口外上下各多渲染的缓冲行数，避免快速滚动露白。 */
const DEFAULT_OVERSCAN = 20;

export interface VirtualLinesProps {
  source: LineSource;
  /**
   * 渲染一行（index 从 0 起）；text=undefined 为未到货骨架行。
   * 约定：返回节点必须是块级且自然高度恒等于一行高（等高内核的前提），并带 key。
   */
  renderLine: (index: number, text: string | undefined) => React.ReactNode;
  overscan?: number;
  /** 滚动容器类名（如 code-preview；overflow 由内核固定为 auto）。 */
  className?: string;
  style?: React.CSSProperties;
  /** 初始定位（阅读位置记忆，决策 4 = C）：line 优先（换字体仍回同一行），无 line 用 top。 */
  initial?: { top: number; line?: number };
  /** 滚动上报：scrollTop + 首个可见行号（调用方写入 scrollStore）。 */
  onScrollState?: (top: number, firstLine: number) => void;
  /** 可见区间（含 overscan）变化上报：分块高亮等按视口调度的能力据此请求计算。 */
  onRange?: (start: number, end: number) => void;
  /** 取行失败上报（如句柄失效需重新 open）；缺省 console.error，不静默留白。 */
  onError?: (e: unknown) => void;
  /** plan-4 不定高模式：单元（块）实测高 + estimate 估算兜底。缺省 = 等高行模式。 */
  variable?: { estimate: number };
  /** 命令式 API（锚点跳转等场景由调用方驱动滚动）。 */
  apiRef?: React.MutableRefObject<VirtualLinesApi | null>;
}

export interface VirtualLinesApi {
  /** 滚动到第 i 个单元的起始位置（不定高按当前前缀和估算，挂载后可再精确校正）。 */
  scrollToIndex(i: number): void;
  readonly container: HTMLElement | null;
}

export function VirtualLines({
  source,
  renderLine,
  overscan = DEFAULT_OVERSCAN,
  className,
  style,
  initial,
  onScrollState,
  onRange,
  onError,
  variable,
  apiRef,
}: VirtualLinesProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sliceRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  const [lineH, setLineH] = useState(FALLBACK_LINE_H);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [dataTick, setDataTick] = useState(0);
  const measuredRef = useRef(false); // 首次实测完成（行号语义的恢复要等它，兜底行高会偏）
  const restoredRef = useRef(false);
  const { fontFamily } = useSettings(); // 字体设置变化 → 重测行高
  // —— 不定高几何（variable 模式）：实测高 Map + 前缀和缓存，修正后 geoTick 触发重排 ——
  const isVariable = !!variable;
  const estimate = variable?.estimate ?? FALLBACK_LINE_H;
  const heightsRef = useRef(new Map<number, number>());
  const prefixRef = useRef<number[] | null>(null);
  const [, setGeoTick] = useState(0);
  const prefix = useCallback(() => {
    if (!prefixRef.current) {
      const n = source.totalLines;
      const p = new Array<number>(n + 1);
      p[0] = 0;
      for (let i = 0; i < n; i++) p[i + 1] = p[i] + (heightsRef.current.get(i) ?? estimate);
      prefixRef.current = p;
    }
    return prefixRef.current;
  }, [source, estimate]);
  const offsetOf = useCallback(
    (i: number) => (isVariable ? prefix()[i] : i * lineH),
    [isVariable, prefix, lineH],
  );
  const totalH = useCallback(
    () => (isVariable ? prefix()[source.totalLines] : source.totalLines * lineH),
    [isVariable, prefix, source, lineH],
  );
  const indexAt = useCallback(
    (y: number) => {
      if (!isVariable) return Math.floor(y / lineH);
      const p = prefix();
      let lo = 0;
      let hi = source.totalLines - 1;
      let ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (p[mid] <= y) {
          ans = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return ans;
    },
    [isVariable, prefix, source, lineH],
  );

  /** 由 scrollTop + 容器高算可见区间（含 overscan）。 */
  const compute = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const start = Math.max(0, indexAt(el.scrollTop) - overscan);
    const end = Math.min(
      source.totalLines,
      indexAt(el.scrollTop + el.clientHeight) + 1 + overscan,
    );
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  }, [indexAt, overscan, source]);

  /** 实测行高（等高模式）：取切片内第一个真实内容行（骨架行高度由估计值撑，不能用来测）。 */
  const measure = useCallback(() => {
    if (isVariable) return; // 不定高模式走 per-unit 测量 effect
    const slice = sliceRef.current;
    if (!slice) return;
    const texts = source.peekLines(range.start, range.end - range.start);
    const k = texts.findIndex((t) => t !== undefined);
    if (k < 0) return;
    const h = (slice.children[k] as HTMLElement | undefined)?.getBoundingClientRect().height;
    if (!h) return; // detach 期间为 0：保留上次有效值
    if (Number.isNaN(h)) {
      console.warn("VirtualLines: 行高实测得 NaN，沿用", lineH);
      return;
    }
    measuredRef.current = true;
    if (Math.abs(h - lineH) > 0.5) setLineH(h);
  }, [isVariable, range, source, lineH]);

  // 不定高 per-unit 测量：每次渲染后测切片内各单元真实高度；上方单元修正时补偿 scrollTop，
  // 避免正在阅读的内容因总高变化被顶走（plan-4 Step 2 的核心要求）
  useEffect(() => {
    if (!isVariable) return;
    const slice = sliceRef.current;
    const el = containerRef.current;
    if (!slice || !el || !el.clientHeight) return;
    let delta = 0;
    let changed = false;
    for (let k = 0; k < slice.children.length; k++) {
      const i = range.start + k;
      const h = (slice.children[k] as HTMLElement).getBoundingClientRect().height;
      if (!h) continue;
      const old = heightsRef.current.get(i) ?? estimate;
      if (Math.abs(h - old) > 0.5) {
        // 补偿判定用修正前几何：单元完全在视口上方才补偿
        if (offsetOf(i) + old <= el.scrollTop) delta += h - old;
        heightsRef.current.set(i, h);
        changed = true;
      }
    }
    if (changed) {
      prefixRef.current = null;
      if (delta) el.scrollTop += delta;
      setGeoTick((n) => n + 1);
      compute();
    }
  });

  // 字体设置变化 → 不定高实测全部作废重测（等高模式由 measure 的 fontFamily effect 覆盖）
  useEffect(() => {
    if (!isVariable) return;
    heightsRef.current.clear();
    prefixRef.current = null;
    setGeoTick((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontFamily, isVariable]);

  const lastTopRef = useRef(0); // dockview detach 会把 scrollTop 归零，attach 后据此复位

  const handleScroll = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = containerRef.current;
      if (!el) return;
      if (el.clientHeight) lastTopRef.current = el.scrollTop; // detach 归零事件不覆盖记忆
      compute();
      onScrollState?.(el.scrollTop, indexAt(el.scrollTop));
    });
  };

  // 命令式 API（锚点跳转等）：每次渲染刷新引用，保证几何函数不过期
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      scrollToIndex: (i) => {
        const el = containerRef.current;
        if (!el) return;
        el.scrollTop = offsetOf(Math.max(0, Math.min(i, source.totalLines - 1)));
        compute();
      },
      get container() {
        return containerRef.current;
      },
    };
    return () => {
      apiRef.current = null;
    };
  });

  // 可见区间上报（分块高亮等按视口调度）
  useEffect(() => {
    onRange?.(range.start, range.end);
    // onRange 为调用方内联闭包，不入 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  // 区间变化 → 确保数据就绪，到货 bump 一次让骨架行换成真实内容
  useEffect(() => {
    let alive = true;
    source
      .ensure(range.start, range.end - range.start)
      .then(() => {
        if (alive) setDataTick((t) => t + 1);
      })
      .catch((e) => {
        if (!alive) return;
        if (onError) onError(e);
        else console.error("VirtualLines: 取行失败", e);
      });
    return () => {
      alive = false;
    };
    // onError 为调用方内联闭包，不入 deps（区间/源不变时无需重取）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, source]);

  // 数据到货 / 字体设置变化 → 重测行高（lineH 变化会经 compute 重算区间与总高）
  useEffect(() => {
    measure();
  }, [dataTick, fontFamily, measure]);

  // 容器尺寸变化（含 dockview attach/detach、窗口缩放、DPI 变化）→ 重算区间 + 重测行高。
  // dockview 切 tab 走 detach/attach 同一 element、scrollTop 归零（reference_dockview_panel_facts）：
  // attach 恢复布局后若 scrollTop 被归零而此前有位置，先复位再算区间。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight && !el.scrollTop && lastTopRef.current) {
        el.scrollTop = lastTopRef.current;
      }
      compute();
      measure();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [compute, measure]);

  // 数据源变化（换文件 / 重新 open）→ 复位区间与恢复状态
  useEffect(() => {
    restoredRef.current = false;
    measuredRef.current = false;
    compute();
  }, [source, compute]);

  // 初始定位（决策 4 = C）：line 语义等首次实测行高（兜底值会偏），top 语义立即可用；
  // 目标一次到位（spacer 总高从一开始就正确，无需像全量渲染那样等内容长高重试）
  useEffect(() => {
    if (restoredRef.current || !initial) return;
    const el = containerRef.current;
    if (!el || !el.clientHeight) return; // detach 期间不定位，attach 后再来
    if (initial.line !== undefined && !measuredRef.current && !isVariable) return;
    const top = initial.line !== undefined ? offsetOf(initial.line) : initial.top;
    if (top > 0) el.scrollTop = top;
    restoredRef.current = true;
    compute();
  }, [initial, lineH, dataTick, compute]);

  const n = Math.max(0, range.end - range.start);
  const texts = source.peekLines(range.start, n);
  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={className}
      style={{ ...style, overflow: "auto" }}
    >
      <div style={{ height: totalH(), position: "relative" }}>
        <div ref={sliceRef} style={{ transform: `translateY(${offsetOf(range.start)}px)` }}>
          {texts.map((t, i) => renderLine(range.start + i, t))}
        </div>
      </div>
    </div>
  );
}
