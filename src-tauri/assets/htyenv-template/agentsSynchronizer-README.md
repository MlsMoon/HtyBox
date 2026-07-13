# agentsSynchronizer — 全 Agent 同步器

> **触发语义**：把本文件夹路径喂给任意 AI 会话,即为下达指令——
> **"将 `.htyworkflows` 的权威数据向所有在册 Agent 执行一次完整同步与对齐检查,确保没有任何 Agent 被遗漏。"**
> AI 读到本文件即按下方规程执行,无需再解释。

## 执行规程(AI 按序照做)

1. **跑机械层**:优先在 HtyBox 的「hty环境仪表盘 → Skills 同步检查 / agent记忆同步」执行;无 HtyBox 时运行本目录 `sync-all.ps1`(降级入口,产出 `last-sync-report.md`):
   - 名册零遗漏对账:`adapters/` 子目录集 = `workflow-manifest.json` providers 键集 = `rules/<agent>.md` 文件集;
   - Skill 全量同步:canonical 与 manifest 登记对账(UNREGISTERED/GHOST 报告),薄壳全量重生成并复核零漂移;
   - 记忆同步(安全单向收敛):canonical `memory/` → 各 Agent 链路——缺失补齐、同内容跳过、**同名异内容只报 CONFLICT 不覆盖**、缓存多出只报 UNCURATED 不删;
   - 全套校验:`tools/verify.ps1` + `tools/path-audit.ps1`。
2. **处理报告中的人工项**(机械层绝不代劳):
   - `CONFLICT`(记忆同名异内容):读双方内容,与用户确认后按契约双写收敛(权威 canonical + 刷新缓存);
   - `UNCURATED`(缓存多出):按策展纪律判断价值,有价值收编 canonical,无价值经用户确认后清理;
   - `UNREGISTERED`(canonical 有而 manifest 未登记):补登 manifest 后重跑第 1 步。
3. **回报用户**:同步统计 + 人工项处理结果 + 剩余风险,一段话讲清。

## 注意事项

- **权威方向永远是 `.htyworkflows` → Agent**:任何 Agent 侧目录都不是编辑位置;发现被手改,以 canonical 重生成为准(记忆冲突除外,走人工确认)。
- **禁改清单**:workflow-manifest.json 的 protectedNativeConfig 所列 native 文件(如 `.claude/CLAUDE.md`、根 `AGENTS.md`)——只做哈希核对提醒,绝不写入。
- **薄壳契约 v1**:适配器 = canonical frontmatter 原字节 + LF 模板 + `hty-sync-adapters v1` 标记 + entrySha256;**生成实现的权威是 HtyBox htyenv 引擎**,本目录脚本为无 HtyBox 时的降级实现,契约变更随 HtyBox 版本同步分发。
- **Windows 大小写陷阱**:适配器入口必须精确大写 `SKILL.md`;对已存在的小写文件先删后写。
- **新 Agent 接入**:按 `../adapters/README.md` 五步接入,名册对账会自动覆盖。

## 产物

- `last-sync-report.md`:最近一次同步与对齐报告(覆盖式;需留痕自行复制存档)。
