# .htyworkflows — 项目工作流唯一真源

> 由 HtyBox「hty环境」初始化生成(出厂模板 v1)。
> 本目录是项目自定义规则、Skill、共享记忆、工具与工作流状态的**唯一可编辑权威源**。

## 编辑边界(最重要的三条)

1. **所有人工编辑只发生在本目录**。各 Agent 侧的 skill 目录(如 `.claude/skills/`、`.agents/skills/`)是自动生成的薄适配器,**禁止手改**——改了会被同步检查检出并在下次重生成时覆盖。
2. **原生宿主配置绝不改写**:`workflow-manifest.json` 的 protectedNativeConfig 所列文件(项目规则入口等)在初始化生成后纳入哈希基线,此后只核对提醒、不再触碰。
3. **Claude 产品自动记忆**(`~/.claude/projects/<工作区slug>/memory/`)是产品固有路径,不迁移不改写;本目录 `memory/` 是人工策展的跨 Agent 权威记忆,产品记忆只作双写缓存/导入源,不得反向覆盖 canonical。

## 目录职责

| 目录 | 职责 |
|---|---|
| `rules/` | common.md(各端共用规则权威正文)+ claude.md / codex.md(产品差异条款) |
| `skills/<id>/` | canonical Skill 正文与相对资源,入口统一大写 `SKILL.md` |
| `adapters/{claude,codex}/` | 在册 Agent 名册与 overlay(见其 README) |
| `memory/` | MEMORY.md 索引 + 策展记忆 + imports/(带来源快照导入) |
| `tools/` | bootstrap / sync-adapters / verify / path-audit(无 HtyBox 时的降级脚本) |
| `plans/`、`plans_waitChoose/` | 实施计划与待选池 |
| `changeLog/`、`changeLogHistory/` | 更新日志及其归档 |
| `chatContinue/`、`handoff/`、`docking/` | 会话续接、交接、数据对接 |
| `svg/`、`testKPI/`、`userTeach/`、`user-real-design/` | UI mockup、测试资料、教学资料、真实设计稿 |
| `history/` | bug-records / tech-debt / legacy-plans / archives(可增长历史) |
| `runtime/` | logs / mcp-logs / tmp / local——运行产物(不共享) |
| `private/` | 本机私有信息,禁止进入共享清单 |
| `migration/` | 迁移盘点与决议(接管既有工程时使用) |
| `agentsSynchronizer/` | 全 Agent 同步器:喂给 AI 即触发完整同步与对齐检查 |
| `AgentDocument/` | 各 Agent 加载机制与路径对照文档 |

## 日常维护

- **新增/修改 Skill**:编辑 `skills/<id>/`,经 HtyBox(Skills 页)或 `tools/sync-adapters.ps1` 重生成各端薄壳,并登记 `workflow-manifest.json`。
- **校验**:HtyBox「同步检查」或 `tools/verify.ps1`;路径审计 `tools/path-audit.ps1`(豁免清单 `tools/path-audit-skip.json`)。
- **记忆**:策展更新写 `memory/`;经 HtyBox「agent记忆同步」或 `agentsSynchronizer/sync-all.ps1` 单向收敛到产品缓存。
