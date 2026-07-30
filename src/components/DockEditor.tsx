import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { renderMarkdown } from "../mdRender";
import { highlightToHtml, langForPath, onHighlighterReady } from "../highlighter";
import { CODE_RE, IMAGE_RE, MD_RE, SVG_RE } from "../fileKinds";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { readTextFile, writeTextFile, readImageDataUrl, watchFile, unwatchFile, fileExists } from "../catalog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openFileInScope, revealFileInScope } from "../fileOpenBus";
import { sanitizeForRender } from "../svgSanitize";
import { getSettings } from "../settings";

// 透明图棋盘格背景（SVG / 图片预览共用）。
const CHECKER_BG: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg,var(--checker) 25%,transparent 25%),linear-gradient(-45deg,var(--checker) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,var(--checker) 75%),linear-gradient(-45deg,transparent 75%,var(--checker) 75%)",
  backgroundSize: "18px 18px",
  backgroundPosition: "0 0,0 9px,9px -9px,-9px 0",
};
// 跨分屏/重排保活：dockview 会卸载重挂面板，用模块级 store 按 panelId 留住未保存缓冲。
interface Buf {
  content: string;
  dirty: boolean;
  loaded: boolean;
  editable: boolean;
  reason?: string;
  /** editable=false 时是否可「仍以文本方式打开」（疑似二进制=可；过大=不可） */
  canForce?: boolean;
  /** 内容经有损转换（� 替换 / UTF-16 转码），保存会覆盖原字节 */
  lossy?: boolean;
  /** lossy 警告条文案 */
  warning?: string;
  /** 用户点过「仍以文本方式打开」——外部变化重载时沿用，避免弹回占位 */
  forcedLossy?: boolean;
}
const editorStore = new Map<string, Buf>();
// 图片预览缓存（与 editorStore 同样为跨重挂保活；data URL 较大，避免重复读盘）。
interface ImgState {
  url: string;
  ok: boolean;
  reason?: string;
}
const imageStore = new Map<string, ImgState>();
export function disposeEditorBuf(panelId: string): void {
  editorStore.delete(panelId);
  imageStore.delete(panelId);
}
/** 该编辑器面板是否有未保存改动（供"关闭已保存的编辑器"判断）。 */
export function isEditorDirty(panelId: string): boolean {
  return editorStore.get(panelId)?.dirty ?? false;
}
/** 迁移到内容预览窗口时取走未保存内容；无改动返回 undefined（对端自行读盘即可）。 */
export function collectEditorBuf(panelId: string): string | undefined {
  const b = editorStore.get(panelId);
  return b?.dirty ? b.content : undefined;
}
/** 迁移接收端：面板挂载前预置未保存缓冲，让脏标与内容原样落到新窗口。 */
export function adoptEditorBuf(panelId: string, content: string): void {
  editorStore.set(panelId, { content, dirty: true, loaded: true, editable: true });
}

// 阅读位置记忆：切走的面板 DOM 被 dockview detach（`removeChild`，见 dockview-core 的
// content.js:142），期间没有 layout box、scrollTop 归零，切回来会从文档顶部开始——长文档
// 里跳走再回来就得重新往下滚。按【文件路径】而非 panelId 存：后退到已被关掉的 tab 时面板
// 是新建的、panelId 变了，按 path 才能连位置一起复原，故 disposeEditorBuf 不清本表。
const scrollStore = new Map<string, number>();
/** 判定「已滚到目标」的像素容差：缩放比下 scrollTop 可能是小数，严格相等判不出到位。 */
const SCROLL_HIT_TOLERANCE = 2;

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

// 代码预览的高亮上限：shiki 是同步 API，超大文件硬上会卡住整个窗口。
// 按字符数近似（纯 ASCII 源码 1 字符≈1 字节；含中文时更保守），超限则只给无高亮的行号预览。
const CODE_HL_MAX_CHARS = 512 * 1024;

/** M9：简易文本编辑器面板（textarea，无语法高亮）。Ctrl+S 保存；脏标在面板内。 */
export default function DockEditor(
  props: IDockviewPanelProps<{ editorPath: string; workspaceId?: string; workspaceRoot?: string }>,
) {
  const panelId = props.api.id;
  const path = props.params.editorPath;
  const [buf, setBuf] = useState<Buf>(
    () => editorStore.get(panelId) ?? { content: "", dirty: false, loaded: false, editable: true },
  );
  const [err, setErr] = useState<string | null>(null);
  const [externalChanged, setExternalChanged] = useState(false); // 文件被外部修改且本地有未保存改动 → 冲突提示
  const lastSaveRef = useRef(0); // 最近一次本地保存时刻：忽略本应用自身写盘触发的 file-changed 回声
  const isImage = IMAGE_RE.test(path);
  const [img, setImg] = useState<ImgState | null>(() => imageStore.get(panelId) ?? null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const isMd = MD_RE.test(path);
  const isSvg = SVG_RE.test(path);
  const isCode = !isMd && !isSvg && CODE_RE.test(path);
  const previewable = isMd || isSvg || isCode;
  // 可预览的文件一律默认进预览态（用户 2026-07-27 拍板；此前只有 svg 默认预览）
  const [view, setView] = useState<"edit" | "preview">("preview");
  const [imgFailed, setImgFailed] = useState(false); // SVG <img> 渲染失败(onError)安全网标志
  // 代码块语法按需加载：某语法就绪后 tick+1 触发重渲染，把先前的无高亮代码块换成着色版。
  const [hlTick, setHlTick] = useState(0);
  useEffect(() => {
    if (!isMd && !isCode) return;
    return onHighlighterReady(() => setHlTick((n) => n + 1));
  }, [isMd, isCode]);
  // 预览产物仅在预览视图计算：上限放宽后大文件在编辑视图打字，避免每键全量 parse/encode。
  const html = useMemo(
    () => (isMd && view === "preview" ? renderMarkdown(buf.content) : ""),
    [isMd, view, buf.content, hlTick],
  );
  // 代码文件只读预览：同一个 shiki 实例，行结构与 md 代码块同构（每行 <span class="line">）；
  // 超过上限则传 null 语言 → 走同构的无高亮兜底，行号照旧，窗口不卡。
  const codeTooBig = isCode && buf.content.length > CODE_HL_MAX_CHARS;
  const codeHtml = useMemo(
    () =>
      isCode && view === "preview" && buf.loaded
        ? highlightToHtml(
            buf.content,
            buf.content.length > CODE_HL_MAX_CHARS ? null : langForPath(path),
          )
        : "",
    [isCode, view, buf.loaded, buf.content, path, hlTick],
  );
  // SVG 预览：良构性校验（DOMParser 失败时 Chromium 插入 <parsererror>，取明细作诊断）+ 容错重试。
  // 解析失败时把「孤立 &」（后面不是合法实体）转义为 &amp; 再试一次——损坏/AI 生成的 mockup 常见
  // 此类语法伤；容错只影响预览渲染，不改编辑缓冲与保存内容，重试仍失败才如实报原始错误。
  const svgView = useMemo<{ url: string; error: string | null; cleaned: boolean; degraded: boolean }>(() => {
    if (!isSvg || view !== "preview" || !buf.loaded || !buf.content.trim())
      return { url: "", error: null, cleaned: false, degraded: false };
    const parseErr = (txt: string): string | null => {
      const doc = new DOMParser().parseFromString(txt, "image/svg+xml");
      const errNode = doc.querySelector("parsererror");
      if (!errNode) return null;
      const detail = errNode.querySelector("div")?.textContent; // Chromium 把"error on line…"明细放在内层 div
      return (detail || errNode.textContent || "SVG 解析失败").replace(/\s+/g, " ").trim();
    };
    const toUrl = (txt: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(txt)}`;
    const err0 = parseErr(buf.content);
    if (!err0) return { url: toUrl(buf.content), error: null, cleaned: false, degraded: false };
    // 非良构：清洗管线累加修正（仅作用于渲染副本、不改编辑缓冲与保存），让严格 DOMParser 通过。
    const { text, cleaned, wellFormed } = sanitizeForRender(buf.content, (s) => !parseErr(s));
    if (wellFormed) return { url: toUrl(text), error: null, cleaned, degraded: false };
    // 决策 1-A：清洗仍非良构 → 乐观兜底，仍交 <img> 试渲染（onError=imgFailed 才判失败）；err0 留作诊断。
    return { url: toUrl(text), error: err0, cleaned, degraded: true };
  }, [isSvg, view, buf.loaded, buf.content]);
  // 内容变化时复位 <img> 渲染失败标志,让修正后的 SVG 重新尝试渲染。
  useEffect(() => {
    setImgFailed(false);
  }, [buf.content]);

  // 阅读位置：滚动容器随视图分支变化（md 预览 / 代码预览 / 编辑区），用回调 ref 抓当前那一个。
  const scrollRef = useRef<HTMLElement | null>(null);
  const scrollRafRef = useRef(0);
  /** 是否还等着把位置定回去。内容异步渲染完容器才够高，故一次定不到位要留着重试。 */
  const pendingRestoreRef = useRef(false);

  const onScroll = () => {
    if (scrollRafRef.current) return; // 每帧最多记一次，滚动过程不做无谓写入
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      const el = scrollRef.current;
      if (el) scrollStore.set(path, el.scrollTop);
    });
  };

  /** 把滚动位置定回去。目标每次从 store 现读——这样恢复动作自身的回声、以及用户中途手动
   *  滚动写进 store 的新位置，都不会把人拽回一个过期的旧目标。 */
  const tryRestoreScroll = useCallback(() => {
    if (!pendingRestoreRef.current) return;
    const el = scrollRef.current;
    const target = scrollStore.get(path);
    if (!el || !target) {
      pendingRestoreRef.current = false; // 没记录过 / 记的就是顶部 → 无需恢复
      return;
    }
    el.scrollTop = target;
    // 内容尚未渲染够高时只能滚到当前 scrollHeight 上限，留着标志等下一次内容变化再试
    if (Math.abs(el.scrollTop - target) < SCROLL_HIT_TOLERANCE) pendingRestoreRef.current = false;
  }, [path]);

  // 面板被激活（打开 / 点 Tab / 前进后退）：dockview 此刻才把 DOM attach 回文档，
  // 等一帧让 layout 就绪再定位。
  useEffect(() => {
    if (props.api.isActive) pendingRestoreRef.current = true;
    const d = props.api.onDidActiveChange((e) => {
      if (!e.isActive) return;
      pendingRestoreRef.current = true;
      requestAnimationFrame(tryRestoreScroll);
    });
    return () => d.dispose();
  }, [props.api, tryRestoreScroll]);

  // 内容异步就绪会改变容器高度（读盘完成、md 渲染、shiki 语言按需加载）→ 再试一次定位。
  useEffect(() => {
    tryRestoreScroll();
  }, [buf.loaded, html, codeHtml, tryRestoreScroll]);

  // 图片：读 base64 data URL（跳过文本加载，避免落到「二进制不支持编辑」）。
  useEffect(() => {
    if (!isImage) return;
    const cached = imageStore.get(panelId);
    if (cached) {
      setImg(cached);
      return;
    }
    let alive = true;
    readImageDataUrl(path)
      .then((r) => {
        const s: ImgState = { url: r.dataUrl, ok: r.ok, reason: r.reason };
        imageStore.set(panelId, s);
        if (alive) setImg(s);
      })
      .catch((e) => {
        const s: ImgState = { url: "", ok: false, reason: String(e) };
        imageStore.set(panelId, s);
        if (alive) setImg(s);
      });
    return () => {
      alive = false;
    };
  }, [isImage, panelId, path]);

  useEffect(() => {
    if (isImage) return;
    const cached = editorStore.get(panelId);
    if (cached?.loaded) {
      setBuf(cached);
      return;
    }
    let alive = true;
    readTextFile(path, { maxBytes: getSettings().maxEditMB * 1024 * 1024 })
      .then((r) => {
        const b: Buf = { content: r.content, dirty: false, loaded: true, editable: r.editable, reason: r.reason, canForce: r.canForce, lossy: r.lossy, warning: r.warning };
        editorStore.set(panelId, b);
        if (alive) setBuf(b);
      })
      .catch((e) => {
        const b: Buf = { content: "", dirty: false, loaded: true, editable: false, reason: String(e) };
        editorStore.set(panelId, b);
        if (alive) setBuf(b);
      });
    return () => {
      alive = false;
    };
  }, [isImage, panelId, path]);

  // M9-N7：本面板激活时（打开文件 / 点击 Tab）通知 FilePanel 揭示并定位该文件
  useEffect(() => {
    const wsId = props.params.workspaceId;
    if (!wsId) return;
    if (props.api.isActive) revealFileInScope(wsId, path);
    const d = props.api.onDidActiveChange((e) => {
      if (e.isActive) revealFileInScope(wsId, path);
    });
    return () => d.dispose();
  }, [props.api, path, props.params.workspaceId]);

  // 从磁盘重新载入（放弃本地未保存内容）。供外部变化同步 / 冲突时手动重载。
  const reloadFromDisk = () => {
    const forced = editorStore.get(panelId)?.forcedLossy ?? false;
    readTextFile(path, { forceLossy: forced, maxBytes: getSettings().maxEditMB * 1024 * 1024 })
      .then((r) => {
        const b: Buf = { content: r.content, dirty: false, loaded: true, editable: r.editable, reason: r.reason, canForce: r.canForce, lossy: r.lossy, warning: r.warning, forcedLossy: forced };
        editorStore.set(panelId, b);
        setBuf(b);
        setExternalChanged(false);
        setErr(null);
      })
      .catch((e) => setErr(String(e)));
  };

  // 疑似二进制的逃生门：用户在占位 UI 显式确认后，以 U+FFFD 有损替换打开。
  const forceOpen = () => {
    readTextFile(path, { forceLossy: true, maxBytes: getSettings().maxEditMB * 1024 * 1024 })
      .then((r) => {
        const b: Buf = { content: r.content, dirty: false, loaded: true, editable: r.editable, reason: r.reason, canForce: r.canForce, lossy: r.lossy, warning: r.warning, forcedLossy: true };
        editorStore.set(panelId, b);
        setBuf(b);
      })
      .catch((e) => setErr(String(e)));
  };

  // 监听本文件的外部变化：打开时 watch、关闭时 unwatch（后端按引用计数处理多面板同文件）
  useEffect(() => {
    watchFile(path).catch(() => {});
    return () => {
      unwatchFile(path).catch(() => {});
    };
  }, [path]);

  // 后端报告文件被外部修改 → 同步：图片刷新预览；文本无未保存改动则静默重载，否则提示冲突
  useEffect(() => {
    const mine = path.replace(/\\/g, "/");
    let un: UnlistenFn | undefined;
    let disposed = false;
    listen<string>("file-changed", (e) => {
      if (e.payload.replace(/\\/g, "/") !== mine) return;
      if (Date.now() - lastSaveRef.current < 1000) return; // 忽略本应用自身保存触发的回声
      if (isImage) {
        readImageDataUrl(path)
          .then((r) => {
            const s: ImgState = { url: r.dataUrl, ok: r.ok, reason: r.reason };
            imageStore.set(panelId, s);
            setImg(s);
          })
          .catch(() => {});
        return;
      }
      if (editorStore.get(panelId)?.dirty) setExternalChanged(true);
      else reloadFromDisk();
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [path, panelId, isImage]);

  const update = (content: string) => {
    const b: Buf = { ...buf, content, dirty: true, loaded: true };
    editorStore.set(panelId, b);
    setBuf(b);
  };
  const save = () => {
    if (!buf.editable || !buf.dirty) return;
    writeTextFile(path, buf.content)
      .then(() => {
        const b = { ...(editorStore.get(panelId) ?? buf), dirty: false };
        editorStore.set(panelId, b);
        setBuf(b);
        setErr(null);
        setExternalChanged(false);
        lastSaveRef.current = Date.now();
      })
      .catch((e) => setErr(String(e)));
  };
  // md 预览里的 <a> 一律拦截：webview 若真按 href 导航，整个窗口会被目标页面顶掉
  // （内容预览窗口曾因此加载 index.html 变成第二个主窗）。拦下后按链接类型分派：
  // 外部协议交系统程序、页内锚点滚动、其余当作工作区文件路径在当前窗口打开。
  const onPreviewClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const raw = a.getAttribute("href") ?? "";
    if (!raw) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      // http / https / mailto 等外部协议 → 系统默认程序打开，不动本窗口
      openUrl(raw).catch((er) => setErr(String(er)));
      return;
    }
    if (raw.startsWith("#")) {
      const id = decodeURIComponent(raw.slice(1));
      if (!id) return;
      const el = e.currentTarget.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    // 相对/绝对文件路径：先去掉 #L12 之类的行锚点与查询串
    let rel = raw.split("#")[0].split("?")[0];
    if (!rel) return;
    try {
      rel = decodeURIComponent(rel);
    } catch {
      /* 非法百分号编码 → 按原样当路径 */
    }
    rel = rel.replace(/^\.\//, "");
    const dir = path.replace(/[\\/][^\\/]*$/, "");
    const root = props.params.workspaceRoot;
    // 同一条链接可能相对当前文件目录，也可能相对工作区根（AI 生成的计划文档常用后者）→ 按序探测
    const candidates = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(rel)
      ? [rel]
      : [`${dir}/${rel}`, root ? `${root}/${rel}` : ""].filter(Boolean);
    (async () => {
      for (const c of candidates) {
        const hit = await fileExists(c).catch((er) => {
          console.error("判断链接目标是否存在失败", c, er);
          return false;
        });
        if (hit) {
          openFileInScope(props.params.workspaceId ?? "", c);
          setErr(null);
          return;
        }
      }
      setErr(`链接目标不存在：${rel}`);
    })();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      update(buf.content.slice(0, s) + "\t" + buf.content.slice(en));
      requestAnimationFrame(() => {
        try {
          ta.selectionStart = ta.selectionEnd = s + 1;
        } catch {
          /* ignore */
        }
      });
    }
  };

  // 图片：只读预览（棋盘格背景居中、object-contain；header 显示文件名 + 像素尺寸）。
  if (isImage) {
    return (
      <div className="flex h-full flex-col bg-[var(--bg)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-deep)]">{basename(path)}</span>
          {nat && (
            <span className="shrink-0 text-[10.5px] text-[var(--text-3)]">
              {nat.w} × {nat.h}
            </span>
          )}
        </div>
        {img && !img.ok ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-[12px] text-[var(--text-3)]">
            {img.reason ?? "无法预览此图片"}
          </div>
        ) : (
          <div
            className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
            style={CHECKER_BG}
          >
            {img?.ok && (
              <img
                src={img.url}
                alt={basename(path)}
                onLoad={(e) =>
                  setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
                }
                className="max-h-full max-w-full object-contain"
              />
            )}
          </div>
        )}
      </div>
    );
  }

  if (buf.loaded && !buf.editable) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-[var(--bg)] p-6 text-center">
        <div className="text-[13px] font-semibold text-[var(--text-2)]">{basename(path)}</div>
        <div className="text-[12px] text-[var(--text-3)]">{buf.reason ?? "不支持编辑此文件"}</div>
        {buf.canForce && (
          <button
            onClick={forceOpen}
            className="mt-2 rounded-md border border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--text-2)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            仍以文本方式打开
          </button>
        )}
        {err && <div className="text-[10.5px] text-[var(--danger)]">{err}</div>}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[var(--bg)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-deep)]">
          {buf.dirty && <span className="mr-1 text-[var(--accent)]">●</span>}
          {basename(path)}
        </span>
        {previewable && (
          <div className="flex shrink-0 overflow-hidden rounded-md border border-[var(--border)] text-[10.5px]">
            <button
              onClick={() => setView("edit")}
              className={"px-2 py-0.5 " + (view === "edit" ? "bg-[var(--accent)] text-white" : "text-[var(--text-2)] hover:bg-[var(--surface)]")}
            >
              编辑
            </button>
            <button
              onClick={() => setView("preview")}
              className={"px-2 py-0.5 " + (view === "preview" ? "bg-[var(--accent)] text-white" : "text-[var(--text-2)] hover:bg-[var(--surface)]")}
            >
              预览
            </button>
          </div>
        )}
        {err && <span className="shrink-0 truncate text-[10.5px] text-[var(--danger)]">{err}</span>}
        <button
          onClick={save}
          disabled={!buf.dirty}
          title="保存（Ctrl+S）"
          className={
            "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold " +
            (buf.dirty
              ? "bg-[var(--accent)] text-white hover:bg-[var(--accent-text)]"
              : "bg-[var(--surface-hover)] text-[var(--text-3)]")
          }
        >
          保存
        </button>
      </div>
      {codeTooBig && view === "preview" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--accent-border-soft)] bg-[var(--accent-soft)] px-3 py-1.5">
          <span className="min-w-0 flex-1 text-[10.5px] text-[var(--accent-text)]">
            文件较大（{(buf.content.length / 1024 / 1024).toFixed(1)} MB，超过 512 KB），已关闭语法高亮以保证流畅；阅读与编辑不受影响
          </span>
        </div>
      )}
      {buf.lossy && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--accent-border-soft)] bg-[var(--accent-soft)] px-3 py-1.5">
          <span className="min-w-0 flex-1 text-[10.5px] text-[var(--accent-text)]">
            {buf.warning ?? "内容经有损转换，保存将写回转换后的内容"}
          </span>
        </div>
      )}
      {externalChanged && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--accent-border-soft)] bg-[var(--accent-soft)] px-3 py-1.5">
          <span className="min-w-0 flex-1 text-[10.5px] text-[var(--accent-text)]">文件已被外部修改，本地有未保存的改动。</span>
          <button
            onClick={reloadFromDisk}
            className="shrink-0 rounded-md bg-[var(--accent)] px-2 py-0.5 text-[10.5px] font-semibold text-white hover:bg-[var(--accent-text)]"
          >
            重载（放弃本地修改）
          </button>
          <button
            onClick={() => setExternalChanged(false)}
            className="shrink-0 text-[10px] text-[var(--text-3)] hover:text-[var(--text)]"
          >
            忽略
          </button>
        </div>
      )}
      {previewable && view === "preview" ? (
        isSvg ? (
          !svgView.url ? (
            <div
              className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 text-[12px] text-[var(--text-3)]"
              style={CHECKER_BG}
            >
              （无预览内容）
            </div>
          ) : imgFailed ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto p-6 text-center">
              <div className="text-[12px] font-semibold text-[var(--text-2)]">SVG 无法预览</div>
              <div className="max-w-full whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--text-3)]">
                {svgView.error ?? "SVG 渲染失败"}
              </div>
              <div className="text-[10.5px] text-[var(--text-3)]">已尽力容错渲染仍无法显示，可切到「编辑」查看并修正原始内容。</div>
            </div>
          ) : (
            <div
              className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
              style={CHECKER_BG}
            >
              <img
                src={svgView.url}
                alt={basename(path)}
                onError={() => setImgFailed(true)}
                className="max-h-full max-w-full object-contain"
              />
              {svgView.cleaned ? (
                <div className="absolute bottom-1.5 right-2 rounded bg-[var(--bg)]/80 px-1.5 py-0.5 text-[10px] text-[var(--text-3)]">
                  已容错渲染
                </div>
              ) : null}
            </div>
          )
        ) : isCode ? (
          <div
            ref={(el) => {
              scrollRef.current = el;
            }}
            onScroll={onScroll}
            className="code-preview min-h-0 flex-1 overflow-auto"
            dangerouslySetInnerHTML={{ __html: codeHtml }}
          />
        ) : (
          <div
            ref={(el) => {
              scrollRef.current = el;
            }}
            onScroll={onScroll}
            className="md-preview min-h-0 flex-1 overflow-y-auto p-4 text-[13px] text-[var(--text)]"
            onClick={onPreviewClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )
      ) : (
        <textarea
          ref={(el) => {
            scrollRef.current = el;
          }}
          onScroll={onScroll}
          value={buf.content}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          style={{ fontFamily: "var(--app-font)" }}
          className="min-h-0 flex-1 resize-none border-0 bg-[var(--bg)] p-3 text-[13px] leading-relaxed text-[var(--text)] outline-none"
        />
      )}
    </div>
  );
}
