import { useEffect, useState } from "react";
import { useSettings, setSetting, type FileClickMode } from "../settings";
import { FONTS, applyFont } from "../fonts";
import { THEMES, applyTheme, watchSystemTheme } from "../theme";
import { loadIgnore } from "../fileIgnore";
import { countWorkspaceFiles } from "../catalog";
import ConnectionSettings from "./ConnectionSettings";

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={
        "relative h-5 w-9 shrink-0 rounded-full transition-colors " +
        (on ? "bg-[var(--accent)]" : "bg-[var(--border)]")
      }
    >
      <span
        className={
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all " +
          (on ? "left-[18px]" : "left-0.5")
        }
      />
    </button>
  );
}

const CLICK_MODES: { key: FileClickMode; label: string; desc: string }[] = [
  { key: "open", label: "单击打开（默认）", desc: "单击文件即在编辑器打开、文件夹即展开/折叠" },
  { key: "select", label: "单击选中 · 双击打开", desc: "单击仅选中(可 Ctrl/Shift 多选)，双击才打开/展开" },
];

/** 全局设置弹窗（Cursor 式）。未来各类全局开关都加到这里。 */
export default function SettingsModal({
  root,
  onClose,
}: {
  root: string | null;
  onClose: () => void;
}) {
  const s = useSettings();
  const [draft, setDraft] = useState(String(s.maxFiles));
  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);

  // 打开设置时统计当前工作区有效文件数（与搜索同口径：含忽略名单），供配置上限时参照。
  useEffect(() => {
    if (!root) {
      setCount(null);
      return;
    }
    setCounting(true);
    const ig = loadIgnore(root);
    countWorkspaceFiles(root, ig.folders, ig.exts)
      .then((n) => setCount(n))
      .catch(() => setCount(null))
      .finally(() => setCounting(false));
  }, [root]);

  const commit = () => {
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n >= 1000) {
      setSetting("maxFiles", n);
      setDraft(String(n));
    } else {
      setDraft(String(s.maxFiles)); // 非法输入回退到当前值
    }
  };

  const [editMbDraft, setEditMbDraft] = useState(String(s.maxEditMB));
  const commitEditMb = () => {
    const n = Math.round(Number(editMbDraft));
    if (Number.isFinite(n) && n >= 1) {
      setSetting("maxEditMB", n);
      setEditMbDraft(String(n));
    } else {
      setEditMbDraft(String(s.maxEditMB)); // 非法输入回退到当前值
    }
  };

  const over = count !== null && count > s.maxFiles;
  const countLabel = !root
    ? "未打开工作区"
    : counting
      ? "正在统计当前工作区…"
      : count === null
        ? ""
        : over
          ? `当前工作区 ${count.toLocaleString()} 个文件 · 超出上限，部分不会被搜索`
          : `当前工作区 ${count.toLocaleString()} 个文件`;

  return (
    <div
      className="absolute inset-0 z-[100] flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-[460px] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--bg)] p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-[var(--text)]">设置</h2>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-[var(--text-2)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            ✕
          </button>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--surface-soft)]">
            <div className="min-w-0">
              <div className="text-sm font-medium text-[var(--text)]">悬浮提示</div>
              <div className="text-[11px] text-[var(--text-faint)]">
                鼠标停留时弹出 Skill / Memory 详情浮层
              </div>
            </div>
            <Toggle
              on={s.hoverPreview}
              onChange={(v) => setSetting("hoverPreview", v)}
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--surface-soft)]">
            <div className="min-w-0">
              <div className="text-sm font-medium text-[var(--text)]">多 Agent 全自动接力</div>
              <div className="text-[11px] text-[var(--text-faint)]">
                开：唤醒自动注入（终端静默后），团队无人工接力跑；关：半自动（弹提示，点击才唤醒）
              </div>
            </div>
            <Toggle
              on={s.autoRelay}
              onChange={(v) => setSetting("autoRelay", v)}
            />
          </div>

          <div className="rounded-lg px-3 py-2.5">
            <div className="text-sm font-medium text-[var(--text)]">文件单击行为</div>
            <div className="mb-2.5 text-[11px] text-[var(--text-faint)]">
              作用于文件树（全局搜索单独由下方开关控制）；选「单击选中」可像资源管理器那样 Ctrl/Shift 多选后批量操作
            </div>
            <div className="grid grid-cols-2 gap-2">
              {CLICK_MODES.map((m) => {
                const on = s.fileClickMode === m.key;
                return (
                  <button
                    key={m.key}
                    onClick={() => setSetting("fileClickMode", m.key)}
                    className={
                      "rounded-lg border px-3 py-2 text-left transition-colors " +
                      (on
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--border)] hover:bg-[var(--surface-soft)]")
                    }
                  >
                    <div className="flex items-center gap-1.5 text-[13px] leading-tight text-[var(--text)]">
                      {m.label}
                      {on && <span className="text-[var(--accent)]">✓</span>}
                    </div>
                    <div className="mt-0.5 text-[10px] text-[var(--text-faint)]">{m.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--surface-soft)]">
            <div className="min-w-0">
              <div className="text-sm font-medium text-[var(--text)]">全局搜索后打开文件</div>
              <div className="text-[11px] text-[var(--text-faint)]">
                开：单击搜索结果即在编辑器打开；关：仅在 File 页签定位选中、不打开（适合找文件喂给 AI，不切走终端）
              </div>
            </div>
            <Toggle on={s.openFileFromSearch} onChange={(v) => setSetting("openFileFromSearch", v)} />
          </div>

          <div className="rounded-lg px-3 py-2.5">
            <div className="text-sm font-medium text-[var(--text)]">外观主题</div>
            <div className="mb-2.5 text-[11px] text-[var(--text-faint)]">
              浅色（奶油）/ 深色（暖棕黑）/ 跟随系统；终端配色保持暖深不变
            </div>
            <div className="grid grid-cols-3 gap-2">
              {THEMES.map((t) => {
                const on = s.theme === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => {
                      setSetting("theme", t.key);
                      applyTheme(t.key);
                      watchSystemTheme();
                    }}
                    className={
                      "rounded-lg border px-3 py-2 text-left transition-colors " +
                      (on
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--border)] hover:bg-[var(--surface-soft)]")
                    }
                  >
                    <div className="flex items-center gap-1.5 text-[13px] leading-tight text-[var(--text)]">
                      {t.label}
                      {on && <span className="text-[var(--accent)]">✓</span>}
                    </div>
                    <div className="mt-0.5 text-[10px] text-[var(--text-faint)]">{t.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg px-3 py-2.5">
            <div className="text-sm font-medium text-[var(--text)]">界面字体</div>
            <div className="mb-2.5 text-[11px] text-[var(--text-faint)]">
              全局 UI、会话、编辑器、Markdown 预览跟随；终端与代码块保持等宽
            </div>
            <div className="grid grid-cols-2 gap-2">
              {FONTS.map((f) => {
                const on = s.fontFamily === f.key;
                return (
                  <button
                    key={f.key}
                    onClick={() => {
                      setSetting("fontFamily", f.key);
                      applyFont(f.key);
                    }}
                    style={{ fontFamily: f.stack }}
                    className={
                      "rounded-lg border px-3 py-2 text-left transition-colors " +
                      (on
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--border)] hover:bg-[var(--surface-soft)]")
                    }
                  >
                    <div className="flex items-center gap-1.5 text-[15px] leading-tight text-[var(--text)]">
                      {f.label}
                      {on && <span className="text-[var(--accent)]">✓</span>}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--text-faint)]">{f.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg px-3 py-2.5">
            <div className="text-sm font-medium text-[var(--text)]">全局搜索索引上限</div>
            <div className="mb-2.5 text-[11px] text-[var(--text-faint)]">
              双击 Shift 全局搜索一次最多索引的文件数；超出的不会被搜到。默认 10 万
            </div>
            <div className="flex items-center gap-2.5">
              <input
                type="number"
                min={1000}
                step={10000}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="w-32 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
              />
              <span
                className={
                  "min-w-0 flex-1 text-[11px] " + (over ? "text-[var(--accent)]" : "text-[var(--text-faint)]")
                }
              >
                {countLabel}
              </span>
            </div>
          </div>

          <div className="rounded-lg px-3 py-2.5">
            <div className="text-sm font-medium text-[var(--text)]">文件编辑大小上限</div>
            <div className="mb-2.5 text-[11px] text-[var(--text-faint)]">
              编辑器可打开的最大文件体积（MB）；过大文件编辑可能卡顿，建议 ≤ 20。默认 10
            </div>
            <div className="flex items-center gap-2.5">
              <input
                type="number"
                min={1}
                step={1}
                value={editMbDraft}
                onChange={(e) => setEditMbDraft(e.target.value)}
                onBlur={commitEditMb}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="w-32 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
              />
              <span className="min-w-0 flex-1 text-[11px] text-[var(--text-faint)]">
                MB · 对新打开的文件生效
              </span>
            </div>
          </div>

          <ConnectionSettings />
        </div>

        <div className="mt-4 border-t border-[var(--border)] pt-3 text-[10px] text-[var(--text-3)]">
          更多全局设置将陆续加入此处。
        </div>
      </div>
    </div>
  );
}
