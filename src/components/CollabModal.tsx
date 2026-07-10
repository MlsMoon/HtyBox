import { useState } from "react";
import {
  type Team,
  loadTeams,
  saveTeams,
  seedTeam,
  emptyTeam,
  exportTeams,
  importTeams,
  genId,
} from "../teams";
import type { AgentSpec } from "../mcp";
import TeamEditor from "./TeamEditor";
import RunPanel from "./RunPanel";
import { useMaskDismiss } from "./ui/maskDismiss";

/** Team → 启动规格（一键开启时交给 launchAgents）。 */
function teamToSpecs(team: Team): AgentSpec[] {
  return team.agents.map((a) => ({
    agentId: a.id,
    roleName: a.roleName,
    role: a.isLead ? ("lead" as const) : ("worker" as const),
    agentKind: a.agentKind,
    model: a.model,
    responsibility: a.responsibility,
  }));
}

/**
 * 多 Agent 协作界面（M7-G）：团队库 + Team 编辑器。
 * 「团队库 / 运行面板 / MCP 仪表盘」三子标签中先实装团队库（后两者 M7-F）。
 */
export default function CollabModal({
  onClose,
  onLaunch,
  canLaunch,
}: {
  onClose: () => void;
  onLaunch: (specs: AgentSpec[]) => void;
  canLaunch: boolean;
}) {
  const [teams, setTeams] = useState<Team[]>(() => {
    const t = loadTeams();
    if (t.length) return t;
    const s = [seedTeam()];
    saveTeams(s);
    return s;
  });
  const [editing, setEditing] = useState<Team | null>(null);
  const [tab, setTab] = useState<"library" | "run">("library");
  const [msg, setMsg] = useState("");
  const mask = useMaskDismiss(onClose);

  const persist = (next: Team[]) => {
    setTeams(next);
    saveTeams(next);
  };
  const flash = (m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg(""), 2200);
  };

  const onSave = (team: Team) => {
    const exists = teams.some((t) => t.id === team.id);
    persist(exists ? teams.map((t) => (t.id === team.id ? team : t)) : [...teams, team]);
    setEditing(null);
  };
  const onDuplicate = (team: Team) =>
    persist([
      ...teams,
      { ...team, id: genId(), name: team.name + " 副本", agents: team.agents.map((a) => ({ ...a, id: genId() })) },
    ]);

  const doExport = () => {
    navigator.clipboard?.writeText(exportTeams(teams)).then(
      () => flash("已复制全部团队 JSON 到剪贴板"),
      () => flash("复制失败"),
    );
  };
  const doImport = () => {
    navigator.clipboard
      ?.readText()
      .then((txt) => {
        const imported = importTeams(txt);
        if (!imported.length) return flash("剪贴板没有可导入的团队 JSON");
        persist([...teams, ...imported]);
        flash(`已导入 ${imported.length} 个团队`);
      })
      .catch(() => flash("读取剪贴板失败 / JSON 解析失败"));
  };

  if (editing) {
    return <TeamEditor team={editing} onCancel={() => setEditing(null)} onSave={onSave} />;
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-6"
      {...mask}
    >
      <div
        className="flex max-h-[80vh] w-[760px] max-w-full flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <span className="text-sm font-bold text-[var(--text)]">Agent Team</span>
          <div className="ml-2 flex gap-1">
            {(["library", "run"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  "rounded-md px-2.5 py-1 text-xs transition-colors " +
                  (tab === t
                    ? "bg-[var(--elevated)] font-semibold text-[var(--text)] shadow-sm"
                    : "text-[var(--text-2)] hover:text-[var(--text)]")
                }
              >
                {t === "library" ? "团队库" : "运行面板"}
              </button>
            ))}
          </div>
          {msg && <span className="text-xs text-[var(--accent-text)]">{msg}</span>}
          <div className="ml-auto flex items-center gap-2">
            {tab === "library" && (
              <button
                onClick={() => setEditing(emptyTeam())}
                className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-[var(--accent-text)]"
              >
                + 新建团队
              </button>
            )}
            <button
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--elevated)] hover:text-[var(--text)]"
            >
              ✕
            </button>
          </div>
        </div>

        {tab === "run" ? (
          <RunPanel />
        ) : (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto p-4">
          {teams.map((t) => (
            <div key={t.id} className="flex flex-col rounded-lg border border-[var(--border)] bg-[var(--elevated)] p-3">
              <div className="truncate text-sm font-semibold text-[var(--text)]">{t.name || "未命名团队"}</div>
              {t.description && (
                <div className="mt-0.5 truncate text-[11px] text-[var(--text-3)]">{t.description}</div>
              )}
              <div className="mt-2 flex flex-1 flex-col gap-1">
                {t.agents.map((a) => (
                  <div key={a.id} className="truncate text-xs text-[var(--text-2)]">
                    {a.isLead ? "👑" : "🔧"} {a.roleName || "(未命名)"}
                    <span className="text-[var(--text-3)]">
                      （{a.agentKind}
                      {a.model ? "·" + a.model : ""}）
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-1">
                <button
                  disabled={!canLaunch}
                  title={canLaunch ? "在当前工作区起整支团队" : "先打开一个工作区"}
                  onClick={() => {
                    onLaunch(teamToSpecs(t));
                    onClose();
                  }}
                  className="rounded-md bg-[var(--accent)]/12 px-2 py-1 text-xs font-semibold text-[var(--accent-text)] transition-colors hover:bg-[var(--accent)]/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ▶ 一键开启
                </button>
                <button
                  onClick={() => setEditing(structuredClone(t))}
                  className="rounded-md px-2 py-1 text-xs text-[var(--text-2)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
                >
                  编辑
                </button>
                <button
                  onClick={() => onDuplicate(t)}
                  className="rounded-md px-2 py-1 text-xs text-[var(--text-2)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
                >
                  复制
                </button>
                <button
                  onClick={() => persist(teams.filter((x) => x.id !== t.id))}
                  className="ml-auto rounded-md px-2 py-1 text-xs text-[var(--text-3)] hover:bg-[var(--surface)] hover:text-[var(--danger)]"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          {teams.length === 0 && (
            <div className="col-span-2 py-10 text-center text-sm text-[var(--text-3)]">
              还没有团队，点右上「+ 新建团队」
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
          <span className="text-[11px] text-[var(--text-3)]">团队存于本机（localStorage）</span>
          <div className="ml-auto flex gap-2">
            <button
              onClick={doImport}
              className="rounded-md border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-2)] hover:border-[var(--accent-border)] hover:text-[var(--text)]"
            >
              导入
            </button>
            <button
              onClick={doExport}
              className="rounded-md border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-2)] hover:border-[var(--accent-border)] hover:text-[var(--text)]"
            >
              导出
            </button>
          </div>
        </div>
          </>
        )}
      </div>
    </div>
  );
}
