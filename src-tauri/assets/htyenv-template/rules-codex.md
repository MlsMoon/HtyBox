# Codex / OpenCode 共用差异条款

> 先读 `common.md`(共用正文);本文件只写 Codex 与 OpenCode 共用的产品差异。

- **Skill 发现**:`.agents/skills/<id>/SKILL.md` 均为自动生成薄适配器,正文以其指向的 `.htyworkflows/skills/<id>/` 为准;`agents/` 子目录为发现层 metadata(如 openai.yaml),同为生成物,禁止手改。
- **记忆链路**:**直读** `.htyworkflows/memory/`(无产品缓存,不需要下发);更新记忆直接写 canonical。
- **落盘位置**:计划/日志/资料一律写 `.htyworkflows/` 对应目录(不使用 `.codex/`、`.opencode/` 下的业务目录)。
