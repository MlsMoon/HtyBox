---
name: htyenv-native-migrate
description: 把工程从原生 Agent 目录（.claude / .agents / .codex 承载业务）迁移到 `.htyworkflows` 唯一真源。涵盖终态契约、路径映射、复制优先删除最后、胖 Skill 收编与薄壳生成、规则/记忆策展、verify/path-audit/sync-all 验收。适用于"迁移到 hty 环境 / 对齐 BGE htyworkflows / agent 中立化 / 半迁移收尾 / 业务数据迁出 .claude / 原生环境迁 hty / htyenv-native-migrate"等场景。前置：工程已有或可 bootstrap `.htyworkflows` 骨架；复杂工程先 `/plan-create` 落盘再 `/plan-auto-execute`。
---

# 原生 Agent 环境 → hty 工作环境迁移

> **类型**：工作流模板（D）  
> **金样本**：BoardGameEditor（`E:\UnityProject\BoardGameEditor\.htyworkflows`，计划 `2026-07-09-agent-neutral-htyworkflows-migration.md`）；半迁移收尾样本 `G:\hty_workflows`（计划 `2026-07-14-htyworkflows-env-sync-migration.md`）。  
> **前置**：目标工程已有 `.htyworkflows` 骨架（HtyBox 初始化或 `tools/bootstrap.ps1`）；无骨架先初始化再迁。

---

## 1. 目标终态（迁完必须长这样）

| 层 | 终态 | 禁止 |
|---|---|---|
| `.htyworkflows/` | **唯一可编辑真源**：rules / skills / memory / plans / changeLog / svg / history / tools / migration… | Agent 目录继续当业务权威 |
| `.claude/skills`、`.agents/skills` | `hty-sync-adapters v1` **薄壳**（frontmatter + canonical 指针 + entrySha256） | 胖正文、手改薄壳 |
| 原生入口 | `CLAUDE.md` / `AGENTS.md` / `settings*.json` / `.codex/config.toml` 按 **protectedNativeConfig** 保留 | 迁移工具擅自改写/格式化原生配置 |
| 记忆 | canonical `memory/` 策展权威；Claude 产品缓存 `~/.claude/projects/<slug>/memory/` 只作双写/导入源 | 产品缓存反向覆盖 canonical |
| 校验 | `verify.ps1` + `path-audit.ps1` + `agentsSynchronizer/sync-all.ps1` 全绿 | 未验收就删旧树 |

---

## 2. 铁律（违反即停）

1. **复制优先、删除最后** —— 先 SHA 盘点 + 只读快照，再复制进 canonical，切换引用与薄壳，**用户二次确认后**才删旧业务目录。
2. **语义改路径，禁盲替换** —— 只改活跃 Skill/规则中的写入与发现路径；历史 plan 正文里的旧路径是**历史事实**，不全局字符串替换。
3. **原生与业务分离** —— 业务进 `.htyworkflows`；原生入口默认不动（决策默认 A：提炼规则到 `rules/common.md`，`CLAUDE.md` 原样保留并刷新保护哈希）。
4. **工程工具链实事求是** —— 迁 Skill 时把源工程专用工具写进正文（如本仓 Grep/Glob/Read；Unity 仓 Jet MCP），禁止把别的工程的工具链原样带过来却不改。
5. **记忆单向** —— 产品 memory → `memory/imports/…` 快照 → 策展进 canonical；topic 文件哈希对齐；`MEMORY.md` 按 sync 契约双写收敛（缓存索引 ⊆ canonical）。

---

## 3. 典型路径映射

| 旧（原生侧常见） | 新（hty） |
|---|---|
| `.claude/skills/<id>/` 胖正文 | `.htyworkflows/skills/<id>/` → 再生成薄壳 |
| `.agents/skills/<id>/` 胖正文 | 同上（并集收编，漂移要决议留痕） |
| `.claude/plans/` | `.htyworkflows/plans/` |
| `.claude/waiting/` 或 `plans_waitChoose/` | `.htyworkflows/plans_waitChoose/` |
| `.claude/changeLog/`、`changeLogHistory/` | `.htyworkflows/changeLog*` |
| `.claude/svg/`、`pngs/` | `.htyworkflows/svg/`（pngs 可进 `svg/pngs/`） |
| `.claude/bugs/` | `.htyworkflows/history/bug-records/` |
| `.claude/handoff/`、`MacDocking/`、`docking/` | `.htyworkflows/handoff/` 或 `docking/` |
| `.claude/chat_continue/` | `.htyworkflows/chatContinue/` |
| `~\.claude\projects\<slug>\memory\` | 导入 `memory/imports/claude-snapshot-<ts>/` + 策展；**源目录不删不改 topic 字节** |
| `.claude/CLAUDE.md` 业务正文 | 提炼 → `rules/common.md`（文件本身默认不动） |

`runtime/`（日志/tmp）、`private/`（本机私密）不进共享真源；含密备份先审计再决定归档或排除。

---

## 4. 标准决策（无用户另选则按此执行）

| # | 议题 | 默认 |
|---|---|---|
| 1 | 原生 `CLAUDE.md` / `AGENTS.md` | **A**：规则写入 `rules/`，原生文件不动 + 保护哈希 |
| 2 | Skill 发现 | **A**：生成式薄适配器（禁 Junction 当主方案） |
| 3 | 产品自动记忆 | **A**：canonical 策展权威；产品目录只导入/双写 |
| 4 | 旧目录清理 | **A**：验收通过 + **用户二次确认** 再删 |
| 5 | 历史 plan 内旧路径字面量 | **不改**（历史事实） |

复杂工程（Skill 上百、双端漂移、外部写入方）→ 先 `/plan-create` 落盘完整计划，再 `/plan-auto-execute`；本 skill 是规程与检查清单，不替代大工程的计划文件。

---

## 5. 执行步骤（单线）

### Step 0 — 冻结与授权

- [ ] 确认用户要迁的工作区根路径
- [ ] 冻结：迁移期禁止再往旧业务路径写新内容（本计划/migration 报告除外）
- [ ] 有 HtyBox 优先用仪表盘；否则用 `.htyworkflows/tools/*.ps1`

### Step 1 — 盘点 + 只读快照

- [ ] 枚举 `.claude` / `.agents` / `.codex`（若有）/ 已有 `.htyworkflows` / 产品 memory
- [ ] 产出 SHA-256 CSV → `.htyworkflows/migration/manifests/inventory-source-<ts>.csv`
- [ ] 复制只读快照 → 工作区旁 `.migration-snapshots/snapshot-<ts>/`（与 canonical 分离）
- [ ] 秘密扫描拟迁移文本；写 `migration/path-map.json` + freeze 报告
- **验证**：快照与源文件数/关键树哈希一致

### Step 2 — 规则权威化

- [ ] 从原生入口提炼工程纪律 → `rules/common.md`（权威源声明 + 本仓真实工具链）
- [ ] 核对 `rules/claude.md` / `codex.md` 与 `adapters/` 名册、`manifest.providers` 三方一致
- [ ] 按决策 1 刷新 `protectedNativeConfig` 哈希（不改文件内容时）
- **验证**：`common.md` 非空；名册对账通过

### Step 3 — 业务目录复制

- [ ] 按 path-map **复制**（非移动）plans / changelog / svg / bugs / docking…
- [ ] 目标已有同名异内容 → 决议报告，**禁静默覆盖**
- **验证**：逐树文件数 + 哈希对账报告

### Step 4 — 收编胖 Skill

- [ ] 识别：Agent 侧有完整正文且未在 canonical、或两端漂移的 id
- [ ] 复制到 `.htyworkflows/skills/<id>/`（入口精确大写 `SKILL.md`）
- [ ] 改写**活跃**路径 → `.htyworkflows/...`；保留 `~/.claude/projects/...` 产品路径说明
- [ ] 按本仓工具链本地化（禁残留错误工程的 Jet/专用插桩等）
- [ ] 漂移 Skill：并集收编 + 每处差异书面决议
- **验证**：canonical Glob 齐；抽检无错误旧写入根

### Step 5 — manifest + 双端薄壳

- [ ] `workflow-manifest.json` 登记全部 skill（id / entrySha256 / fileCount）
- [ ] 清除 Agent 侧胖目录残留后跑 `tools/sync-adapters.ps1`
- [ ] 两端 skill 数 = canonical；每个适配器含 `hty-sync-adapters v1`
- **验证**：`sync-adapters.ps1 -Check` 零漂移

### Step 6 — 记忆导入与策展

- [ ] 产品 memory → `memory/imports/claude-snapshot-<ts>/`
- [ ] topic 文件策展进 `memory/`（相对路径与缓存一致，供 verify 哈希对齐）
- [ ] 更新 canonical `MEMORY.md` 索引；按需双写产品侧索引子集
- **验证**：topic 哈希 = 盘点基线；产品 topic 字节未在导入中被破坏

### Step 7 — 全量校验

- [ ] `tools/verify.ps1`
- [ ] `tools/path-audit.ps1`（活跃层违规先改 Skill/规则正文，少用 skip）
- [ ] `agentsSynchronizer/sync-all.ps1`（处理 CONFLICT/UNCURATED/UNREGISTERED 人工项）
- **验证**：三套全绿或人工项有书面决议

### Step 8 — 验收

- [ ] 静态：薄壳数、dry 写入落在 `.htyworkflows/plans` 与 `svg`
- [ ] **新会话**：Claude / Codex / OpenCode 能发现全部 canonical skill（发现有缓存，必须新进程）
- [ ] 报告 → `migration/reports/acceptance-<ts>.md`

### Step 9 — 清理（必须用户二次确认）

- [ ] 删除已迁移的旧业务目录（如 `.claude/plans|changeLog|svg|…`）
- [ ] **保留** `.claude/skills` 薄壳 + 原生入口文件
- [ ] 再跑 verify + path-audit
- **验证**：`.claude` 仅剩原生 + 薄壳；校验仍绿

---

## 6. 半迁移 / 分叉态识别（常见）

| 信号 | 含义 | 处理 |
|---|---|---|
| canonical 有 N 个 skill，`.claude/skills` 有 N+M 且 M 为胖正文 | 库分发/htyenv 只同步了部分 | 收编 M → sync |
| canonical 路径已是 `.htyworkflows`，正文仍写 Jet/Unity | 通用库盖回未本地化 | Step 4 本地化 |
| `.htyworkflows/plans` 空，`.claude/plans` 仍满 | 业务未迁 | Step 3 |
| `rules/common.md` 空模板，`CLAUDE.md` 仍是完整工程说明 | 规则未权威化 | Step 2 |
| verify 绿但 Agent 仍写旧路径 | Skill/习惯未切 | 查活跃 Skill 路径 + 冻结旧目录 |

---

## 7. 反模式

| ❌ | ✅ |
|---|---|
| 先删 `.claude/plans` 再复制 | 先复制+对账+验收，确认后再删 |
| Junction 把 `.claude/skills` 链到 canonical 当主方案 | 薄壳生成器（跨平台、可审计、可承载两端差异） |
| 全局替换历史 plan 里的 `.claude/` | 只改活跃 Skill/规则 |
| 改 `settings.local.json`「顺便清理」 | 原生配置不读不改（除非用户显式授权） |
| 只迁 Claude 侧，忘记 `.agents` | 名册全部 Agent 必须同步薄壳 |
| 把 BGE 的 110 个业务 skill 盲拷到无关工程 | 只迁**本工程**需要的能力与数据 |
| path-audit 不过就狂加 skip | 先改活跃层正文消违规 |

---

## 8. 工具速查

```powershell
# 工作区根执行
.\.htyworkflows\tools\bootstrap.ps1          # 补骨架（不覆盖已有）
.\.htyworkflows\tools\sync-adapters.ps1      # 生成/刷新薄壳
.\.htyworkflows\tools\sync-adapters.ps1 -Check
.\.htyworkflows\tools\verify.ps1
.\.htyworkflows\tools\path-audit.ps1
.\.htyworkflows\agentsSynchronizer\sync-all.ps1
```

有 HtyBox：仪表盘「Skills 同步检查 / agent记忆同步」与脚本同构，优先 UI。

新建/改 Skill 正文只写 `.htyworkflows/skills/<id>/`，再登记 manifest + sync（见 **skill-creator-hty**）。

---

## 9. 完成检查清单

### 终态
- [ ] 业务写入目标均在 `.htyworkflows/` 对应目录
- [ ] Agent skill 目录全是薄壳，无胖正文残留
- [ ] 原生入口在 protectedNativeConfig 且未被迁移改写（除非用户授权薄引导）
- [ ] canonical skill 数 = manifest = 两端薄壳数

### 安全与可回滚
- [ ] 存在 inventory CSV + 只读快照
- [ ] 秘密扫描无未处理凭据
- [ ] 删除旧树前有用户二次确认记录

### 校验
- [ ] verify / path-audit / sync-all 全绿（或人工项已决议）
- [ ] 新会话抽测 ≥2 个 skill 可发现且描述完整
- [ ] 产品 memory **topic** 哈希相对盘点不变

### 文档留痕
- [ ] `migration/path-map.json` + reports（freeze / copy / acceptance / cleanup）
- [ ] 大工程有 `.htyworkflows/plans/YYYY-MM-DD-*-migration*.md` 与执行记录第 11 段

---

## 10. 输出位置

| 产物 | 路径 |
|---|---|
| 迁移计划（复杂工程） | `.htyworkflows/plans/YYYY-MM-DD-<topic>-migration.md` |
| 盘点/报告 | `.htyworkflows/migration/{manifests,reports,path-map.json}` |
| 只读快照 | `<工作区>/.migration-snapshots/snapshot-<ts>/` |
| 本 skill | `.htyworkflows/skills/htyenv-native-migrate/SKILL.md` |
