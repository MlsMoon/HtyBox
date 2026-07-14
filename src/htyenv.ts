import { invoke } from "@tauri-apps/api/core";

/** hty环境(.htyworkflows)引擎命令封装;类型与 Rust serde camelCase 输出一一对应(plan-1)。 */

export interface RosterStatus {
  adapterDirs: string[];
  providers: string[];
  ruleFiles: string[];
  consistent: boolean;
}

export interface EnvStatus {
  present: boolean;
  readmePresent: boolean;
  manifestPresent: boolean;
  manifestError?: string;
  schemaVersion?: number;
  registeredSkills?: number;
  canonicalSkillDirs?: number;
  roster?: RosterStatus;
}

/** 薄壳三态 + 缺失(consistent=一致/stale=陈旧/handEdited=手改/missing=缺失)。 */
export type AdapterState = "consistent" | "stale" | "handEdited" | "missing";

export interface SkillAdapterCheck {
  id: string;
  /** provider(claude/codex/…) → 薄壳状态,供 Skills 页入口图标与检查态 */
  states: Record<string, AdapterState>;
}

export interface OrphanShell {
  provider: string;
  id: string;
}

export interface AdapterCheckReport {
  skills: SkillAdapterCheck[];
  canonicalMissingEntry: string[];
  orphanShells: OrphanShell[];
  metadataMissing: string[];
  metadataOutOfSync: string[];
}

export interface SyncOutcome {
  writtenAdapters: number;
  writtenMetadata: number;
  /** 下架 skill 被清除的薄壳目录数(plan-5) */
  removedAdapters: number;
  overwroteHandEdited: string[];
  canonicalMissingEntry: string[];
}

export type MemoryMdStatus = "consistent" | "conflict" | "canonicalMissing" | "cacheMissing";

export interface MemorySyncReport {
  cacheDir: string;
  canonicalPresent: boolean;
  filled: string[];
  same: number;
  conflicts: string[];
  uncurated: string[];
  memoryMd: MemoryMdStatus;
}

export interface VerifyCheck {
  name: string;
  passed: boolean;
  skipped: boolean;
  details: string[];
}

export interface VerifyReport {
  checks: VerifyCheck[];
  allPassed: boolean;
}

export interface SyncReport {
  generatedAt: string;
  mode: "check" | "sync";
  roster: RosterStatus;
  unregistered: string[];
  ghosts: string[];
  manifestRefreshed: string[];
  adapters: AdapterCheckReport;
  syncOutcome?: SyncOutcome;
  memory: MemorySyncReport;
  verify: VerifyReport;
  manualItems: number;
}

/** 识别工作区 hty 环境(状态卡/就绪徽标数据源)。 */
export const htyenvStatus = (workspace: string) =>
  invoke<EnvStatus>("htyenv_status", { workspace });

/** 只读对账,零写入。 */
export const htyenvCheck = (workspace: string) =>
  invoke<SyncReport>("htyenv_check", { workspace });

/** 机械同步(刷新登记/重生成薄壳/补齐记忆缓存)并落盘 last-sync-report.md。 */
export const htyenvSync = (workspace: string) =>
  invoke<SyncReport>("htyenv_sync", { workspace });

/** 综合校验(九组 + 孤儿薄壳 + path-audit)。 */
export const htyenvVerify = (workspace: string) =>
  invoke<VerifyReport>("htyenv_verify", { workspace });

/* ===== plan-2:全局权威库与初始化 ===== */

export interface LibraryStatus {
  path: string;
  present: boolean;
  libraryId?: string;
  templateVersion?: number;
  skillCount?: number;
  manifestError?: string;
}

export interface CollectOutcome {
  id: string;
  status: "collected" | "alreadyPresent";
  librarySha256: string;
  /** 去工程化整理的 AI 指令文本(可注入 agent 终端) */
  curationBrief: string;
}

export interface FetchOutcome {
  id: string;
  status: "fetched" | "alreadyPresent";
  librarySha256: string;
  writtenAdapters: number;
}

export interface InitPreview {
  alreadyInitialized: boolean;
  willCreateDirs: string[];
  willWriteFiles: string[];
  willWriteNative: string[];
  /** native 已存在且不在保护基线 → 需人工接线 */
  nativeManual: string[];
  skippedExisting: string[];
  library: LibraryStatus;
  willFetchSkills: string[];
}

export interface InitOutcome {
  alreadyInitialized: boolean;
  createdDirs: number;
  writtenFiles: string[];
  writtenNative: string[];
  nativeManual: string[];
  fetchedSkills: string[];
  writtenAdapters: number;
}

/** 全局权威库状态(libraryDir 缺省 = 引擎默认位置;设置项可配)。 */
export const htyenvLibraryStatus = (libraryDir?: string) =>
  invoke<LibraryStatus>("htyenv_library_status", { libraryDir: libraryDir || null });

/** 收编工程 canonical skill 进全局权威库(库已有异版会拒绝)。 */
export const htyenvCollectSkill = (workspace: string, skillId: string, libraryDir?: string) =>
  invoke<CollectOutcome>("htyenv_collect_skill", {
    workspace,
    skillId,
    libraryDir: libraryDir || null,
  });

/** 从全局权威库取件到工程(工程已有异版会拒绝)。 */
export const htyenvFetchSkill = (workspace: string, skillId: string, libraryDir?: string) =>
  invoke<FetchOutcome>("htyenv_fetch_skill", {
    workspace,
    skillId,
    libraryDir: libraryDir || null,
  });

/** 初始化 dry-run(零写入)。 */
export const htyenvInitPreview = (workspace: string, libraryDir?: string) =>
  invoke<InitPreview>("htyenv_init_preview", { workspace, libraryDir: libraryDir || null });

/** 执行初始化(幂等只增不覆)。 */
export const htyenvInitExecute = (workspace: string, libraryDir?: string) =>
  invoke<InitOutcome>("htyenv_init_execute", { workspace, libraryDir: libraryDir || null });

/** 已初始化工程「环境补全」dry-run(缺目录/治理文件/库内新 skill)。 */
export const htyenvCompletePreview = (workspace: string, libraryDir?: string) =>
  invoke<InitPreview>("htyenv_complete_preview", { workspace, libraryDir: libraryDir || null });

/** 执行环境补全(刷新库种子 + 只增不覆)。 */
export const htyenvCompleteExecute = (workspace: string, libraryDir?: string) =>
  invoke<InitOutcome>("htyenv_complete_execute", { workspace, libraryDir: libraryDir || null });

/* ===== plan-3:工作区 ↔ 全局权威库双向同步 ===== */

/** 谱系五态(untracked=无关联/upToDate/libraryAhead=可更新/workspaceAhead=可回流/diverged=需裁决)。 */
export type LineageState =
  | "untracked"
  | "upToDate"
  | "libraryAhead"
  | "workspaceAhead"
  | "diverged";

export type ChangeKind = "wsOnly" | "libOnly" | "differs";

export interface ChangedFile {
  /** skill 目录内相对路径('/' 分隔) */
  path: string;
  kind: ChangeKind;
}

export interface SkillLineage {
  id: string;
  state: LineageState;
  wsSha?: string;
  baseSha?: string;
  libSha?: string;
  /** 双方目录都在时的树指纹一致性 */
  treeMatch?: boolean;
  /** 双侧内容一致但基线陈旧(更新/回流任一即对齐) */
  baselineStale: boolean;
  changedFiles: ChangedFile[];
  detail?: string;
}

export interface LineageReport {
  library: LibraryStatus;
  skills: SkillLineage[];
  /** 库有工程无(可经取件引入) */
  libraryOnly: string[];
  /** 库登记 ≠ 库实文件(外部修改;update/backflow 前会跟随刷新) */
  libraryDrift: string[];
}

/** 更新/回流逐项结果(一项失败不阻塞其余)。 */
export interface SyncOpResult {
  id: string;
  /** updated / backflowed / realigned / alreadyUpToDate(error 时缺省) */
  status?: string;
  toSha?: string;
  writtenAdapters: number;
  error?: string;
}

/** 谱系五态对比(零写入)。 */
export const htyenvCompare = (workspace: string, libraryDir?: string) =>
  invoke<LineageReport>("htyenv_compare", { workspace, libraryDir: libraryDir || null });

/** 从库更新(fast-forward/基线对齐;adjudicated=裁决后以库为准)。 */
export const htyenvUpdateFromLibrary = (
  workspace: string,
  skillIds: string[],
  adjudicated = false,
  libraryDir?: string,
) =>
  invoke<SyncOpResult[]>("htyenv_update_from_library", {
    workspace,
    skillIds,
    adjudicated,
    libraryDir: libraryDir || null,
  });

/** 回流到库(版本链追加/基线对齐;adjudicated=裁决后以工程为准)。 */
export const htyenvBackflowToLibrary = (
  workspace: string,
  skillIds: string[],
  adjudicated = false,
  libraryDir?: string,
) =>
  invoke<SyncOpResult[]>("htyenv_backflow_to_library", {
    workspace,
    skillIds,
    adjudicated,
    libraryDir: libraryDir || null,
  });

/** 冲突裁决指令文本(注入所选 agent 终端用)。 */
export const htyenvConflictBrief = (workspace: string, skillId: string, libraryDir?: string) =>
  invoke<string>("htyenv_conflict_brief", { workspace, skillId, libraryDir: libraryDir || null });

/* ===== plan-4:仪表盘聚合/分页/库管理 ===== */

export interface DocItem {
  /** 绝对路径(双击在文件工作台打开) */
  path: string;
  /** 文件名(去 .md) */
  name: string;
  /** 归属日期:文件名前缀 > 头部 **日期** > mtime */
  date?: string;
  /** plans 头部 **状态** 行值 */
  status?: string;
  modifiedUtc: string;
}

export interface DocPage {
  /** 过滤后的总条数(分页导航依据) */
  total: number;
  parseFailures: number;
  items: DocItem[];
}

export interface SectionSummary {
  total: number;
  parseFailures: number;
  recent: DocItem[];
}

export interface MemorySummary {
  present: boolean;
  groups: number;
  files: number;
  latestUtc?: string;
}

export interface LastSyncInfo {
  modifiedUtc: string;
  headline?: string;
}

export interface DashboardData {
  plans: SectionSummary;
  bugs: SectionSummary;
  debts: SectionSummary;
  memory: MemorySummary;
  lastSync?: LastSyncInfo;
}

export interface LibraryVersionInfo {
  sha256: string;
  collectedUtc: string;
  /** 入库来源工作区;None=外部演进(库文件被直接修改后跟随刷新) */
  sourceWorkspace?: string;
}

export interface LibrarySkillInfo {
  id: string;
  currentSha256: string;
  fileCount: number;
  /** frontmatter description(缺失如实为空) */
  description?: string;
  /** 登记在而实体缺 SKILL.md(库损坏) */
  entryMissing: boolean;
  /** 版本链(首=收编起点,末=当前) */
  versions: LibraryVersionInfo[];
}

/** 概览聚合(recent 缺省 5,仅概览摘要卡口径)。 */
export const htyenvDashboardData = (workspace: string, recent?: number) =>
  invoke<DashboardData>("htyenv_dashboard_data", { workspace, recent: recent ?? null });

/** Plans 分类页分页查询。 */
export const htyenvListPlans = (
  workspace: string,
  offset: number,
  limit: number,
  query?: string,
  status?: string,
) =>
  invoke<DocPage>("htyenv_list_plans", {
    workspace,
    offset,
    limit,
    query: query || null,
    status: status || null,
  });

/** Bugs 分类页分页查询。 */
export const htyenvListBugs = (workspace: string, offset: number, limit: number, query?: string) =>
  invoke<DocPage>("htyenv_list_bugs", { workspace, offset, limit, query: query || null });

/** 技术债分类页分页查询。 */
export const htyenvListDebts = (workspace: string, offset: number, limit: number, query?: string) =>
  invoke<DocPage>("htyenv_list_debts", { workspace, offset, limit, query: query || null });

export interface WorkspaceSkillInfo {
  /** 目录名 = 稳定标识(收藏/标签/模板沿用) */
  id: string;
  /** frontmatter name(调用串 /name 依据;缺失回退 id) */
  name: string;
  description?: string;
  /** canonical SKILL.md 绝对路径(拖拽注入 payload 用) */
  path: string;
  /** 启用态(manifest enabled;plan-5 决策 1A) */
  enabled: boolean;
  /** 是否在 manifest 登记(未登记=UNREGISTERED,不可启停) */
  registered: boolean;
}

/** Skills 常态清单(以 canonical 真版为扫描权威)。 */
export const htyenvWorkspaceSkills = (workspace: string) =>
  invoke<WorkspaceSkillInfo[]>("htyenv_workspace_skills", { workspace });

/** canonical skill 上下架(manifest enabled + 薄壳增删;未登记会拒绝)。 */
export const htyenvSetSkillEnabled = (workspace: string, skillId: string, enabled: boolean) =>
  invoke<SyncOutcome>("htyenv_set_skill_enabled", { workspace, skillId, enabled });

/** canonical 模板应用:清单内启用、其余登记项停用。返回 [outcome, warnings]。 */
export const htyenvApplyEnabledSet = (workspace: string, enabledIds: string[]) =>
  invoke<[SyncOutcome, string[]]>("htyenv_apply_enabled_set", { workspace, enabledIds });

/** 库 skill 清单(全局库管理视图)。 */
export const htyenvLibrarySkills = (libraryDir?: string) =>
  invoke<LibrarySkillInfo[]>("htyenv_library_skills", { libraryDir: libraryDir || null });

/** 从库删除 skill(确认交互在调用侧)。 */
export const htyenvLibraryDeleteSkill = (skillId: string, libraryDir?: string) =>
  invoke<void>("htyenv_library_delete_skill", { skillId, libraryDir: libraryDir || null });
