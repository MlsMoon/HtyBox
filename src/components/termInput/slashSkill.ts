// 斜杠 Skill 补全纯逻辑：解析当前 /token、过滤排序、按 agent 替换插入。
import { searchScore } from "../../search";
import { injectText, type AgentKind } from "../../profiles";
import type { ManagedSkill } from "../../catalog";

export type SlashToken = {
  /** token 起始下标（含 `/`） */
  start: number;
  /** token 结束下标（光标处，不含其后字符） */
  end: number;
  /** 不含前导 `/` 的查询串，如 `h` / `plan-create`；仅 `/` 时为空串 */
  query: string;
};

/**
 * 从光标位置向左解析斜杠 token。
 * 激活条件：光标前最近一段匹配 `/[A-Za-z0-9_:-]*`，且 `/` 左侧为行首或空白。
 * 排除 `http://` 等（`/` 前非空白）。
 */
export function parseSlashToken(text: string, cursor: number): SlashToken | null {
  const c = Math.max(0, Math.min(cursor, text.length));
  let i = c;
  while (i > 0 && /[A-Za-z0-9_:-]/.test(text[i - 1]!)) i--;
  if (i <= 0 || text[i - 1] !== "/") return null;
  const slash = i - 1;
  if (slash > 0 && !/\s/.test(text[slash - 1]!)) return null;
  return { start: slash, end: c, query: text.slice(slash + 1, c) };
}

/** 过滤并排序已上架 skills（调用方保证 enabled）；空 query 按 invoke 字典序。 */
export function filterSkills(skills: ManagedSkill[], tokenQuery: string): ManagedSkill[] {
  const q = tokenQuery.trim();
  if (!q) {
    return [...skills].sort((a, b) => a.invoke.localeCompare(b.invoke));
  }
  return skills
    .map((s) => ({ s, score: searchScore(q, s.invoke, s.name, s.description) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.s.invoke.localeCompare(b.s.invoke))
    .map((e) => e.s);
}

/** 按 agent 决定插入串（决策 4A）：走 injectText，与拖拽注入同形。 */
export function insertTextForSkill(skill: ManagedSkill, agent: AgentKind): string {
  return injectText({ kind: "skill", invoke: skill.invoke, path: skill.path }, agent);
}

/**
 * 用选中 skill 替换当前 `/token`，尾随空格；返回新文本与光标位置（空格后）。
 * 若当前无有效 slash token，原样返回。
 */
export function completeSlash(
  text: string,
  cursor: number,
  skill: ManagedSkill,
  agent: AgentKind,
): { text: string; cursor: number } {
  const tok = parseSlashToken(text, cursor);
  if (!tok) return { text, cursor };
  const ins = insertTextForSkill(skill, agent);
  if (!ins) return { text, cursor };
  const withSpace = ins.endsWith(" ") ? ins : ins + " ";
  const next = text.slice(0, tok.start) + withSpace + text.slice(tok.end);
  return { text: next, cursor: tok.start + withSpace.length };
}
