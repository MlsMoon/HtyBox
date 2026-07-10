export type AgentKind = "claude" | "codex" | "shell";

export interface Profile {
  id: string;
  label: string;
  agentKind: AgentKind;
  /** 实际启动的 shell；claude/codex 走"先起 shell 再自动发命令" */
  shell: string;
  /** 启动后自动发送的命令（含回车），如 "claude\r"；实际命令由 launchCmdFor 计算 */
  launchCmd?: string;
  /** 标签/指示点颜色 */
  dotColor: string;
}

export const PROFILES: Profile[] = [
  {
    id: "powershell",
    label: "PowerShell",
    agentKind: "shell",
    shell: "powershell.exe",
    dotColor: "#8c8a82",
  },
  {
    id: "claude",
    label: "Claude Code",
    agentKind: "claude",
    shell: "powershell.exe",
    launchCmd: "claude\r",
    dotColor: "#d97757",
  },
  {
    id: "codex",
    label: "Codex",
    agentKind: "codex",
    shell: "powershell.exe",
    launchCmd: "codex\r",
    dotColor: "#10a37f",
  },
];

export const DEFAULT_PROFILE = PROFILES[0];

/**
 * 计算终端启动后自动发送的命令。复原(resume)=【按 session id 精确复原】，多终端各回各的：
 * 关键：claude/codex 的复原都是【按 session ID】(实测官方 --help)。为保持新建命令行干净，HtyBox
 * 不在新建时预分配 id，而是【新建发裸命令、启动后捕获 agent 自生成的真实 id】(见 TerminalDock 的
 * 捕获逻辑 + SESSION_IDS)，复原时按捕获到的 id 精确复原 → 不依赖 OSC 标题、不受状态符号(✳)影响。
 * - claude：新建 `claude`；复原 `claude --resume <id>`；无 id 退回 `claude --resume`(选择器)
 * - codex：新建 `codex`；复原 `codex resume <id>`；无 id 退回 `codex resume`(选择器)
 * - shell：无启动命令。
 */
export function launchCmdFor(
  agent: AgentKind,
  resume: boolean,
  sessionId?: string,
  model?: string,
  initialPrompt?: string,
): string | undefined {
  // 新建时按团队配置传 --model（claude/codex 均支持，已核实）；复原不带(会话自带模型)。
  // 清洗成安全 token(词字符+ . - :)，防破坏命令。
  const mm = (model ?? "").trim().replace(/[^\w.:-]/g, "");
  const m = mm ? ` --model ${mm}` : "";
  // M7-C：新建时把"先读协作简报"作为位置 prompt（claude/codex 默认进交互并处理它）。清洗双引号/换行防破坏命令。
  const ipRaw = (initialPrompt ?? "").replace(/["\r\n]/g, "").trim();
  const ip = ipRaw ? ` "${ipRaw}"` : "";
  // 仅接受标准 UUID 形态(crypto.randomUUID 产出)，防注入破坏命令。
  const sid = /^[0-9a-fA-F-]{36}$/.test((sessionId ?? "").trim())
    ? (sessionId as string).trim()
    : "";
  if (agent === "claude") {
    // 新建不预分配 id（保持命令行干净）；id 由 claude 自生成、HtyBox 启动后捕获。
    // 复原：有捕获到的 id 则 `claude --resume <id>` 精确复原；无则 `claude --resume` 选择器。
    if (resume) return sid ? `claude --resume ${sid}\r` : "claude --resume\r";
    return `claude${m}${ip}\r`;
  }
  // codex 不支持新建时预分配 id（无 --session-id），其 id 由 codex 自生成、HtyBox 启动后捕获。
  // 复原：有捕获到的 id 则 `codex resume <id>` 按 UUID 精确复原；无则 `codex resume` 选择器。
  if (agent === "codex") {
    if (resume) return sid ? `codex resume ${sid}\r` : "codex resume\r";
    return `codex${m}${ip}\r`;
  }
  return undefined;
}

export interface DragItem {
  kind: "skill" | "memory" | "file" | "text" | "workflow";
  invoke?: string; // skill 的 /调用串
  text?: string; // text(书签)：直接注入的文本内容
  path?: string; // 文件绝对路径（text 类型无 path）
  paths?: string[]; // file 多选拖拽：多个绝对路径（有则优先于 path）
  workflowId?: string; // workflow：拖到终端=绑定该工作流（非文本注入，落点分支处理）
}

/** 按目标终端的 agent 类型决定注入文本（落点时计算，而非拖起时）。 */
export function injectText(item: DragItem, agent: AgentKind): string {
  // workflow：语义是"绑定"而非注入，落点（TerminalDock onDrop）分支拦截，不产生注入文本
  if (item.kind === "workflow") return "";
  // text(书签)：直接注入文本内容，三种 agent 一致；多行压成单行防 agent 输入框逐行误提交。
  if (item.kind === "text") return (item.text ?? "").replace(/\r?\n/g, " ").trim();
  if (item.kind === "skill") {
    if (agent === "claude") return item.invoke ?? item.path ?? ""; // /skill-name
    if (agent === "codex") return "@" + (item.path ?? ""); // codex 用文件路径
    return item.path ?? ""; // 裸 shell：纯路径
  }
  // memory / file：shell 用裸路径，claude/codex 用 @路径；file 多选时各路径转换后以空格拼接
  const toRef = (p: string) => (agent === "shell" ? p : "@" + p);
  if (item.kind === "file" && item.paths?.length) return item.paths.map(toRef).join(" ");
  return toRef(item.path ?? "");
}
