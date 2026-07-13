# Codex 规则-Skill 与记忆路径对照

> 加载机制与路径事实(通用版,由 HtyBox 出厂模板提供;工程接管后可按实测校准补注)。

| 事项 | 路径 | 说明 |
|---|---|---|
| 项目规则入口 | `<工程根>/AGENTS.md` | 初始化生成的薄引导,指向 `.htyworkflows/rules/`;纳入保护基线后不再改写 |
| 项目 Skill 发现 | `<工程根>/.agents/skills/<id>/SKILL.md` | 生成薄适配器(契约 v1);`agents/` 子目录为发现层 metadata(openai.yaml 等) |
| 记忆 | `.htyworkflows/memory/`(直读) | 无产品缓存链路 |
| 宿主配置 | `~/.codex/`、`.codex/config.toml` | 产品固有,绝不触碰 |
