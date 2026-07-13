# 项目规则入口（由 HtyBox hty环境初始化生成）

本工程的自定义规则、Skill 正文与共享记忆的唯一权威源在 `.htyworkflows/`：

- **规则**：请读取并完整遵循 `.htyworkflows/rules/common.md`（共用正文）与 `.htyworkflows/rules/claude.md`（Claude 差异条款）。
- **Skill**：`.claude/skills/` 下均为自动生成的薄适配器，正文一律以其指向的 `.htyworkflows/skills/<id>/` 为准，禁止手改适配器。
- **记忆**：跨 Agent 权威记忆在 `.htyworkflows/memory/`；Claude 产品自动记忆为其双写缓存，不得反向覆盖 canonical。

> 本文件生成后纳入 workflow-manifest.json 的保护基线，此后不再被工具改写；如需调整请人工编辑并知悉基线核对将提示漂移。
