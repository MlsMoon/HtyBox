import { invoke } from "@tauri-apps/api/core";

export interface Skill {
  name: string;
  description: string;
  path: string;
  /** "user" | "project" | "plugin:<plugin>" */
  source: string;
  invoke: string;
}

export interface MemoryItem {
  name: string;
  description: string;
  memType: string;
  path: string;
}

export interface ProjectRef {
  slug: string;
  path: string;
  memoryCount: number;
}

export const listSkills = (projectDir?: string) =>
  invoke<Skill[]>("list_skills", { projectDir });

/** 只取某工作区文件夹自己的 skill（历史 API，固定 `.claude/skills`；面板请用 listManagedSkills）。 */
export const listProjectSkills = (projectDir: string) =>
  invoke<Skill[]>("list_project_skills", { projectDir });

// ── L3 双端：配对 / LAN ──
export interface PairingOffer {
  offerUrl: string;
  qrSvg: string;
  serverId: string;
  port: number;
  lanEndpoint: string | null;
}
/** 生成配对 offer（二维码 SVG + 链接），供「连接」设置页展示。 */
export const pairingOffer = () => invoke<PairingOffer>("pairing_offer");
/** 读 LAN(0.0.0.0) 开关。 */
export const getLanEnabled = () => invoke<boolean>("lan_enabled");
/** 写 LAN 开关（重启 app 后绑定生效）。 */
export const setLanEnabled = (enabled: boolean) => invoke<void>("set_lan_enabled", { enabled });

/** L4 relay 配置（endpoint/useTls/enabled + 实时 online）。 */
export interface RelayConfig {
  endpoint: string | null;
  useTls: boolean;
  enabled: boolean;
  online: boolean;
}
/** 读 relay 配置（设置「连接」页展示）。 */
export const getRelayConfig = () => invoke<RelayConfig>("relay_config");
/** 写 relay 配置（持久化 + 重启反连）。 */
export const setRelayConfig = (endpoint: string | null, useTls: boolean, enabled: boolean) =>
  invoke<void>("set_relay_config", { endpoint, useTls, enabled });
/** relay 控制连在线状态（轮询）。 */
export const getRelayStatus = () => invoke<boolean>("relay_status");

export const listMemories = (slug: string) =>
  invoke<MemoryItem[]>("list_memories", { slug });

// ---- M9：记忆树（分级文件夹结构）----
export interface MemoryNode {
  name: string;
  path: string;
  isDir: boolean;
  memType: string;
  description: string;
  children: MemoryNode[];
}
export const listMemoryTree = (projectDir: string) =>
  invoke<MemoryNode[]>("list_memory_tree", { projectDir });
/** plan-5:canonical 权威记忆树(.htyworkflows/memory,「策展记忆」tab)。 */
export const listCanonicalMemoryTree = (projectDir: string) =>
  invoke<MemoryNode[]>("list_canonical_memory_tree", { projectDir });

// ---- M9：claude/codex/cursor 会话记录 ----
export type SessionAgent = "claude" | "codex" | "cursor";

export interface SessionRef {
  id: string;
  label: string;
  ts: number; // 毫秒
  path: string;
}

export interface SessionTransferResult {
  agent: SessionAgent;
  id: string;
  label: string | null;
  path: string;
  bytes: number;
  warnings: string[];
}

export interface ImportedSession {
  agent: SessionAgent;
  id: string;
  label: string | null;
  status: "imported" | "alreadyPresent";
  warnings: string[];
}

export interface MemoryExportResult {
  path: string;
  bytes: number;
  fileCount: number;
  directoryCount: number;
  warnings: string[];
}

export interface MemoryImportPreview {
  sourceWorkspace: string;
  sourceSlug: string;
  sourceAgentVersion: string;
  sourceSchemaVersion: string;
  exportedAtMs: number;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  targetNonEmpty: boolean;
  targetPath: string;
  archiveSha256: string;
  targetRevision: string;
}

export interface MemoryImportResult {
  status: "imported";
  targetPath: string;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  warnings: string[];
  retainedBackupPath?: string;
}

export const listClaudeSessions = (cwd: string) =>
  invoke<SessionRef[]>("list_claude_sessions", { cwd });
export const listCodexSessions = (cwd: string) =>
  invoke<SessionRef[]>("list_codex_sessions", { cwd });
export const listCursorSessions = (cwd: string) =>
  invoke<SessionRef[]>("list_cursor_sessions", { cwd });
export const deleteClaudeSession = (id: string) =>
  invoke<void>("delete_claude_session", { id });
export const deleteCodexSession = (path: string) =>
  invoke<void>("delete_codex_session", { path });
export const deleteCursorSession = (path: string) =>
  invoke<void>("delete_cursor_session", { path });
export const exportSessionArchive = (
  agent: SessionAgent,
  id: string,
  cwd: string,
  sourcePath: string | null,
  destination: string,
) =>
  invoke<SessionTransferResult>("export_session_archive", {
    agent,
    id,
    cwd,
    sourcePath,
    destination,
  });
export const importSessionArchive = (
  archivePath: string,
  targetCwd: string,
  targetProjectDir: string,
) =>
  invoke<ImportedSession>("import_session_archive", {
    archivePath,
    targetCwd,
    targetProjectDir,
  });
export const exportMemoryArchive = (projectDir: string, destination: string) =>
  invoke<MemoryExportResult>("export_memory_archive", { projectDir, destination });
export const inspectMemoryArchive = (projectDir: string, archivePath: string) =>
  invoke<MemoryImportPreview>("inspect_memory_archive", { projectDir, archivePath });
export const importMemoryArchive = (
  projectDir: string,
  archivePath: string,
  expectedArchiveSha256: string,
  expectedTargetRevision: string,
) =>
  invoke<MemoryImportResult>("import_memory_archive", {
    projectDir,
    archivePath,
    expectedArchiveSha256,
    expectedTargetRevision,
  });
/** 运行后捕获 agent(claude/codex/cursor) 在 cwd 下、启动时刻(sinceMs)之后新生成的会话 id（按时间升序）。 */
export const captureSessionIds = (agent: string, cwd: string, sinceMs: number) =>
  invoke<string[]>("capture_session_ids", { agent, cwd, sinceMs });

export const listProjects = () => invoke<ProjectRef[]>("list_projects");

// ---- M8：Skill 上架/下架管理（工作区级） ----
export interface ManagedSkill {
  name: string;
  description: string;
  dir: string; // 文件夹名 = 稳定标识（移动/模板都用它）
  invoke: string;
  path: string;
  /** true=在活动 skills 根；false=在镜像 downtime/skills */
  enabled: boolean;
}

/** 列工作区级 上架+下架 的全部 skill（带 enabled）。`skillsRel` 缺省 = `.claude/skills`。 */
export const listManagedSkills = (projectDir: string, skillsRel?: string) =>
  invoke<ManagedSkill[]>("list_managed_skills", {
    projectDir,
    skillsRel: skillsRel || null,
  });

/** 上架/下架单个 skill（移动文件夹）。 */
export const setSkillEnabled = (
  projectDir: string,
  dir: string,
  enabled: boolean,
  skillsRel?: string,
) =>
  invoke<void>("set_skill_enabled", {
    projectDir,
    dir,
    enabled,
    skillsRel: skillsRel || null,
  });

/** 应用模板：dirs 全上架、其余全下架；返回单项失败的 warnings。 */
export const applySkillTemplate = (
  projectDir: string,
  dirs: string[],
  skillsRel?: string,
) =>
  invoke<string[]>("apply_skill_template", {
    projectDir,
    dirs,
    skillsRel: skillsRel || null,
  });

// ---- M8：工作区文件树（懒加载，一层） ----
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** 列某目录的直接子项。 */
export const listDir = (path: string) => invoke<DirEntry[]>("list_dir", { path });

// ---- M9：文件读写 / 增删改 ----
export interface ReadTextResult {
  content: string;
  editable: boolean;
  reason?: string;
  /** editable=false 时是否可「仍以文本方式打开」（疑似二进制=可；过大=不可，正道是调设置上限） */
  canForce: boolean;
  /** 内容经有损转换（坏字节以 � 替换 / UTF-16 转码），保存会以转换后内容覆盖原字节 */
  lossy: boolean;
  /** lossy 时供编辑器警告条显示的文案 */
  warning?: string;
}
/** 读文本文件；forceLossy=疑似二进制时仍有损打开，maxBytes=编辑大小上限（缺省走后端默认 10MB）。 */
export const readTextFile = (path: string, opts?: { forceLossy?: boolean; maxBytes?: number }) =>
  invoke<ReadTextResult>("read_text_file", {
    path,
    forceLossy: opts?.forceLossy,
    maxBytes: opts?.maxBytes,
  });
export const writeTextFile = (path: string, content: string) =>
  invoke<void>("write_text_file", { path, content });
/** M9：读图片为 base64 data URL（图片预览；非图片/超大 → ok=false + reason）。 */
export interface ReadImageResult {
  dataUrl: string;
  ok: boolean;
  reason?: string;
}
export const readImageDataUrl = (path: string) =>
  invoke<ReadImageResult>("read_image_data_url", { path });
export const createEntry = (parentDir: string, name: string, isDir: boolean) =>
  invoke<string>("create_entry", { parentDir, name, isDir });
export const renameEntry = (path: string, newName: string) =>
  invoke<string>("rename_entry", { path, newName });
export const deleteEntry = (path: string) => invoke<void>("delete_entry", { path });
export const moveEntry = (src: string, destDir: string) =>
  invoke<string>("move_entry", { src, destDir });
export const copyEntry = (src: string, destDir: string) =>
  invoke<string>("copy_entry", { src, destDir });
export const importDroppedFile = (destDir: string, name: string, bytes: number[]) =>
  invoke<string>("import_dropped_file", { destDir, name, bytes });
// 拖入文件夹：先建去重顶层目录，再按相对路径逐项写入（保留结构）
export const importMakeDir = (destDir: string, name: string) =>
  invoke<string>("import_make_dir", { destDir, name });
export const importDroppedEntry = (baseDir: string, relPath: string, isDir: boolean, bytes: number[]) =>
  invoke<void>("import_dropped_entry", { baseDir, relPath, isDir, bytes });
export const revealInExplorer = (path: string) =>
  invoke<void>("reveal_in_explorer", { path });
// 编辑器打开/关闭文件时按需监听其外部变化（变化后后端 emit "file-changed"）
export const watchFile = (path: string) => invoke<void>("watch_file", { path });
export const unwatchFile = (path: string) => invoke<void>("unwatch_file", { path });

// ---- M9：全局文件搜索（双击 Shift）----
export interface FileRef {
  name: string;
  rel: string;
  path: string;
}
export interface ListFilesResult {
  files: FileRef[];
  total: number; // 工作区有效文件真实总数（files 可能因 maxFiles 截断）
  folders: FileRef[]; // 工作区文件夹（与 files 同口径过滤，供搜索/定位）
  folderTotal: number; // 文件夹真实总数（独立于 total 文件数语义）
}
export const listAllFiles = (
  root: string,
  skipFolders: string[],
  skipExts: string[],
  maxFiles: number,
) => invoke<ListFilesResult>("list_all_files", { root, skipFolders, skipExts, maxFiles });
export const countWorkspaceFiles = (root: string, skipFolders: string[], skipExts: string[]) =>
  invoke<number>("count_workspace_files", { root, skipFolders, skipExts });
