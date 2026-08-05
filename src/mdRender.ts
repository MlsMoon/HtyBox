// Markdown 渲染单例：marked（结构）+ shiki（代码块语法高亮，见 highlighter.ts）。
// DockEditor 的 md 预览与 UpdateModal 的更新说明共用本入口，杜绝两处各自 marked.parse 行为漂移。
// 高亮能力全部委托给 highlighter.ts（与代码文件预览态共用同一个 shiki 实例与语言表）。
import { marked } from "marked";
import type { Tokens } from "marked";
import { highlightToHtml, langForFence } from "./highlighter";

export { onHighlighterReady } from "./highlighter";

// 覆写 marked 的代码块渲染（模块加载时装一次）。语法就绪即着色，未就绪先出无高亮版。
marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      return highlightToHtml(text, langForFence(lang));
    },
  },
});

/** md → HTML。同步返回；代码块着色状态取决于对应语法是否已就绪。 */
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

// ---- plan-4：大文档分段渲染入口（lexer 一次 + 按顶层 token 块 parser）----
// 实测：marked 成本 97% 在 lexer（3MB 约 243ms，一次性可接受）；parser 近乎免费（40 token
// 约 0.1ms）。reference 链接在 lexer 阶段已解析进 token，分块 parser 不破坏跨块引用（已实证）。

import type { Token, TokensList } from "marked";

/** 全量 lexer：产出顶层 token 列表（含已解析完成的 inline 与 reference）。 */
export function lexMarkdown(md: string): TokensList {
  return marked.lexer(md);
}

/** 只渲染一段顶层 token（代码块高亮覆写对本入口同样生效——同一 marked 实例）。 */
export function renderTokenBlock(tokens: Token[]): string {
  return marked.parser(tokens as TokensList);
}
