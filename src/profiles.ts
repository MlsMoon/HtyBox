export type AgentKind = "claude" | "codex" | "opencode" | "cursor" | "kimi" | "hermes" | "shell";

/** 是否为真正的 agent 终端(区别于裸 shell)；未来新增 agent 类型无需再逐处补分支。
 *  写成类型谓词(k is ...)而非裸 boolean，是为了保留原 `agentKind === "claude" || agentKind === "codex"`
 *  内联写法自带的 TS 控制流窄化效果——调用处很多地方窄化后紧接着把 agentKind 传给要求非 undefined 的函数。 */
export function isAgentTerminal(k?: string): k is Exclude<AgentKind, "shell"> {
  return !!k && k !== "shell";
}

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
  {
    id: "opencode",
    label: "OpenCode",
    agentKind: "opencode",
    shell: "powershell.exe",
    launchCmd: "opencode\r",
    dotColor: "#5a5858",
  },
  {
    id: "cursor",
    label: "Cursor",
    agentKind: "cursor",
    shell: "powershell.exe",
    launchCmd: "cursor-agent\r",
    dotColor: "#000000",
  },
  {
    id: "kimi",
    label: "Kimi",
    agentKind: "kimi",
    shell: "powershell.exe",
    launchCmd: "kimi\r",
    dotColor: "#1783FF",
  },
  {
    id: "hermes",
    label: "Hermes",
    agentKind: "hermes",
    shell: "powershell.exe",
    launchCmd: "hermes\r",
    // LobeHub HermesAgent colorPrimary 近似暖铜金(品牌识别点)
    dotColor: "#C4A35A",
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
 * - cursor：新建 `cursor-agent`；复原 `cursor-agent --resume <id>`(与 claude 同为 flag 风格，已实测)；无 id 退回 `cursor-agent --resume`(选择器)
 * - kimi：新建 `kimi`(无位置 prompt 参数，不拼 initialPrompt)；复原 `kimi --session <id>`(flag 风格，id 形态 session_<uuid>，已实测)；无 id 退回 `kimi --session`(选择器)
 * - hermes：新建 `hermes`(不拼 initialPrompt；`-z` 是 oneshot 非交互)；复原 `hermes --resume <id>`(id=`YYYYMMDD_HHMMSS_`+6hex，已实测)；无 id 退回 `hermes -c`(continue；`--resume` 必填参数)
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
  const mm = (model ?? "").trim().replace(/[^\w./:-]/g, "");
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
  // OpenCode 模型名使用 provider/model；会话 id 由 CLI 生成，形态为 ses_<token>。
  if (agent === "opencode") {
    const osid = /^ses_[A-Za-z0-9]{1,124}$/.test((sessionId ?? "").trim())
      ? (sessionId as string).trim()
      : "";
    if (resume) return osid ? `opencode --session ${osid}\r` : "opencode --continue\r";
    const prompt = ipRaw ? ` --prompt "${ipRaw}"` : "";
    return `opencode${m}${prompt}\r`;
  }
  // cursor-agent 不支持新建时预分配 id，其 id 由 cursor-agent 自生成、HtyBox 启动后捕获。
  // 复原：--resume 是 flag 风格(与 claude 同构，已实测)，有 id 精确复原，无 id 落到官方选择器。
  if (agent === "cursor") {
    if (resume) return sid ? `cursor-agent --resume ${sid}\r` : "cursor-agent --resume\r";
    return `cursor-agent${m}${ip}\r`;
  }
  // kimi 不支持新建时预分配 id，其 id(session_<uuid> 形态)由 kimi 自生成、HtyBox 启动后捕获。
  // 复原：--session 是 flag 风格(resume 精确性已实测)；id 校验接受 session_ 前缀形态(共享 sid 正则只认裸 UUID)。
  // 新建不拼 ip：kimi 无位置 prompt 参数(-p 是非交互 print 模式)；团队简报由 TerminalDock 启动后 injectAndSubmit 注入。
  if (agent === "kimi") {
    const ksid = /^session_[0-9a-fA-F-]{36}$/.test((sessionId ?? "").trim())
      ? (sessionId as string).trim()
      : "";
    if (resume) return ksid ? `kimi --session ${ksid}\r` : "kimi --session\r";
    return `kimi${m}\r`;
  }
  // hermes 不支持新建时预分配 id；id 由 hermes 自生成、HtyBox 启动后捕获。
  // 复原：--resume 精确恢复已实测；无 id 用 -c(continue)。新建不拼 ip：-z 是 oneshot。
  if (agent === "hermes") {
    const hsid = /^\d{8}_\d{6}_[0-9a-fA-F]{6}$/.test((sessionId ?? "").trim())
      ? (sessionId as string).trim()
      : "";
    if (resume) return hsid ? `hermes --resume ${hsid}\r` : "hermes -c\r";
    return `hermes${m}\r`;
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
    // cursor-agent 与 claude 同走原生 /skill-name slash-invoke(已实测确认，非文本转发)；
    // kimi 同为原生 skill 机制(/skill:<name>，与系统命令无冲突时可简写 /<name>，本会话实证)。
    // hermes 同为 /<skill-name>(Step 0 实测)。
    if (agent === "claude" || agent === "cursor" || agent === "kimi" || agent === "hermes")
      return item.invoke ?? item.path ?? ""; // /skill-name
    if (agent === "codex" || agent === "opencode") return "@" + (item.path ?? ""); // 无原生 skill 机制，用文件路径
    return item.path ?? ""; // 裸 shell：纯路径
  }
  // memory / file：shell 用裸路径，其余 agent 用 @路径；file 多选时各路径转换后以空格拼接
  const toRef = (p: string) => (agent === "shell" ? p : "@" + p);
  if (item.kind === "file" && item.paths?.length) return item.paths.map(toRef).join(" ");
  return toRef(item.path ?? "");
}
