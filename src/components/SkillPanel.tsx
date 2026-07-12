import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  listManagedSkills,
  setSkillEnabled,
  applySkillTemplate,
  type ManagedSkill,
} from "../catalog";
import {
  loadTemplates,
  loadActiveTemplate,
  saveActiveTemplate,
  type SkillTemplate,
} from "../skillTemplates";
import SearchBox from "./ui/SearchBox";
import InfoCard from "./ui/InfoCard";
import SkillTemplateModal from "./SkillTemplateModal";
import TemplatePicker from "./TemplatePicker";
import { useSettings } from "../settings";
import { searchMatch } from "../search";
import {
  DEFAULT_SKILL_ROOT,
  downtimeRelFromSkillsRel,
  loadSkillRoots,
  resolveActiveSkillRoot,
} from "../skillRoots";

// 收藏按 skill 文件夹名(dir，稳定)持久化：{ [projectDir]: dir[] }
const FAV_KEY = "htybox.favSkills.v1";
function loadFavs(projectDir: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(FAV_KEY) || "{}");
    return Array.isArray(all[projectDir]) ? all[projectDir] : [];
  } catch {
    return [];
  }
}
function saveFavs(projectDir: string, dirs: string[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(FAV_KEY) || "{}");
    all[projectDir] = dirs;
    localStorage.setItem(FAV_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** Skill 面板：上架/下架管理 + 集合模板（工作区级）。卡片只显名+动作，详情走悬浮浮层。 */
export default function SkillPanel({ projectDir }: { projectDir: string }) {
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null); // 应用模板的 warnings 提示
  const [favs, setFavs] = useState<string[]>(() => loadFavs(projectDir));
  const [templates, setTemplates] = useState<SkillTemplate[]>(() => loadTemplates(projectDir));
  const [activeId, setActiveId] = useState<string | null>(() => loadActiveTemplate(projectDir));
  const [showTpl, setShowTpl] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const { hoverPreview, skillRoots: globalRoots } = useSettings();
  const [root, setRoot] = useState(DEFAULT_SKILL_ROOT);
  const [rootFound, setRootFound] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  let downRel = ".claude/downtime/skills";
  try {
    downRel = downtimeRelFromSkillsRel(root);
  } catch {
    /* 非法配置时仍用默认提示 */
  }

  const reload = (activeRoot: string) =>
    listManagedSkills(projectDir, activeRoot)
      .then(setSkills)
      .catch((e) => setErr(String(e)));

  const resolveAndLoad = () => {
    const cands = loadSkillRoots(projectDir);
    setCandidates(cands);
    setErr(null);
    resolveActiveSkillRoot(projectDir, cands)
      .then((r) => {
        setRoot(r.active);
        setRootFound(r.found);
        return reload(r.active);
      })
      .catch((e) => setErr(String(e)));
  };

  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    resolveAndLoad();
    setFavs(loadFavs(projectDir));
    setTemplates(loadTemplates(projectDir));
    setActiveId(loadActiveTemplate(projectDir));
    listen("skills-changed", () => {
      resolveActiveSkillRoot(projectDir, loadSkillRoots(projectDir))
        .then((r) => {
          setRoot(r.active);
          setRootFound(r.found);
          return reload(r.active);
        })
        .catch((e) => setErr(String(e)));
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    const onRoots = () => resolveAndLoad();
    window.addEventListener("htybox:skill-roots", onRoots);
    return () => {
      disposed = true;
      un?.();
      window.removeEventListener("htybox:skill-roots", onRoots);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir, globalRoots]);

  const toggleFav = (dir: string) =>
    setFavs((prev) => {
      const next = prev.includes(dir) ? prev.filter((d) => d !== dir) : [...prev, dir];
      saveFavs(projectDir, next);
      return next;
    });

  // 单个上架/下架 → 操作后重载；集合已偏离模板 → 清空 active 标记（自定义态）
  const toggleEnabled = async (s: ManagedSkill) => {
    try {
      await setSkillEnabled(projectDir, s.dir, !s.enabled, root);
      setActiveId(null);
      saveActiveTemplate(projectDir, null);
      reload(root);
    } catch (e) {
      setNote(String(e));
    }
  };

  // 应用模板：模板内全上架、其余全下架
  const applyTpl = async (t: SkillTemplate) => {
    setNote(null);
    try {
      const warnings = await applySkillTemplate(projectDir, t.skillDirs, root);
      setActiveId(t.id);
      saveActiveTemplate(projectDir, t.id);
      reload(root);
      if (warnings.length)
        setNote(`已应用「${t.name}」，但 ${warnings.length} 项未处理：${warnings.join("；")}`);
    } catch (e) {
      setNote(String(e));
    }
  };

  const favSet = useMemo(() => new Set(favs), [favs]);
  const filtered = useMemo(() => {
    if (!q.trim()) return skills;
    return skills.filter((s) => searchMatch(q, s.name, s.description));
  }, [skills, q]);
  const enabled = filtered.filter((s) => s.enabled);
  const disabled = filtered.filter((s) => !s.enabled);
  const favEnabled = enabled.filter((s) => favSet.has(s.dir));
  const restEnabled = enabled.filter((s) => !favSet.has(s.dir));

  const enableBtn = (s: ManagedSkill) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        toggleEnabled(s);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      title={s.enabled ? `下架（移至 ${downRel}）` : `上架（移回 ${root}）`}
      className={
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold " +
        (s.enabled
          ? "text-[var(--text-3)] hover:bg-[var(--surface)] hover:text-[var(--danger)]"
          : "bg-[var(--accent)] text-white hover:bg-[var(--accent-text)]")
      }
    >
      {s.enabled ? "下架" : "上架"}
    </button>
  );
  const preview = (s: ManagedSkill) => (
    <>
      <div className="text-[13px] font-semibold text-[var(--text)]">{s.name}</div>
      <div className="mt-0.5 font-mono text-[10.5px] text-[var(--accent-text)]">{s.invoke}</div>
      <div className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-2)]">
        {s.description || "（无描述）"}
      </div>
    </>
  );
  // 单张已上架卡片（收藏区 / 已上架区共用，避免重复）
  const enabledCard = (s: ManagedSkill) => (
    <InfoCard
      key={s.path}
      name={s.name}
      hoverEnabled={hoverPreview}
      favorite={{ active: favSet.has(s.dir), onToggle: () => toggleFav(s.dir) }}
      trailing={enableBtn(s)}
      onDragStart={(e) => {
        e.dataTransfer.setData(
          "application/x-htybox-item",
          JSON.stringify({ kind: "skill", invoke: s.invoke, path: s.path }),
        );
        e.dataTransfer.effectAllowed = "copy";
      }}
      preview={preview(s)}
    />
  );

  const activeTpl = templates.find((t) => t.id === activeId) ?? null;

  return (
    <div className="flex h-full flex-col bg-[var(--surface)]">
      {/* 模板栏：当前模板 → 下拉切换；⚙ 管理 */}
      <div className="flex items-center gap-1 px-2.5 pt-1.5 pb-1">
        <div className="relative min-w-0 flex-1">
        <button
          onClick={() => setShowPicker((v) => !v)}
          title="切换模板"
          className="flex w-full items-center gap-1.5 rounded-full bg-[var(--surface-hover)] px-3 py-1 text-[11px] font-semibold text-[var(--text-deep)] hover:bg-[var(--border-soft)]"
        >
          <svg
            className="h-3 w-3 shrink-0 text-[var(--accent)]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
          <span className="min-w-0 flex-1 truncate text-left">
            {activeTpl ? activeTpl.name || "（未命名）" : "未选择模板"}
          </span>
          <svg
            className="h-3 w-3 shrink-0 text-[var(--text-3)]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
          {showPicker && (
            <TemplatePicker
              templates={templates}
              activeId={activeId}
              onPick={(t) => applyTpl(t)}
              onManage={() => setShowTpl(true)}
              onClose={() => setShowPicker(false)}
            />
          )}
        </div>
        <button
          onClick={() => setShowTpl(true)}
          title="管理模板"
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[13px] text-[var(--text-2)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          ⚙
        </button>
      </div>
      <div className="px-2.5 pb-2">
        <SearchBox value={q} onChange={setQ} placeholder="搜索本工作区 skill…" />
        <div className="mt-1 px-0.5 text-[10px] leading-relaxed text-[var(--text-3)]">
          激活根{" "}
          <code className="text-[var(--text-2)]">{root}</code>
          {rootFound ? "" : "（候选目录均未发现，已回退首项）"}
          {candidates.length > 1 && (
            <span className="text-[var(--text-3)]"> · 候选 {candidates.length}</span>
          )}
        </div>
      </div>
      {note && (
        <div className="mx-2.5 mb-1.5 flex items-start gap-2 rounded-md border border-[var(--accent-border-soft)] bg-[var(--accent-soft)] px-2 py-1.5">
          <span className="text-[10.5px] leading-relaxed text-[var(--accent-text)]">{note}</span>
          <button
            onClick={() => setNote(null)}
            className="ml-auto shrink-0 text-[10px] text-[var(--text-3)] hover:text-[var(--text)]"
          >
            ✕
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {err && <div className="px-1 text-[11px] text-[var(--danger)]">加载失败：{err}</div>}
        {!err && skills.length === 0 && (
          <div className="px-1 pt-6 text-center text-[11px] leading-relaxed text-[var(--text-3)]">
            本工作区没有 skill
            <br />
            <span className="text-[10px]">
              （放到 <code className="text-[var(--text-2)]">{root}/</code> 下；可在设置 → Skill 更换根目录）
            </span>
          </div>
        )}
        {/* 收藏（已上架中被收藏的，单独成区，带 ❤ 标题 + 分隔线） */}
        {favEnabled.length > 0 && (
          <div className="mb-2">
            <div className="flex items-center gap-1.5 px-1 pt-1 pb-1.5 text-[10px] font-semibold tracking-wider text-[var(--text-3)] uppercase">
              <svg className="h-3 w-3 text-[var(--accent)]" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              收藏 · {favEnabled.length}
            </div>
            <div className="space-y-1.5">{favEnabled.map(enabledCard)}</div>
            <div className="my-2.5 border-t border-[var(--border)]" />
          </div>
        )}
        {restEnabled.length > 0 && (
          <div className="mb-1.5 px-1 pt-1 text-[10px] font-semibold tracking-wider text-[var(--text-3)] uppercase">
            已上架 · {restEnabled.length}
          </div>
        )}
        <div className="space-y-1.5">{restEnabled.map(enabledCard)}</div>
        {disabled.length > 0 && (
          <>
            <div className="mt-3 mb-1.5 px-1 text-[10px] font-semibold tracking-wider text-[var(--text-3)] uppercase">
              已下架 · {disabled.length}
            </div>
            <div className="space-y-1.5">
              {disabled.map((s) => (
                <InfoCard
                  key={s.path}
                  name={s.name}
                  hoverEnabled={hoverPreview}
                  dimmed
                  trailing={enableBtn(s)}
                  preview={preview(s)}
                />
              ))}
            </div>
          </>
        )}
      </div>
      {showTpl && (
        <SkillTemplateModal
          projectDir={projectDir}
          skills={skills}
          templates={templates}
          onClose={() => setShowTpl(false)}
          onChange={(list) => setTemplates(list)}
        />
      )}
    </div>
  );
}
