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
import {
  useSkillTagStore,
  useSkillTags,
  useSkillVocab,
  getSkillTags,
  getSkillTagIds,
  createSkillTag,
  addSkillTag,
  removeSkillTag,
  toggleSkillTag,
  updateSkillTag,
  deleteSkillTag,
  countSkillsWithTag,
} from "../skillTags";
import { tagDot } from "../tagColors";
import { getWsState, setWsState } from "../wsState";
import { TagEditor, type TagEditorModel } from "./TagEditor";
import ContextMenu from "./ui/ContextMenu";
import { useMaskDismiss } from "./ui/maskDismiss";
import {
  htyenvApplyEnabledSet,
  htyenvSetSkillEnabled,
  htyenvStatus,
  htyenvWorkspaceSkills,
} from "../htyenv";

// 收藏按 skill 文件夹名(dir，稳定)持久化：{ [projectDir]: dir[] }
const FAV_KEY = "htybox.favSkills.v1";
const FILTER_KEY = "htybox.skillTagFilter.v1";

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

function SkillTagEditorHost({
  projectDir,
  dir,
  name,
  x,
  y,
  onClose,
}: {
  projectDir: string;
  dir: string;
  name: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const tags = useSkillTags(projectDir, dir);
  const vocab = useSkillVocab(projectDir);
  const model: TagEditorModel = {
    tags,
    vocab,
    subjectName: name,
    entityLabel: "该 skill 标签",
    applyHint: "回车即打到当前 skill",
    removeUnit: "个 skill",
    createTag: (n, c) => createSkillTag(projectDir, n, c),
    addTag: (id) => addSkillTag(projectDir, dir, id),
    removeTag: (id) => removeSkillTag(projectDir, dir, id),
    toggleTag: (id) => toggleSkillTag(projectDir, dir, id),
    updateTag: (id, patch) => updateSkillTag(projectDir, id, patch),
    deleteTag: (id) => deleteSkillTag(projectDir, id),
    countWithTag: (id) => countSkillsWithTag(projectDir, id),
  };
  return <TagEditor x={x} y={y} onClose={onClose} model={model} />;
}

/** Skill 面板：上架/下架管理 + 集合模板 + 独立标签/筛选（工作区级）。 */
export default function SkillPanel({ projectDir }: { projectDir: string }) {
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [favs, setFavs] = useState<string[]>(() => loadFavs(projectDir));
  const [templates, setTemplates] = useState<SkillTemplate[]>(() => loadTemplates(projectDir));
  const [activeId, setActiveId] = useState<string | null>(() => loadActiveTemplate(projectDir));
  const [showTpl, setShowTpl] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const { hoverPreview, skillRoots: globalRoots } = useSettings();
  const [root, setRoot] = useState(DEFAULT_SKILL_ROOT);
  const [rootFound, setRootFound] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  // canonical 模式(plan-5):工作区含 .htyworkflows → 数据源/启停/模板走 htyenv 命令,绝不 rename 生成物
  const [canonical, setCanonical] = useState(false);
  const tagStore = useSkillTagStore(projectDir);
  const vocab = tagStore.vocab;
  const [menu, setMenu] = useState<{ x: number; y: number; s: ManagedSkill } | null>(null);
  const [tagEditor, setTagEditor] = useState<{ x: number; y: number; s: ManagedSkill } | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterMask = useMaskDismiss(() => setFilterOpen(false));
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(() =>
    getWsState<string[]>(FILTER_KEY, projectDir, []),
  );
  useEffect(() => setSelectedTagIds(getWsState<string[]>(FILTER_KEY, projectDir, [])), [projectDir]);
  const setFilter = (ids: string[]) => {
    setSelectedTagIds(ids);
    setWsState(FILTER_KEY, projectDir, ids);
  };
  const toggleFilter = (id: string) =>
    setFilter(selectedTagIds.includes(id) ? selectedTagIds.filter((x) => x !== id) : [...selectedTagIds, id]);
  const effectiveTagIds = useMemo(
    () => selectedTagIds.filter((id) => vocab.some((t) => t.id === id)),
    [selectedTagIds, vocab],
  );

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

  // canonical 列表 → ManagedSkill 形状(dir=id 稳定标识,收藏/标签/模板全兼容)
  const reloadCanonical = () =>
    htyenvWorkspaceSkills(projectDir)
      .then((list) =>
        setSkills(
          list.map((s) => ({
            name: s.name,
            description: s.description ?? "",
            dir: s.id,
            invoke: "/" + s.name,
            path: s.path,
            enabled: s.enabled,
          })),
        ),
      )
      .catch((e) => setErr(String(e)));

  const resolveAndLoad = () => {
    setErr(null);
    htyenvStatus(projectDir)
      .then((st) => {
        const isCanonical = st.present && st.manifestPresent && !st.manifestError;
        setCanonical(isCanonical);
        if (isCanonical) return reloadCanonical();
        const cands = loadSkillRoots(projectDir);
        setCandidates(cands);
        return resolveActiveSkillRoot(projectDir, cands).then((r) => {
          setRoot(r.active);
          setRootFound(r.found);
          return reload(r.active);
        });
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
      resolveAndLoad();
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

  const toggleEnabled = async (s: ManagedSkill) => {
    try {
      if (canonical) await htyenvSetSkillEnabled(projectDir, s.dir, !s.enabled);
      else await setSkillEnabled(projectDir, s.dir, !s.enabled, root);
      setActiveId(null);
      saveActiveTemplate(projectDir, null);
      if (canonical) reloadCanonical();
      else reload(root);
    } catch (e) {
      setNote(String(e));
    }
  };

  const applyTpl = async (t: SkillTemplate) => {
    setNote(null);
    try {
      const warnings = canonical
        ? (await htyenvApplyEnabledSet(projectDir, t.skillDirs))[1]
        : await applySkillTemplate(projectDir, t.skillDirs, root);
      setActiveId(t.id);
      saveActiveTemplate(projectDir, t.id);
      if (canonical) reloadCanonical();
      else reload(root);
      if (warnings.length)
        setNote(`已应用「${t.name}」，但 ${warnings.length} 项未处理：${warnings.join("；")}`);
    } catch (e) {
      setNote(String(e));
    }
  };

  const favSet = useMemo(() => new Set(favs), [favs]);
  // 搜索：仅名/描述（不含标签名）；标签走下方筛选器（OR）
  const filtered = useMemo(() => {
    return skills.filter((s) => {
      if (q.trim() && !searchMatch(q, s.name, s.description)) return false;
      if (effectiveTagIds.length > 0) {
        const ids = getSkillTagIds(projectDir, s.dir);
        if (!effectiveTagIds.some((tid) => ids.includes(tid))) return false;
      }
      return true;
    });
  }, [skills, q, effectiveTagIds, projectDir, tagStore]);
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
      title={
        canonical
          ? s.enabled
            ? "下架（登记 enabled=false,删各端薄壳;canonical 不动）"
            : "上架（登记 enabled=true,重生成各端薄壳）"
          : s.enabled
            ? `下架（移至 ${downRel}）`
            : `上架（移回 ${root}）`
      }
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
  const skillChips = (s: ManagedSkill) => {
    const cardTags = getSkillTags(projectDir, s.dir);
    if (cardTags.length === 0) return undefined;
    return (
      <div className="mt-1 flex flex-wrap gap-1">
        {cardTags.map((t) => (
          <span
            key={t.id}
            className="inline-flex items-center gap-1 rounded-[4px] border px-1 py-px text-[10px] font-semibold"
            style={{
              color: tagDot(t.color),
              borderColor: tagDot(t.color) + "66",
              backgroundColor: tagDot(t.color) + "22",
            }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tagDot(t.color) }} />
            {t.name}
          </span>
        ))}
      </div>
    );
  };
  const openCtx = (s: ManagedSkill) => (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, s });
  };

  const enabledCard = (s: ManagedSkill) => (
    <InfoCard
      key={s.path}
      name={s.name}
      hoverEnabled={hoverPreview}
      favorite={{ active: favSet.has(s.dir), onToggle: () => toggleFav(s.dir) }}
      trailing={enableBtn(s)}
      chips={skillChips(s)}
      onContextMenu={openCtx(s)}
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
        {vocab.length > 0 && (
          <div className="relative mt-1.5">
            <button
              onClick={() => setFilterOpen((v) => !v)}
              className={
                "flex w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] transition-colors " +
                (effectiveTagIds.length > 0
                  ? "border-[var(--accent-border)] bg-[var(--accent)]/10 text-[var(--text)]"
                  : "border-[var(--border)] bg-[var(--elevated)] text-[var(--text-2)] hover:bg-[var(--surface-soft)]")
              }
            >
              <svg
                className="h-3.5 w-3.5 shrink-0 text-[var(--text-2)]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 5h18l-7 8v6l-4-2v-4z" />
              </svg>
              {effectiveTagIds.length === 0 ? (
                <>
                  <span>标签筛选</span>
                  <span className="ml-auto text-[10px] text-[var(--text-3)]">点击多选</span>
                </>
              ) : (
                <>
                  {(() => {
                    const sel = vocab.filter((t) => selectedTagIds.includes(t.id));
                    const shown = sel.slice(0, 3);
                    const rest = sel.length - shown.length;
                    return (
                      <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                        {shown.map((t) => (
                          <span key={t.id} className="inline-flex shrink-0 items-center gap-1">
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tagDot(t.color) }} />
                            {t.name}
                          </span>
                        ))}
                        {rest > 0 && (
                          <span className="shrink-0 text-[10px] font-semibold text-[var(--text-3)]">…+{rest}</span>
                        )}
                      </span>
                    );
                  })()}
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      setFilter([]);
                    }}
                    title="清除筛选"
                    className="shrink-0 px-0.5 leading-none text-[var(--text-3)] hover:text-[var(--text)]"
                  >
                    ✕
                  </span>
                </>
              )}
              <svg
                className={
                  "h-3 w-3 shrink-0 text-[var(--text-3)] transition-transform " + (filterOpen ? "rotate-180" : "")
                }
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
            {filterOpen && (
              <>
                <div className="fixed inset-0 z-[60]" {...filterMask} />
                <div className="absolute top-full right-0 left-0 z-[61] mt-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--elevated)] py-1 shadow-xl">
                  <div className="flex items-center justify-between px-3 py-1">
                    <span className="text-[10px] font-bold tracking-wide text-[var(--text-2)]">按标签筛选</span>
                    <span className="text-[10px] text-[var(--text-3)]">任一匹配 · OR</span>
                  </div>
                  <div className="my-1 border-t border-[var(--border-soft)]" />
                  {vocab.map((t) => {
                    const on = selectedTagIds.includes(t.id);
                    const count = skills.filter((s) => getSkillTagIds(projectDir, s.dir).includes(t.id)).length;
                    return (
                      <button
                        key={t.id}
                        onClick={() => toggleFilter(t.id)}
                        className={
                          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] " +
                          (on ? "bg-[var(--accent)]/5" : "hover:bg-[var(--surface)]")
                        }
                      >
                        <span
                          className={
                            "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border " +
                            (on
                              ? "border-[var(--accent)] bg-[var(--accent)]"
                              : "border-[var(--border)] bg-[var(--elevated)]")
                          }
                        >
                          {on && (
                            <svg
                              className="h-2.5 w-2.5 text-white"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                          )}
                        </span>
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tagDot(t.color) }} />
                        <span className="min-w-0 flex-1 truncate text-[var(--text-deep)]">{t.name}</span>
                        <span className="shrink-0 text-[10px] text-[var(--text-3)]">{count}</span>
                      </button>
                    );
                  })}
                  <div className="my-1 border-t border-[var(--border-soft)]" />
                  <div className="flex items-center justify-between px-3 py-0.5">
                    <button
                      onClick={() => setFilter([])}
                      className="text-[10.5px] text-[var(--accent-text)] hover:underline"
                    >
                      清除全部
                    </button>
                    <span className="text-[10px] text-[var(--text-3)]">已选 {effectiveTagIds.length}</span>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        <div className="mt-1 px-0.5 text-[10px] leading-relaxed text-[var(--text-3)]">
          {canonical ? (
            <>
              <span className="mr-1 rounded border border-[var(--accent-border-soft)] bg-[var(--accent-soft)] px-1 py-px font-semibold text-[var(--accent-text)]">
                canonical
              </span>
              真源 <code className="text-[var(--text-2)]">.htyworkflows/skills</code>
              （上下架=登记元数据+薄壳增删）
            </>
          ) : (
            <>
              激活根{" "}
              <code className="text-[var(--text-2)]">{root}</code>
              {rootFound ? "" : "（候选目录均未发现，已回退首项）"}
              {candidates.length > 1 && (
                <span className="text-[var(--text-3)]"> · 候选 {candidates.length}</span>
              )}
            </>
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
        {!err && skills.length > 0 && filtered.length === 0 && (
          <div className="px-1 pt-6 text-center text-[11px] text-[var(--text-3)]">无匹配 skill</div>
        )}
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
                  chips={skillChips(s)}
                  onContextMenu={openCtx(s)}
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
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ id: "tags", label: "标签…" }]}
          onAction={(id) => {
            if (id === "tags") setTagEditor({ x: menu.x, y: menu.y, s: menu.s });
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {tagEditor && (
        <SkillTagEditorHost
          projectDir={projectDir}
          dir={tagEditor.s.dir}
          name={tagEditor.s.name}
          x={tagEditor.x}
          y={tagEditor.y}
          onClose={() => setTagEditor(null)}
        />
      )}
    </div>
  );
}
