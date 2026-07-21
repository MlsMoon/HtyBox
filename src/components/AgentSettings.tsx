import { useEffect, useState } from "react";
import {
  AGENT_IDS,
  ensureDetected,
  install,
  redetect,
  useAgentInstall,
  type AgentId,
  type AgentState,
} from "../agentInstall";
import { ProfileIcon } from "./ProfileIcon";

/** 设置「Agent」页展示的 4 家 CLI（顺序 = profiles.ts PROFILES 中 agent 顺序）。 */
const AGENTS: { id: AgentId; name: string; command: string; desc: string }[] = [
  { id: "claude", name: "Claude Code", command: "claude", desc: "官方原生安装脚本（claude.ai），当前用户安装、免 admin" },
  { id: "codex", name: "Codex", command: "codex", desc: "官方独立安装脚本（chatgpt.com），不依赖 Node.js" },
  { id: "cursor", name: "Cursor", command: "cursor-agent", desc: "官方原生安装脚本（cursor.com），当前用户安装、免 admin" },
  { id: "kimi", name: "Kimi Code", command: "kimi", desc: "官方安装脚本（code.kimi.com）；首次启动前需自行安装 Git for Windows" },
];

/** 行右侧：按状态渲染 安装/重试 按钮或状态文本（安装中由按钮 busy 文案表达，不另加指示）。 */
function RowAction({ id, st }: { id: AgentId; st: AgentState }) {
  if (st.phase === "installed") {
    return (
      <span className="shrink-0 text-[11px] text-[var(--accent)]" title={st.path}>
        已安装{st.version ? ` · ${st.version}` : ""}
      </span>
    );
  }
  if (st.phase === "missing" || st.phase === "installFailed" || st.phase === "installing") {
    const busy = st.phase === "installing";
    return (
      <button
        disabled={busy}
        onClick={() => void install(id)}
        className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-1.5 text-[12px] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-text)] disabled:cursor-default disabled:opacity-60 disabled:hover:border-[var(--border)] disabled:hover:text-[var(--text)]"
      >
        {busy ? "安装中…" : st.phase === "installFailed" ? "重试" : "安装"}
      </button>
    );
  }
  return (
    <span className="shrink-0 text-[11px] text-[var(--text-faint)]">
      {st.phase === "checking" ? "检测中…" : "待检测"}
    </span>
  );
}

/** 设置「Agent」区：4 家 CLI 安装状态检测 + 未安装一键官方脚本安装（后台执行，失败展输出尾部）。 */
export default function AgentSettings() {
  const st = useAgentInstall();
  const [expanded, setExpanded] = useState<AgentId | null>(null);
  useEffect(() => {
    ensureDetected();
  }, []);
  const checking = AGENT_IDS.some((id) => st[id].phase === "checking");

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--text)]">Agent 命令行工具</div>
          <div className="text-[11px] text-[var(--text-faint)]">
            未安装的 agent 无法开对应终端（顶栏图标置灰）；点「安装」走官方脚本后台安装
          </div>
        </div>
        <button
          disabled={checking}
          onClick={redetect}
          className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-1.5 text-[12px] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-text)] disabled:cursor-default disabled:opacity-60 disabled:hover:border-[var(--border)] disabled:hover:text-[var(--text)]"
        >
          {checking ? "检测中…" : "重新检测"}
        </button>
      </div>

      {AGENTS.map((a) => {
        const row = st[a.id];
        return (
          <div key={a.id} className="rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--surface-soft)]">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                  <ProfileIcon id={a.id} />
                </span>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-1.5 text-sm font-medium text-[var(--text)]">
                    {a.name}
                    <code className="font-mono text-[10px] font-normal text-[var(--text-faint)]">{a.command}</code>
                  </div>
                  <div className="text-[11px] text-[var(--text-faint)]">{a.desc}</div>
                </div>
              </div>
              <RowAction id={a.id} st={row} />
            </div>
            {row.phase === "missing" && (
              <div className="mt-1.5 text-[11px] text-[var(--danger)]">未安装</div>
            )}
            {row.phase === "installFailed" && (
              <div className="mt-1.5 text-[11px] text-[var(--danger)]">
                安装失败，请检查网络后重试
                {row.outputTail && (
                  <button
                    onClick={() => setExpanded(expanded === a.id ? null : a.id)}
                    className="ml-2 text-[var(--text-faint)] underline underline-offset-2 hover:text-[var(--text)]"
                  >
                    {expanded === a.id ? "收起输出" : "查看输出"}
                  </button>
                )}
              </div>
            )}
            {row.phase === "installFailed" && expanded === a.id && row.outputTail && (
              <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-[var(--text-2)]">
                {row.outputTail}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
