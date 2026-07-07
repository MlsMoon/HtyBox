import { useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { marked } from "marked";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { readTextFile, writeTextFile, readImageDataUrl, watchFile, unwatchFile } from "../catalog";
import { sanitizeForRender } from "../svgSanitize";
import { emitActiveFile } from "../dockBus";
import { getSettings } from "../settings";

// 透明图棋盘格背景（SVG / 图片预览共用）。
const CHECKER_BG: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg,var(--checker) 25%,transparent 25%),linear-gradient(-45deg,var(--checker) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,var(--checker) 75%),linear-gradient(-45deg,transparent 75%,var(--checker) 75%)",
  backgroundSize: "18px 18px",
  backgroundPosition: "0 0,0 9px,9px -9px,-9px 0",
};
// 受支持的位图预览扩展名（svg 走文本预览，不在此列）。
const IMAGE_RE = /\.(png|jpe?g|jfif|gif|webp|bmp|ico|avif)$/i;

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

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/** M9：简易文本编辑器面板（textarea，无语法高亮）。Ctrl+S 保存；脏标在面板内。 */
export default function DockEditor(
  props: IDockviewPanelProps<{ editorPath: string; workspaceId?: string }>,
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
  const isMd = /\.(md|markdown)$/i.test(path);
  const isSvg = /\.svg$/i.test(path);
  const previewable = isMd || isSvg;
  const [view, setView] = useState<"edit" | "preview">(isSvg ? "preview" : "edit");
  const [imgFailed, setImgFailed] = useState(false); // SVG <img> 渲染失败(onError)安全网标志
  // 预览产物仅在预览视图计算：上限放宽后大文件在编辑视图打字，避免每键全量 parse/encode。
  const html = useMemo(
    () => (isMd && view === "preview" ? (marked.parse(buf.content, { async: false }) as string) : ""),
    [isMd, view, buf.content],
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
    if (props.api.isActive) emitActiveFile(wsId, path);
    const d = props.api.onDidActiveChange((e) => {
      if (e.isActive) emitActiveFile(wsId, path);
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
        ) : (
          <div
            className="md-preview min-h-0 flex-1 overflow-y-auto p-4 text-[13px] text-[var(--text)]"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )
      ) : (
        <textarea
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
