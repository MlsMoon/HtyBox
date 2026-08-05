import { useEffect, useRef, useState } from "react";
import { listManagedSkills, type ManagedSkill } from "../../catalog";
import type { AgentKind } from "../../profiles";
import { DEFAULT_SKILL_ROOT, loadSkillRoots, resolveActiveSkillRoot } from "../../skillRoots";
import { useSettings } from "../../settings";
import { completeSlash, filterSkills, parseSlashToken, type SlashToken } from "./slashSkill";

export type SlashMenuState = {
  tok: SlashToken;
  list: ManagedSkill[];
  selected: number;
};

/** 加载工作区已上架 Skill + 斜杠菜单键盘/补全。 */
export function useSlashSkills(cwd: string | undefined, agentKind: AgentKind | undefined) {
  const { skillRoots: globalRoots } = useSettings();
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [sel, setSel] = useState(0);
  /** Esc 后抑制菜单，直到当前 token 消失或用户再敲 `/` */
  const [suppressed, setSuppressed] = useState(false);
  const lastQuery = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!cwd) {
      setSkills([]);
      return;
    }
    const cands = loadSkillRoots(cwd);
    resolveActiveSkillRoot(cwd, cands)
      .then((r) => listManagedSkills(cwd, r.active || DEFAULT_SKILL_ROOT))
      .then((list) => {
        if (alive) setSkills(list.filter((s) => s.enabled));
      })
      .catch(() => {
        if (alive) setSkills([]);
      });
    return () => {
      alive = false;
    };
  }, [cwd, globalRoots]);

  const agent: AgentKind = agentKind ?? "shell";

  /** 文本/光标变化时调用：重置选中行、解除无效 suppress。 */
  const onCursor = (text: string, cursor: number) => {
    const tok = parseSlashToken(text, cursor);
    if (!tok) {
      if (suppressed) setSuppressed(false);
      lastQuery.current = null;
      return;
    }
    if (lastQuery.current !== tok.query) {
      lastQuery.current = tok.query;
      setSel(0);
    }
  };

  const menuFor = (text: string, cursor: number): SlashMenuState | null => {
    const tok = parseSlashToken(text, cursor);
    if (!tok || suppressed) return null;
    const list = filterSkills(skills, tok.query);
    return { tok, list, selected: list.length ? Math.min(sel, list.length - 1) : 0 };
  };

  const applyComplete = (
    text: string,
    cursor: number,
    skill: ManagedSkill,
  ): { text: string; cursor: number } => {
    const r = completeSlash(text, cursor, skill, agent);
    setSuppressed(true);
    setSel(0);
    return r;
  };

  /**
   * textarea onKeyDown 最前调用。
   * 返回 `{ handled, next? }`：handled 时调用方应已 preventDefault；next 有则写回文本/光标。
   */
  const handleKey = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    text: string,
  ): { handled: boolean; next?: { text: string; cursor: number } } => {
    const el = e.currentTarget;
    const cursor = el.selectionStart ?? text.length;
    const tok = parseSlashToken(text, cursor);

    if (!tok && suppressed) setSuppressed(false);
    if (e.key === "/") setSuppressed(false);

    const open = !!tok && !suppressed;
    if (!open) return { handled: false };

    const list = filterSkills(skills, tok.query);
    const idx = list.length ? Math.min(sel, list.length - 1) : 0;

    if (e.key === "Escape") {
      e.preventDefault();
      setSuppressed(true);
      return { handled: true };
    }
    // 到头循环：先把 sel 规范到 [0, n)，再 ±1 取模（避免列表缩短后下标越界导致跳选）
    if (e.key === "ArrowDown" || e.key === "Tab") {
      e.preventDefault();
      if (list.length) {
        const n = list.length;
        setSel((i) => (((i % n) + n) % n + 1) % n);
      }
      return { handled: true };
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (list.length) {
        const n = list.length;
        setSel((i) => (((i % n) + n) % n - 1 + n) % n);
      }
      return { handled: true };
    }
    // 补全只用 Enter（Tab 已改为向下选）
    if (e.key === "Enter" && !e.shiftKey && list.length > 0) {
      e.preventDefault();
      return { handled: true, next: applyComplete(text, cursor, list[idx]!) };
    }
    return { handled: false };
  };

  return { skills, agent, sel, setSel, menuFor, applyComplete, handleKey, onCursor, suppressed };
}
