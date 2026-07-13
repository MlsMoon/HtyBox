# adapters/ — 在册 Agent 名册(Skill 与记忆的适配范围权威定义)

> **本目录记录所有需要适配的 Agent**:每个子目录 = 一个在册 Agent。
> 新增 Skill、更新记忆时,必须覆盖名册在案的**全部** Agent——漏掉任何一个都算适配不完整。

## 当前在册 Agent

| Agent | 子目录 | Skill 发现目录(薄壳) | 规则差异条款 | 记忆链路 |
|---|---|---|---|---|
| Claude Code | `claude/` | `.claude/skills/<id>/SKILL.md` | `rules/claude.md` | 产品自动记忆 = 双写缓存(`~/.claude/projects/<工作区slug>/memory/`,与 canonical `memory/` 同构;slug = 工作区绝对路径中 `: \ / _` 逐字符替换为 `-`) |
| Codex | `codex/` | `.agents/skills/<id>/SKILL.md`(+ `agents/` 发现层 metadata,如 openai.yaml) | `rules/codex.md` | 直读 canonical `memory/` |

## 新增 Skill 时

1. 正文只写 `.htyworkflows/skills/<id>/`(入口精确大写 `SKILL.md`)。
2. 经 HtyBox(Skills 页)或 `tools/sync-adapters.ps1` 为**上表全部** Agent 生成薄壳。
3. `workflow-manifest.json` 登记(id/entrySha256/fileCount),`tools/verify.ps1` 校验。

## 更新记忆时

1. 权威写 `.htyworkflows/memory/`(策展契约见其 MEMORY.md 头部)。
2. 按上表"记忆链路"列同步:Claude 需双写产品缓存;Codex 直读无需额外动作。
3. 禁止只写某个 Agent 的原生缓存不写 canonical(反向覆盖违约)。

## 新增一个 Agent 的接入步骤

1. 本目录新建 `<agent>/README.md`(overlay 语义说明;overlay 为空是常态)。
2. `workflow-manifest.json` 的 `providers` 增加该 Agent(adapterDir / 原生规则入口)。
3. 薄壳生成侧(HtyBox htyenv 引擎按 manifest 驱动,自动覆盖;降级脚本无需改)。
4. `rules/<agent>.md` 写差异条款(Skill 发现方式、记忆读取链路)。
5. 上表补一行;全量同步 + verify;新会话验收该 Agent 能发现全部 Skill。
