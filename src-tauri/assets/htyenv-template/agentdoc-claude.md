# Claude Code 规则-Skill 与记忆路径对照

> 加载机制与路径事实(通用版,由 HtyBox 出厂模板提供;工程接管后可按实测校准补注)。

| 事项 | 路径 | 说明 |
|---|---|---|
| 项目规则入口 | `<工程根>/.claude/CLAUDE.md` | 初始化生成的薄引导,指向 `.htyworkflows/rules/`;纳入保护基线后不再改写 |
| 项目 Skill 发现 | `<工程根>/.claude/skills/<id>/SKILL.md` | 生成薄适配器(契约 v1),正文在 canonical |
| 用户级 Skill | `~/.claude/skills/` | 产品固有,不由本环境管理 |
| 产品自动记忆 | `~/.claude/projects/<工作区slug>/memory/` | canonical `memory/` 的双写缓存;slug = 绝对路径中 `: \ / _` 逐字符替换为 `-` |
| 会话/配置 | `~/.claude/` 其余 | 产品固有,绝不触碰 |
