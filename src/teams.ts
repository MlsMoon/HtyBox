// M7-G 团队配置：Team / TeamAgentDef 数据模型 + 团队库（localStorage 持久化）+ 导入导出。
// 设计见 Document/08 §2。持久化沿用本项目既有 localStorage 约定（与 settings/workspaces/favorites 一致），
// 而非 08 文档提的 tauri-plugin-store —— 全前端、零后端改动。
import type { AgentKind } from "./profiles";

export interface TeamAgentDef {
  id: string;
  roleName: string; // 身份/角色名，如 "负责人""维护员""计划书写员"
  agentKind: Exclude<AgentKind, "shell">; // 团队成员只能是真正的 agent(非裸 shell)
  model: string; // 模型（--model）；空 = 用 CLI 默认
  responsibility: string; // 职责内容（自由文本）→ 启动注入为该 agent 角色（完整注入在 M7-C）
  isLead: boolean; // 编排者(Lead)；整队恰好一个为 true
}

export interface Team {
  id: string;
  name: string;
  description?: string;
  agents: TeamAgentDef[];
}

// 每类 agent 的默认可选模型（编辑器里作 datalist 建议，可自由输入）。未来可在设置里维护/探测 CLI。
// cursor 实测 `cursor-agent --list-models` 返回 200+ 项，这里只精选几个常用的做建议、非强校验。
export const DEFAULT_MODELS: Record<Exclude<AgentKind, "shell">, string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-5-codex", "o3"],
  cursor: ["auto", "claude-sonnet-5-high", "gpt-5.2", "composer-2.5"],
  // kimi 别名来自 `kimi provider list --json` 实测(v0.26.0 managed:kimi-code 共 3 个；k3 为本机默认)
  kimi: ["kimi-code/k3", "kimi-code/kimi-for-coding", "kimi-code/kimi-for-coding-highspeed"],
};

const KEY = "htybox.teams.v1";

export function genId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function loadTeams(): Team[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (Array.isArray(v)) return v as Team[];
  } catch {
    /* ignore */
  }
  return [];
}

export function saveTeams(teams: Team[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(teams));
  } catch {
    /* ignore */
  }
}

export function emptyAgent(): TeamAgentDef {
  return {
    id: genId(),
    roleName: "",
    agentKind: "claude",
    model: "",
    responsibility: "",
    isLead: false,
  };
}

export function emptyTeam(): Team {
  const lead = emptyAgent();
  lead.isLead = true;
  return { id: genId(), name: "", description: "", agents: [lead] };
}

/** 首次无团队时给一个示例团队（Document/08 §2.2 的双人组）。 */
export function seedTeam(): Team {
  return {
    id: genId(),
    name: "标准开发双人组",
    description: "负责人拆解派活，维护员探查代码现状",
    agents: [
      {
        id: genId(),
        roleName: "负责人",
        agentKind: "claude",
        model: "opus",
        responsibility: "主任务需求；拆解任务、派活、汇总结果",
        isLead: true,
      },
      {
        id: genId(),
        roleName: "维护员",
        agentKind: "codex",
        model: "",
        responsibility: "探索/维护当前代码现状、回报代码事实",
        isLead: false,
      },
    ],
  };
}

/** 校验：团队需有名字、≥1 成员、恰好一个 Lead、成员都有角色名。返回错误文案或 null。 */
export function validateTeam(team: Team): string | null {
  if (!team.name.trim()) return "请填写团队名";
  if (team.agents.length === 0) return "至少需要一个成员";
  if (team.agents.some((a) => !a.roleName.trim())) return "每个成员都要填角色名";
  const leads = team.agents.filter((a) => a.isLead).length;
  if (leads !== 1) return "整队需恰好一个 Lead（编排者）";
  return null;
}

export function exportTeams(teams: Team[]): string {
  return JSON.stringify(teams, null, 2);
}

const VALID_AGENT_KINDS: Exclude<AgentKind, "shell">[] = ["claude", "codex", "cursor", "kimi"];

/** 解析导入 JSON（数组或单个），重新分配 id 避免与现有冲突。 */
export function importTeams(json: string): Team[] {
  const parsed = JSON.parse(json);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map((t) => ({
    id: genId(),
    name: String(t?.name ?? "导入的团队"),
    description: t?.description ? String(t.description) : undefined,
    agents: (Array.isArray(t?.agents) ? t.agents : []).map((a: Partial<TeamAgentDef>) => ({
      id: genId(),
      roleName: String(a?.roleName ?? ""),
      agentKind: VALID_AGENT_KINDS.includes(a?.agentKind as Exclude<AgentKind, "shell">)
        ? (a!.agentKind as Exclude<AgentKind, "shell">)
        : "claude",
      model: String(a?.model ?? ""),
      responsibility: String(a?.responsibility ?? ""),
      isLead: Boolean(a?.isLead),
    })),
  }));
}
