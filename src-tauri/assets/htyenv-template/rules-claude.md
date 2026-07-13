# Claude Code 差异条款

> 先读 `common.md`(共用正文);本文件只写 Claude Code 的产品差异。

- **Skill 发现**:`.claude/skills/<id>/SKILL.md` 均为自动生成薄适配器,正文以其指向的 `.htyworkflows/skills/<id>/` 为准(相对资源以 canonical 目录为基准解析),禁止手改适配器。
- **记忆链路**:跨 Agent 权威记忆在 `.htyworkflows/memory/`;Claude 产品自动记忆(`~/.claude/projects/<工作区slug>/memory/`)为其**双写缓存**——更新记忆须先写 canonical 再同步缓存,禁止只写缓存。
- **落盘位置**:计划写 `.htyworkflows/plans/`,更新日志写 `.htyworkflows/changeLog/`,UI mockup 写 `.htyworkflows/svg/`(各 Agent 原生目录下的旧业务路径一律不再使用)。
