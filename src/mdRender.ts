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
