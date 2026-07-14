// htyenv/template.rs —— 出厂结构模板(+ 内置种子 skill 清单)。
// 本清单是 .htyworkflows 结构定义的**唯一权威**:bootstrap 模板目录集与 verify 第 7 组
// "活跃写入目标"皆由此对齐(终结 BGE bootstrap/verify 两处清单漂移)。
// 治理文件/降级脚本/文档模板/种子 skill 经 include_str! 内嵌,源文件唯一编辑处为
// src-tauri/assets/htyenv-template/。
use std::collections::BTreeMap;

use serde_json::{json, Map};

use super::manifest::ProviderConfig;

pub const TEMPLATE_VERSION: u32 = 2;

/// env 根下目录权威清单('/' 分隔,初始化必建;只增不删)。
pub const TEMPLATE_DIRS: &[&str] = &[
    "rules",
    "skills",
    "adapters/claude",
    "adapters/codex",
    "memory/imports",
    "tools",
    "plans",
    "plans_waitChoose",
    "changeLog",
    "changeLogHistory",
    "chatContinue",
    "handoff",
    "docking",
    "svg",
    "testKPI",
    "userTeach",
    "user-real-design",
    "AgentDocument",
    "agentsSynchronizer",
    "history/bug-records",
    "history/tech-debt",
    "history/legacy-plans",
    "history/archives",
    "runtime/logs",
    "runtime/mcp-logs",
    "runtime/tmp",
    "runtime/local",
    "private",
    "migration/manifests",
    "migration/reports",
    "migration/tools",
];

/// 活跃写入目标目录(verify 第 7 组口径:会话日常落盘处,缺失即环境残缺)。
pub const ACTIVE_WRITE_DIRS: &[&str] = &[
    "plans",
    "plans_waitChoose",
    "changeLog",
    "changeLogHistory",
    "chatContinue",
    "handoff",
    "docking",
    "svg",
    "testKPI",
    "userTeach",
    "runtime/logs",
    "history/bug-records",
    "history/tech-debt",
    "user-real-design",
    "memory",
];

/// 落到 env 根内的模板文件(env 相对路径 '/' 分隔, 内容);已存在一律跳过(幂等)。
pub const TEMPLATE_FILES: &[(&str, &str)] = &[
    ("README.md", include_str!("../../assets/htyenv-template/env-README.md")),
    ("rules/common.md", include_str!("../../assets/htyenv-template/rules-common.md")),
    ("rules/claude.md", include_str!("../../assets/htyenv-template/rules-claude.md")),
    ("rules/codex.md", include_str!("../../assets/htyenv-template/rules-codex.md")),
    ("adapters/README.md", include_str!("../../assets/htyenv-template/adapters-README.md")),
    ("adapters/claude/README.md", include_str!("../../assets/htyenv-template/overlay-claude.md")),
    ("adapters/codex/README.md", include_str!("../../assets/htyenv-template/overlay-codex.md")),
    ("memory/MEMORY.md", include_str!("../../assets/htyenv-template/memory-MEMORY.md")),
    (
        "AgentDocument/ClaudeCode规则-Skill与记忆路径对照.md",
        include_str!("../../assets/htyenv-template/agentdoc-claude.md"),
    ),
    (
        "AgentDocument/Codex规则-Skill与记忆路径对照.md",
        include_str!("../../assets/htyenv-template/agentdoc-codex.md"),
    ),
    ("tools/bootstrap.ps1", include_str!("../../assets/htyenv-template/bootstrap.ps1")),
    ("tools/sync-adapters.ps1", include_str!("../../assets/htyenv-template/sync-adapters.ps1")),
    ("tools/verify.ps1", include_str!("../../assets/htyenv-template/verify.ps1")),
    ("tools/path-audit.ps1", include_str!("../../assets/htyenv-template/path-audit.ps1")),
    (
        "tools/path-audit-skip.json",
        include_str!("../../assets/htyenv-template/path-audit-skip.json"),
    ),
    (
        "agentsSynchronizer/README.md",
        include_str!("../../assets/htyenv-template/agentsSynchronizer-README.md"),
    ),
    (
        "agentsSynchronizer/sync-all.ps1",
        include_str!("../../assets/htyenv-template/sync-all.ps1"),
    ),
];

/// native 薄引导(工程根相对路径 '/' 分隔, 内容, 所属 provider;决策 3A:仅规则入口两件)。
/// 已存在则跳过生成、不入保护基线、报告"需人工接线"(主题群决策 5)。
pub const NATIVE_BOOTSTRAP_FILES: &[(&str, &str, &str)] = &[
    (
        ".claude/CLAUDE.md",
        include_str!("../../assets/htyenv-template/native-claude.md"),
        "claude",
    ),
    (
        "AGENTS.md",
        include_str!("../../assets/htyenv-template/native-agents.md"),
        "codex",
    ),
];

/// 出厂 providers(claude+codex;cursor 待实测入册,主题群 G2)。字段结构与 BGE schemaVersion 1 实况同构。
pub fn factory_providers() -> BTreeMap<String, ProviderConfig> {
    let mut providers = BTreeMap::new();
    providers.insert(
        "claude".to_string(),
        provider(".claude/skills", "adapters/claude", ".claude/CLAUDE.md"),
    );
    providers.insert(
        "codex".to_string(),
        provider(".agents/skills", "adapters/codex", "AGENTS.md"),
    );
    providers
}

fn provider(adapter_dir: &str, overlay_dir: &str, rules_entry: &str) -> ProviderConfig {
    let mut extra = Map::new();
    extra.insert("overlayDir".to_string(), json!(overlay_dir));
    extra.insert("nativeRulesEntry".to_string(), json!(rules_entry));
    extra.insert("nativeRulesPolicy".to_string(), json!("protected-native-config"));
    ProviderConfig {
        adapter_dir: adapter_dir.to_string(),
        extra,
    }
}

/// 出厂内置种子 skill(随应用分发;ensure_library 装入全局权威库)。
/// 与「用户收编长内容」并列:种子是产品内置能力,用户库仍可继续收编其它 skill。
/// 每项 = (skill_id, &[(相对路径, 内容), ...]);入口必须含 `SKILL.md`。
pub const SEED_SKILLS: &[(&str, &[(&str, &str)])] = &[(
    "htyenv-native-migrate",
    &[(
        "SKILL.md",
        include_str!("../../assets/htyenv-template/seed-skills/htyenv-native-migrate/SKILL.md"),
    )],
)];

/// 出厂 manifest 骨架(skills 为空;protectedNativeConfig 由 init 按实际生成的 native 文件回填)。
pub fn factory_manifest() -> super::manifest::WorkflowManifest {
    super::manifest::WorkflowManifest {
        schema_version: super::manifest::SUPPORTED_SCHEMA_VERSION,
        generator_version: Some(format!("htybox-htyenv-template/{TEMPLATE_VERSION}")),
        generated_utc: None,
        canonical: Some(json!({
            "root": ".htyworkflows",
            "skillsDir": "skills",
            "skillEntry": "SKILL.md",
            "encoding": "utf-8"
        })),
        providers: factory_providers(),
        protected_native_config: Some(Vec::new()),
        renames: None,
        zero_loss_constraints: None,
        skills: Vec::new(),
        extra: Map::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_dirs_are_subset_of_template_dirs_plus_memory() {
        // memory 本身经 memory/imports 间接必建;其余活跃目录必须都在权威清单内
        for dir in ACTIVE_WRITE_DIRS {
            let covered = *dir == "memory"
                || TEMPLATE_DIRS.contains(dir)
                || TEMPLATE_DIRS.iter().any(|t| t.starts_with(&format!("{dir}/")));
            assert!(covered, "活跃目录 {dir} 未被权威清单覆盖");
        }
    }

    #[test]
    fn template_files_land_inside_template_dirs_or_root() {
        for (rel, content) in TEMPLATE_FILES {
            assert!(!content.is_empty(), "{rel} 模板内容为空");
            if let Some((dir, _)) = rel.rsplit_once('/') {
                let covered = TEMPLATE_DIRS.contains(&dir)
                    || TEMPLATE_DIRS.iter().any(|t| *t == dir || t.starts_with(&format!("{dir}/")));
                assert!(covered, "模板文件 {rel} 的目录 {dir} 不在权威清单");
            }
        }
    }

    #[test]
    fn factory_manifest_parses_round_trip() {
        let manifest = factory_manifest();
        let text = super::super::manifest::serialize(&manifest).unwrap();
        let parsed = super::super::manifest::parse(&text).unwrap();
        assert_eq!(parsed.providers.len(), 2);
        assert!(parsed.skills.is_empty());
        assert_eq!(
            parsed.providers["claude"].extra["nativeRulesEntry"],
            ".claude/CLAUDE.md"
        );
    }

    #[test]
    fn seed_skills_have_skill_md_and_nonempty() {
        assert!(!SEED_SKILLS.is_empty());
        for (id, files) in SEED_SKILLS {
            assert!(!id.is_empty());
            let entry = files.iter().find(|(rel, _)| *rel == "SKILL.md");
            assert!(entry.is_some(), "{id} 缺 SKILL.md");
            assert!(!entry.unwrap().1.is_empty(), "{id} SKILL.md 为空");
        }
    }
}
