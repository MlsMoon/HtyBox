import { useEffect, useState, type CSSProperties } from "react";
import { useSettings, setSetting, type FileClickMode } from "../settings";
import { FONTS, applyFont } from "../fonts";
import { THEMES, applyTheme, watchSystemTheme } from "../theme";
import { loadIgnore } from "../fileIgnore";
import { countWorkspaceFiles } from "../catalog";
import ConnectionSettings from "./ConnectionSettings";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdateDetailed, type Update } from "../updater";
import { useMaskDismiss } from "./ui/maskDismiss";

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

/* ===== 公共控件：现有三种设置项形态的收敛（视觉语言不变），各分类声明式复用 ===== */

/** 开关行：标题 + 描述 + 右侧 Toggle */
function ToggleRow({
  title,
  desc,
  on,
  onChange,
}: {
  title: string;
  desc: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--surface-soft)]">
      <div className="min-w-0">
        <div className="text-sm font-medium text-[var(--text)]">{title}</div>
        <div className="text-[11px] text-[var(--text-faint)]">{desc}</div>
      </div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

/** 卡片单选组：`large` = 大字号卡（字体选择预览用），`style` 作用于整卡（字体栈预览） */
function ChoiceGrid<K extends string>({
  title,
  desc,
  cols,
  large,
  options,
  value,
  onChange,
}: {
  title: string;
  desc: string;
  cols: 2 | 3;
  large?: boolean;
  options: { key: K; label: string; desc: string; style?: CSSProperties }[];
  value: K;
  onChange: (k: K) => void;
}) {
  return (
    <div className="rounded-lg px-3 py-2.5">
      <div className="text-sm font-medium text-[var(--text)]">{title}</div>
      <div className="mb-2.5 text-[11px] text-[var(--text-faint)]">{desc}</div>
      <div className={"grid gap-2 " + (cols === 3 ? "grid-cols-3" : "grid-cols-2")}>
        {options.map((m) => {
          const on = value === m.key;
          return (
            <button
              key={m.key}
              onClick={() => onChange(m.key)}
              style={m.style}
              className={
                "rounded-lg border px-3 py-2 text-left transition-colors " +
                (on
                  ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                  : "border-[var(--border)] hover:bg-[var(--surface-soft)]")
              }
            >
              <div className={"flex items-center gap-1.5 leading-tight text-[var(--text)] " + (large ? "text-[15px]" : "text-[13px]")}>
                {m.label}
                {on && <span className="text-[var(--accent)]">✓</span>}
              </div>
              <div className={"mt-0.5 text-[var(--text-faint)] " + (large ? "text-[11px]" : "text-[10px]")}>{m.desc}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 数字输入行：失焦/回车 commit（非法值由调用方回退），hint 可切强调色（超限提示） */
function NumberField({
  title,
  desc,
  min,
  step,
  draft,
  setDraft,
  commit,
  hint,
  hintAccent,
}: {
  title: string;
  desc: string;
  min: number;
  step: number;
  draft: string;
  setDraft: (v: string) => void;
  commit: () => void;
  hint: string;
  hintAccent?: boolean;
}) {
  return (
    <div className="rounded-lg px-3 py-2.5">
      <div className="text-sm font-medium text-[var(--text)]">{title}</div>
      <div className="mb-2.5 text-[11px] text-[var(--text-faint)]">{desc}</div>
      <div className="flex items-center gap-2.5">
        <input
          type="number"
          min={min}
          step={step}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="w-32 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
        <span className={"min-w-0 flex-1 text-[11px] " + (hintAccent ? "text-[var(--accent)]" : "text-[var(--text-faint)]")}>
          {hint}
        </span>
      </div>
    </div>
  );
}

/** 动作行：标题 + 描述 + 右侧按钮（busy 时禁用换文案），下方可选状态行（muted/accent/danger 三色） */
function ActionRow({
  title,
  desc,
  action,
  busyLabel,
  busy,
  onAction,
  hint,
  hintTone = "muted",
}: {
  title: string;
  desc: string;
  action: string;
  busyLabel: string;
  busy: boolean;
  onAction: () => void;
  hint?: string;
  hintTone?: "muted" | "accent" | "danger";
}) {
  const toneCls =
    hintTone === "danger"
      ? "text-[var(--danger)]"
      : hintTone === "accent"
        ? "text-[var(--accent)]"
        : "text-[var(--text-faint)]";
  return (
    <div className="rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--surface-soft)]">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--text)]">{title}</div>
          <div className="text-[11px] text-[var(--text-faint)]">{desc}</div>
        </div>
        <button
          disabled={busy}
          onClick={onAction}
          className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-1.5 text-[12px] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-text)] disabled:cursor-default disabled:opacity-60 disabled:hover:border-[var(--border)] disabled:hover:text-[var(--text)]"
        >
          {busy ? busyLabel : action}
        </button>
      </div>
      {hint && (
        <div className={"mt-1.5 truncate text-[11px] " + toneCls} title={hint}>
          {hint}
        </div>
      )}
    </div>
  );
}

const CLICK_MODES: { key: FileClickMode; label: string; desc: string }[] = [
  { key: "open", label: "单击打开（默认）", desc: "单击文件即在编辑器打开、文件夹即展开/折叠" },
  { key: "select", label: "单击选中 · 双击打开", desc: "单击仅选中(可 Ctrl/Shift 多选)，双击才打开/展开" },
];

/* ===== 分类导航（Cursor 式左导航；上次停留分类全局记忆——设置是全局概念，不按工作区） ===== */

type SectionKey = "general" | "appearance" | "terminal" | "files" | "connection";
const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "general", label: "通用" },
  { key: "appearance", label: "外观" },
  { key: "terminal", label: "终端" },
  { key: "files", label: "文件与搜索" },
  { key: "connection", label: "连接" },
];
const SECTION_KEY = "htybox.settingsSection.v1";

/** 全局设置弹窗：宽体 + 左侧分类导航。未来新设置项加进对应分类（或新增 SECTIONS 项）。 */
export default function SettingsModal({
  root,
  onClose,
  onUpdateFound,
}: {
  root: string | null;
  onClose: () => void;
  /** 手动检查发现新版本：上抛给 App 弹 UpdateModal + 点亮顶栏更新角标 */
  onUpdateFound: (u: Update) => void;
}) {
  const s = useSettings();
  const mask = useMaskDismiss(onClose);
  const [section, setSection] = useState<SectionKey>(() => {
    const v = localStorage.getItem(SECTION_KEY);
    return SECTIONS.some((x) => x.key === v) ? (v as SectionKey) : "general";
  });
  const pick = (k: SectionKey) => {
    setSection(k);
    try {
      localStorage.setItem(SECTION_KEY, k);
    } catch {
      /* localStorage 不可用 → 本次会话内仍生效 */
    }
  };

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

  // 版本与更新：当前版本号 + 手动三态检查（发现新版本 → onUpdateFound 上抛弹 UpdateModal）
  const [appVer, setAppVer] = useState("");
  useEffect(() => {
    getVersion().then(setAppVer).catch(() => {});
  }, []);
  const [checking, setChecking] = useState(false);
  const [updHint, setUpdHint] = useState<{ text: string; tone: "muted" | "accent" | "danger" } | null>(null);
  const doCheckUpdate = async () => {
    if (checking) return;
    setChecking(true);
    setUpdHint(null);
    const r = await checkForUpdateDetailed();
    setChecking(false);
    if (r.status === "update") {
      setUpdHint({ text: `发现新版本 v${r.update.version}`, tone: "accent" });
      onUpdateFound(r.update);
    } else if (r.status === "none") {
      setUpdHint({ text: `已是最新版本（v${appVer || "当前"}）`, tone: "muted" });
    } else {
      setUpdHint({ text: `检查失败：${r.message}`, tone: "danger" });
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
      {...mask}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[min(78vh,640px)] w-[min(760px,92vw)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg)] shadow-2xl"
      >
        {/* 左：分类导航 */}
        <div className="flex w-[168px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] px-3 py-4">
          <h2 className="mb-3 px-2 text-base font-bold text-[var(--text)]">设置</h2>
          {SECTIONS.map((x) => {
            const on = section === x.key;
            return (
              <button
                key={x.key}
                onClick={() => pick(x.key)}
                className={
                  "relative mb-0.5 rounded-lg px-3 py-2 text-left text-[12.5px] transition-colors " +
                  (on
                    ? "bg-[var(--accent-soft)] font-semibold text-[var(--text)]"
                    : "text-[var(--text-2)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]")
                }
              >
                {on && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-[var(--accent)]" />}
                {x.label}
              </button>
            );
          })}
        </div>

        {/* 右：当前分类内容（独立滚动） */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-[var(--border-soft)] px-5 py-3.5">
            <div className="text-[15px] font-bold text-[var(--text)]">
              {SECTIONS.find((x) => x.key === section)?.label}
            </div>
            <button
              onClick={onClose}
              className="rounded-md px-2 py-1 text-sm text-[var(--text-2)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {section === "general" && (
              <div className="space-y-1">
                <ToggleRow
                  title="悬浮提示"
                  desc="鼠标停留时弹出 Skill / Memory 详情浮层"
                  on={s.hoverPreview}
                  onChange={(v) => setSetting("hoverPreview", v)}
                />
                <ToggleRow
                  title="多 Agent 全自动接力"
                  desc="开：唤醒自动注入（终端静默后），团队无人工接力跑；关：半自动（弹提示，点击才唤醒）"
                  on={s.autoRelay}
                  onChange={(v) => setSetting("autoRelay", v)}
                />
                <ActionRow
                  title="检查更新"
                  desc={appVer ? `当前版本 v${appVer} · 手动向更新源查询新版本` : "手动向更新源查询新版本"}
                  action="立即检查"
                  busyLabel="检查中…"
                  busy={checking}
                  onAction={doCheckUpdate}
                  hint={updHint?.text}
                  hintTone={updHint?.tone}
                />
              </div>
            )}
            {section === "appearance" && (
              <div className="space-y-1">
                <ChoiceGrid
                  title="外观主题"
                  desc="浅色（奶油）/ 深色（暖棕黑）/ 跟随系统；终端配色保持暖深不变"
                  cols={3}
                  options={THEMES.map((t) => ({ key: t.key, label: t.label, desc: t.desc }))}
                  value={s.theme}
                  onChange={(k) => {
                    setSetting("theme", k);
                    applyTheme(k);
                    watchSystemTheme();
                  }}
                />
                <ChoiceGrid
                  title="界面字体"
                  desc="全局 UI、会话、编辑器、Markdown 预览跟随；终端与代码块保持等宽"
                  cols={2}
                  large
                  options={FONTS.map((f) => ({ key: f.key, label: f.label, desc: f.desc, style: { fontFamily: f.stack } }))}
                  value={s.fontFamily}
                  onChange={(k) => {
                    setSetting("fontFamily", k);
                    applyFont(k);
                  }}
                />
              </div>
            )}
            {section === "terminal" && (
              <div className="space-y-1">
                <ToggleRow
                  title="终端中键自动滚动"
                  desc="按下鼠标中键出现滚轮锚点，移动即按距离自动滚动（仿浏览器）；vim 等接管鼠标的应用内自动让位"
                  on={s.middleClickScroll}
                  onChange={(v) => setSetting("middleClickScroll", v)}
                />
                <ToggleRow
                  title="工作流面板"
                  desc="终端底部的工作流进度面板；关闭后所有终端均不显示（绑定与进度保留）"
                  on={s.showWorkflowPanel}
                  onChange={(v) => setSetting("showWorkflowPanel", v)}
                />
              </div>
            )}
            {section === "files" && (
              <div className="space-y-1">
                <ChoiceGrid
                  title="文件单击行为"
                  desc="作用于文件树（全局搜索单独由下方开关控制）；选「单击选中」可像资源管理器那样 Ctrl/Shift 多选后批量操作"
                  cols={2}
                  options={CLICK_MODES.map((m) => ({ key: m.key, label: m.label, desc: m.desc }))}
                  value={s.fileClickMode}
                  onChange={(k) => setSetting("fileClickMode", k)}
                />
                <ToggleRow
                  title="全局搜索后打开文件"
                  desc="开：单击搜索结果即在编辑器打开；关：仅在 File 页签定位选中、不打开（适合找文件喂给 AI，不切走终端）"
                  on={s.openFileFromSearch}
                  onChange={(v) => setSetting("openFileFromSearch", v)}
                />
                <NumberField
                  title="全局搜索索引上限"
                  desc="双击 Shift 全局搜索一次最多索引的文件数；超出的不会被搜到。默认 10 万"
                  min={1000}
                  step={10000}
                  draft={draft}
                  setDraft={setDraft}
                  commit={commit}
                  hint={countLabel}
                  hintAccent={over}
                />
                <NumberField
                  title="文件编辑大小上限"
                  desc="编辑器可打开的最大文件体积（MB）；过大文件编辑可能卡顿，建议 ≤ 20。默认 10"
                  min={1}
                  step={1}
                  draft={editMbDraft}
                  setDraft={setEditMbDraft}
                  commit={commitEditMb}
                  hint="MB · 对新打开的文件生效"
                />
              </div>
            )}
            {section === "connection" && <ConnectionSettings />}
            <div className="mt-4 border-t border-[var(--border)] pt-3 text-[10px] text-[var(--text-3)]">
              更多全局设置将陆续加入此处。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

