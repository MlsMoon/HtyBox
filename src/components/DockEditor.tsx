import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { renderMarkdown } from "../mdRender";
import { langForPath, onHighlighterReady } from "../highlighter";
import { CODE_RE, IMAGE_RE, MD_RE, SVG_RE, TEXT_RE } from "../fileKinds";
import LinePreview from "./LinePreview";
import MdBlockPreview, { type MdBlockPreviewHandle } from "./MdBlockPreview";
import ConfirmModal from "./ui/ConfirmModal";
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
  /** plan-3：超出编辑上限但未超可打开上限——content 为空，走分片只读虚拟预览而非占位 */
  viewable?: boolean;
  /** 文件字节数（决定是否提供「仍要编辑」入口） */
  sizeBytes?: number;
  /** plan-5：用户已显式确认「仍要编辑」——外部变化重载时沿用放宽上限，避免弹回只读（同 forcedLossy 语义） */
  editAnyway?: boolean;
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
// plan-2（决策 4 = C）：值由 number 扩展为 { top, line? }——非虚拟化路径（md/textarea/全量代码
// 预览）只写读 top，语义与 v1.12.3 完全一致；虚拟化路径（plan-3 接入）额外记首个可见行号，
// 恢复时行号优先（换字体行高变化后仍回到同一行）。
const scrollStore = new Map<string, { top: number; line?: number }>();
/** 判定「已滚到目标」的像素容差：缩放比下 scrollTop 可能是小数，严格相等判不出到位。 */
const SCROLL_HIT_TOLERANCE = 2;

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/** readTextFile 的体积上限参数（全局设置）：编辑上限 + 只读预览可打开上限（plan-3 双阈值）。 */
const sizeOpts = () => ({
  maxBytes: getSettings().maxEditMB * 1024 * 1024,
  maxOpenBytes: getSettings().maxOpenMB * 1024 * 1024,
});

// plan-4：md 三档分流阈值。小文档走既有全量渲染（零回归）；中大走分段渲染；
// 超上限降级为纯文本只读虚拟预览（md 不定高虚拟化的成本只为常规大文档花，极端输入行为确定）。
const MD_BLOCK_MIN_BYTES = 512 * 1024;
const MD_MAX_BYTES = 16 * 1024 * 1024;
// plan-5 决策 1：「仍要编辑」入口的体积上限——超过则不提供入口（不让用户确认后卡死窗口），
// 只读虚拟预览仍然可用。
const EDIT_ANYWAY_MAX_BYTES = 100 * 1024 * 1024;

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
  const isText = !isMd && !isSvg && !isCode && TEXT_RE.test(path); // plan-3：纯文本类别
  const previewable = isMd || isSvg || isCode || isText;
  // 超编辑上限但可打开（viewable）：等高行类型（plan-3）与 md（plan-4，降级纯文本分片预览）
  // 都跳过占位直接进只读虚拟预览；svg 大文件不支持，仍走占位。
  const canVirtualPreview = (isCode || isText || isMd) && !!buf.viewable;
  // plan-4 md 三档分流：full=既有全量（零回归）/ block=分段渲染 / degrade=降级纯文本预览
  const mdMode = !isMd
    ? null
    : buf.viewable || buf.content.length > MD_MAX_BYTES
      ? "degrade"
      : buf.content.length >= MD_BLOCK_MIN_BYTES
        ? "block"
        : "full";
  const mdBlockRef = useRef<MdBlockPreviewHandle | null>(null);
  // 可预览的文件一律默认进预览态（用户 2026-07-27 拍板；此前只有 svg 默认预览）。
  // plan-5 决策 2 = C：纯文本（txt/log）是本次新纳入的可预览类型，默认保留旧习惯（编辑态），
  // 设置 plainTextDefaultEdit 可切到与其他类型一致的统一预览；大文件由 canVirtualPreview 恒预览。
  const [view, setView] = useState<"edit" | "preview">(() =>
    TEXT_RE.test(path) && getSettings().plainTextDefaultEdit ? "edit" : "preview",
  );
  // plan-5 决策 1 = A：超编辑上限的显式编辑入口（提示条按钮 → 自定义确认弹窗）
  const [editAnywayAsk, setEditAnywayAsk] = useState(false);
  const [imgFailed, setImgFailed] = useState(false); // SVG <img> 渲染失败(onError)安全网标志
  // md 内代码块语法按需加载：某语法就绪后 tick+1 触发重渲染，把无高亮代码块换成着色版。
  // （代码文件预览与 md 分段路径的语法就绪通知各自内部管理，本 tick 只服务全量 md）
  const [hlTick, setHlTick] = useState(0);
  useEffect(() => {
    if (mdMode !== "full") return;
    return onHighlighterReady(() => setHlTick((n) => n + 1));
  }, [mdMode]);
  // 预览产物仅在全量 md 且预览视图时计算（分段/降级路径绝不全量 parse）。
  const html = useMemo(
    () => (mdMode === "full" && view === "preview" ? renderMarkdown(buf.content) : ""),
    [mdMode, view, buf.content, hlTick],
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
      if (el) scrollStore.set(path, { top: el.scrollTop });
    });
  };

  /** 把滚动位置定回去。目标每次从 store 现读——这样恢复动作自身的回声、以及用户中途手动
   *  滚动写进 store 的新位置，都不会把人拽回一个过期的旧目标。 */
  const tryRestoreScroll = useCallback(() => {
    if (!pendingRestoreRef.current) return;
    const el = scrollRef.current;
    const target = scrollStore.get(path);
    if (!el || !target?.top) {
      pendingRestoreRef.current = false; // 没记录过 / 记的就是顶部 → 无需恢复
      return;
    }
    el.scrollTop = target.top;
    // 内容尚未渲染够高时只能滚到当前 scrollHeight 上限，留着标志等下一次内容变化再试
    if (Math.abs(el.scrollTop - target.top) < SCROLL_HIT_TOLERANCE)
      pendingRestoreRef.current = false;
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

  // 内容异步就绪会改变容器高度（读盘完成、md 渲染）→ 再试一次定位。
  // （虚拟化路径的定位由 VirtualLines 自理：spacer 总高一开始就正确，无需重试链）
  useEffect(() => {
    tryRestoreScroll();
  }, [buf.loaded, html, tryRestoreScroll]);

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
    readTextFile(path, sizeOpts())
      .then((r) => {
        const b: Buf = { content: r.content, dirty: false, loaded: true, editable: r.editable, reason: r.reason, canForce: r.canForce, lossy: r.lossy, warning: r.warning, viewable: r.viewable, sizeBytes: r.sizeBytes };
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
    const prev = editorStore.get(panelId);
    const forced = prev?.forcedLossy ?? false;
    const anyway = prev?.editAnyway ?? false;
    const opts = sizeOpts();
    // 用户已显式确认过「仍要编辑」→ 重载沿用放宽的编辑上限，不弹回只读预览
    if (anyway) opts.maxBytes = Math.max(opts.maxBytes, EDIT_ANYWAY_MAX_BYTES);
    readTextFile(path, { forceLossy: forced, ...opts })
      .then((r) => {
        const b: Buf = { content: r.content, dirty: false, loaded: true, editable: r.editable, reason: r.reason, canForce: r.canForce, lossy: r.lossy, warning: r.warning, forcedLossy: forced, viewable: r.viewable, sizeBytes: r.sizeBytes, editAnyway: anyway && r.editable };
        editorStore.set(panelId, b);
        setBuf(b);
        setExternalChanged(false);
        setErr(null);
      })
      .catch((e) => setErr(String(e)));
  };

  // 疑似二进制的逃生门：用户在占位 UI 显式确认后，以 U+FFFD 有损替换打开。
  const forceOpen = () => {
    readTextFile(path, { forceLossy: true, ...sizeOpts() })
      .then((r) => {
        const b: Buf = { content: r.content, dirty: false, loaded: true, editable: r.editable, reason: r.reason, canForce: r.canForce, lossy: r.lossy, warning: r.warning, forcedLossy: true, viewable: r.viewable, sizeBytes: r.sizeBytes };
        editorStore.set(panelId, b);
        setBuf(b);
      })
      .catch((e) => setErr(String(e)));
  };

  // plan-5 决策 1 = A：确认弹窗通过后，以放宽的编辑上限全量加载进 textarea（代价已如实告知）。
  const forceEditAnyway = () => {
    const forced = editorStore.get(panelId)?.forcedLossy ?? false;
    const opts = sizeOpts();
    opts.maxBytes = Math.max(opts.maxBytes, EDIT_ANYWAY_MAX_BYTES);
    readTextFile(path, { forceLossy: forced, ...opts })
      .then((r) => {
        const b: Buf = { content: r.content, dirty: false, loaded: true, editable: r.editable, reason: r.reason, canForce: r.canForce, lossy: r.lossy, warning: r.warning, forcedLossy: forced, viewable: r.viewable, sizeBytes: r.sizeBytes, editAnyway: r.editable };
        editorStore.set(panelId, b);
        setBuf(b);
        if (r.editable) setView("edit");
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
      // plan-4 分段路径：先走块索引（覆盖未挂载块）；全量路径维持现状 querySelector
      if (mdBlockRef.current?.scrollToAnchor(id)) return;
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

  // plan-3：等高行类型（代码/纯文本）超编辑上限但可打开 → 不再占位，落到下方分片只读虚拟预览
  if (buf.loaded && !buf.editable && !canVirtualPreview) {
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
        {previewable && !canVirtualPreview && (
          /* canVirtualPreview（超编辑上限的分片只读）没有可编辑内容可切，切换组隐藏；
             显式「仍要编辑」入口由 plan-5 收口 */
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
      {buf.lossy && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--accent-border-soft)] bg-[var(--accent-soft)] px-3 py-1.5">
          <span className="min-w-0 flex-1 text-[10.5px] text-[var(--accent-text)]">
            {buf.warning ?? "内容经有损转换，保存将写回转换后的内容"}
          </span>
        </div>
      )}
      {mdMode === "degrade" && !buf.viewable && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--accent-border-soft)] bg-[var(--accent-soft)] px-3 py-1.5">
          <span className="min-w-0 flex-1 text-[10.5px] text-[var(--accent-text)]">
            Markdown 文档过大（超出 {MD_MAX_BYTES / 1024 / 1024} MB 渲染上限），已降级为纯文本只读预览
          </span>
        </div>
      )}
      {buf.viewable && (
        /* plan-5：超编辑上限 → 只读虚拟预览提示条 + 显式编辑入口（决策 1 = A）；
           极端体积不给入口（不让用户确认后卡死），只读预览仍可用 */
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--accent-border-soft)] bg-[var(--accent-soft)] px-3 py-1.5">
          <span className="min-w-0 flex-1 text-[10.5px] text-[var(--accent-text)]">
            {buf.reason ?? "文件较大，超出编辑上限"}，已进入只读虚拟预览
            {isMd ? "（Markdown 排版随降级关闭）" : ""}
          </span>
          {(buf.sizeBytes ?? Infinity) <= EDIT_ANYWAY_MAX_BYTES && (
            <button
              onClick={() => setEditAnywayAsk(true)}
              className="shrink-0 rounded-md border border-[var(--accent-border-soft)] px-2 py-0.5 text-[10.5px] text-[var(--accent-text)] hover:bg-[var(--accent)] hover:text-white"
            >
              仍要编辑
            </button>
          )}
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
      {(previewable && view === "preview") || canVirtualPreview ? (
        /* canVirtualPreview 无可编辑内容，无视 view 恒走只读虚拟预览 */
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
        ) : isMd ? (
          mdMode === "degrade" ? (
            /* 超 md 渲染上限：降级纯文本只读虚拟预览（等高行管线；viewable 走分片） */
            <LinePreview
              path={path}
              content={buf.viewable ? undefined : buf.content}
              lang={null}
              initial={scrollStore.get(path)}
              onScrollState={(top, line) => scrollStore.set(path, { top, line })}
            />
          ) : mdMode === "block" ? (
            /* 中大 md：分段渲染（只挂载视口内的 token 块） */
            <MdBlockPreview
              ref={mdBlockRef}
              content={buf.content}
              onClick={onPreviewClick}
              initial={scrollStore.get(path)}
              onScrollState={(top) => scrollStore.set(path, { top })}
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
          /* plan-3：代码 / 纯文本共用等高行虚拟预览（content 在内存给内存源；
             viewable 大文件给 undefined 走分片句柄）。位置记忆走决策 4 = C 双语义 */
          <LinePreview
            path={path}
            content={buf.viewable ? undefined : buf.content}
            lang={isCode ? langForPath(path) : null}
            initial={scrollStore.get(path)}
            onScrollState={(top, line) => scrollStore.set(path, { top, line })}
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
      {editAnywayAsk && (
        <ConfirmModal
          title="以编辑模式加载大文件？"
          message={`此文件约 ${(((buf.sizeBytes ?? 0) / 1024 / 1024) || 0).toFixed(1)} MB，超出编辑上限（${getSettings().maxEditMB} MB）。全量载入编辑器后输入与保存可能明显卡顿；确认后将退出只读虚拟预览。`}
          confirmText="仍要编辑"
          onConfirm={forceEditAnyway}
          onClose={() => setEditAnywayAsk(false)}
        />
      )}
    </div>
  );
}
