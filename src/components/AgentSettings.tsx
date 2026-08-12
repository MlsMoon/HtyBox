import { useEffect, useState } from "react";
import {
  AGENT_IDS,
  ensureDetected,
  install,
  redetect,
  update,
  useAgentInstall,
  type AgentId,
  type AgentState,
} from "../agentInstall";
import { ProfileIcon } from "./ProfileIcon";

/** 设置「Agent」页展示的 CLI（顺序 = profiles.ts PROFILES 中 agent 顺序）。hermes 仅检测、无一键安装。 */
const AGENTS: {
  id: AgentId;
  name: string;
  command: string;
  desc: string;
  /** 为 true 时设置页不提供一键安装（需用户自行装 CLI） */
  detectOnly?: boolean;
}[] = [
  { id: "claude", name: "Claude Code", command: "claude", desc: "官方原生安装脚本（claude.ai），当前用户安装、免 admin" },
  { id: "codex", name: "Codex", command: "codex", desc: "官方独立安装脚本（chatgpt.com），不依赖 Node.js" },
  { id: "cursor", name: "Cursor", command: "cursor-agent", desc: "官方原生安装脚本（cursor.com），当前用户安装、免 admin" },
  { id: "kimi", name: "Kimi Code", command: "kimi", desc: "官方安装脚本（code.kimi.com）；首次启动前需自行安装 Git for Windows" },
  {
    id: "hermes",
    name: "Hermes",
    command: "hermes",
    desc: "Nous Hermes Agent（官方安装脚本）；本页仅检测 PATH，不提供一键安装",
    detectOnly: true,
  },
];

const btnCls =
  "shrink-0 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-1.5 text-[12px] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-text)] disabled:cursor-default disabled:opacity-60 disabled:hover:border-[var(--border)] disabled:hover:text-[var(--text)]";

/** 输出行是否已表明命令成功（此时条拉满，不再扫不定进度）。 */
function looksSucceeded(line?: string): boolean {
  if (!line) return false;
  return /successfully|up to date|already.*(latest|up to date)|更新成功|已是最新/i.test(line);
}

/**
 * 行内进度：脚本无可靠 % → 不定扫条（诚实表示「进行中」）；
 * 一旦输出出现成功句 → 立刻满条。组件随 busy 结束卸载，不会成功后还慢慢爬。
 */
function InlineProgress({ label, line }: { label: string; line?: string }) {
  const done = looksSucceeded(line);
  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="shrink-0 whitespace-nowrap text-[10.5px] text-[var(--text-2)]">
          {done ? "已完成，正在收尾…" : label}
        </span>
      </div>
      <div className="agent-cli-indet-track h-1.5 w-full rounded-full bg-[var(--surface-hover)]">
        {done ? (
          <div className="h-full w-full rounded-full bg-[var(--accent)]" />
        ) : (
          <div className="agent-cli-indet-bar" />
        )}
      </div>
      {line && (
        <div className="truncate font-mono text-[10px] leading-snug text-[var(--text-3)]" title={line}>
          {line}
        </div>
      )}
    </div>
  );
}

/** 行右侧：按状态渲染 安装/更新/重试 或状态文本。detectOnly=无一键安装。 */
function RowAction({
  id,
  st,
  detectOnly,
}: {
  id: AgentId;
  st: AgentState;
  detectOnly?: boolean;
}) {
  if (st.phase === "installed") {
    if (!detectOnly && st.updateAvailable && st.version && st.latestVersion) {
      return (
        <div className="flex shrink-0 items-center gap-2">
          <span className="max-w-[220px] truncate text-[11px] text-[var(--accent-text)]" title={`${st.version} → ${st.latestVersion}\n${st.path ?? ""}`}>
            可更新 · {st.version} → {st.latestVersion}
          </span>
          <button onClick={() => void update(id)} className={btnCls}>
            更新
          </button>
        </div>
      );
    }
    const latestHint =
      !detectOnly && st.latestVersion && st.version && st.version === st.latestVersion
        ? " · 最新"
        : "";
    return (
      <span className="shrink-0 whitespace-nowrap text-[11px] text-[var(--accent)]" title={st.path}>
        已安装{st.version ? ` · ${st.version}` : ""}
        {latestHint}
      </span>
    );
  }
  if (st.phase === "missing" || st.phase === "installFailed" || st.phase === "installing") {
    if (detectOnly) {
      return (
        <span className="shrink-0 whitespace-nowrap text-[11px] text-[var(--text-faint)]">未安装</span>
      );
    }
    const busy = st.phase === "installing";
    return (
      <button disabled={busy} onClick={() => void install(id)} className={btnCls}>
        {busy ? "安装中…" : st.phase === "installFailed" ? "重试" : "安装"}
      </button>
    );
  }
  if (st.phase === "updating" || st.phase === "updateFailed") {
    if (st.phase === "updating") {
      return <span className="shrink-0 whitespace-nowrap text-[11px] text-[var(--accent-text)]">更新中…</span>;
    }
    return (
      <button onClick={() => void update(id)} className={btnCls}>
        重试更新
      </button>
    );
  }
  return (
    <span className="shrink-0 text-[11px] text-[var(--text-faint)]">
      {st.phase === "checking" ? "检测中…" : "待检测"}
    </span>
  );
}

/** 设置「Agent」区：4 家 CLI 安装/最新检测 + 单 agent 安装或更新（带行内进度条）。 */
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
            未安装的 agent 无法开对应终端（顶栏图标置灰）；非最新可点「更新」（只更新当前这一项）；安装/更新显示进度
          </div>
        </div>
        <button disabled={checking} onClick={redetect} className={btnCls}>
          {checking ? "检测中…" : "重新检测"}
        </button>
      </div>

      {AGENTS.map((a) => {
        const row = st[a.id];
        const busy = row.phase === "installing" || row.phase === "updating";
        const failed = row.phase === "installFailed" || row.phase === "updateFailed";
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
              <RowAction id={a.id} st={row} detectOnly={a.detectOnly} />
            </div>
            {busy && (
              <InlineProgress
                label={row.phase === "updating" ? "正在更新…" : "正在安装…"}
                line={row.progressLine}
              />
            )}
            {row.phase === "missing" && <div className="mt-1.5 text-[11px] text-[var(--danger)]">未安装</div>}
            {failed && (
              <div className="mt-1.5 text-[11px] text-[var(--danger)]">
                {row.phase === "updateFailed" ? "更新失败，请检查网络后重试" : "安装失败，请检查网络后重试"}
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
            {failed && expanded === a.id && row.outputTail && (
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
