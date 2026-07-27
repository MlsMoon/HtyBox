// shiki 语法高亮的单一入口：md 预览的代码块与代码文件的只读预览态共用这一个实例。
//
// 关键取舍（实测依据，见计划 2026-07-27-markdown-preview-syntax-color.md 决策 5）：
// - 从 `shiki` 主入口导入 `createHighlighter` 会 bundle 全部约 200 种语法；故走 `shiki/core`
//   的 `createHighlighterCore` + **显式 loader 映射**，每种语言各自成 chunk、首次遇到才加载。
// - 用显式映射而非 import(`shiki/langs/${x}.mjs`) 变量路径，避免 Vite glob 出 200+ chunk。
// - 实例就绪后 `codeToHtml` 是同步的 → 调用方（marked 覆写 / 代码预览）都能同步拿到 HTML。
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import lightPlus from "shiki/themes/light-plus.mjs";
import darkPlus from "shiki/themes/dark-plus.mjs";

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;
/** 语言模块的默认导出即 loadLanguage 可直接吃的入参，由 shiki 类型推导，不手写联合类型。 */
type LangModule = { default: Parameters<Highlighter["loadLanguage"]>[0] };

/** 双主题：浅色内联 Light+ 色，深色经 --shiki-dark 变量由 index.css 的 html.dark 规则接管。 */
const THEMES = { light: "light-plus", dark: "dark-plus" } as const;

/** 按需加载的语言表——键即 shiki 语言 id。覆盖本生态真实会打开的工程语言，不为假想语言预留。 */
const LANG_LOADERS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"), // C 家族统一走 cpp：其 TextMate 语法含 C 子集
  php: () => import("shiki/langs/php.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
};

/** md 围栏标记（```xxx）里常见的写法 → shiki 语言 id。 */
const FENCE_ALIAS: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsonc: "json", json5: "json",
  rs: "rust",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", shell: "shellscript", console: "shellscript",
  ps: "powershell", ps1: "powershell", pwsh: "powershell",
  md: "markdown",
  yml: "yaml",
  py: "python",
  cs: "csharp", "c#": "csharp",
  c: "cpp", "c++": "cpp", cc: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp",
  golang: "go",
  rb: "ruby",
  kt: "kotlin", kts: "kotlin",
  sass: "scss",
  htm: "html",
  conf: "ini", cfg: "ini",
};

/** 文件扩展名（不含点，小写）→ shiki 语言 id。表外扩展名 = 无高亮纯文本预览。 */
const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx", jsx: "jsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", json5: "json",
  rs: "rust",
  toml: "toml",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  md: "markdown", markdown: "markdown",
  css: "css", scss: "scss", sass: "scss",
  html: "html", htm: "html",
  xml: "xml", xaml: "xml", csproj: "xml", props: "xml", targets: "xml", plist: "xml",
  yaml: "yaml", yml: "yaml",
  ini: "ini", cfg: "ini", conf: "ini", editorconfig: "ini",
  py: "python", pyw: "python",
  cs: "csharp",
  sql: "sql",
  go: "go",
  java: "java",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  php: "php",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin", kts: "kotlin",
  vue: "vue",
};

/** 该扩展名是否有对应语法（供调用方判断"值不值得给预览态"）。 */
export function langForPath(path: string): string | null {
  const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
  const id = EXT_LANG[ext];
  return id && id in LANG_LOADERS ? id : null;
}

/** 把 ```lang 标记归一到支持的 shiki 语言 id；不支持返回 null。 */
export function langForFence(raw: string | undefined): string | null {
  if (!raw) return null;
  // marked 会把 ```ts title=x 整串给到 lang，取首段即语言名
  const key = raw.trim().split(/\s+/)[0].toLowerCase();
  const id = FENCE_ALIAS[key] ?? key;
  return id in LANG_LOADERS ? id : null;
}

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
/** 兜底路径必须自行转义——内容会进 innerHTML。 */
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);

let hl: Highlighter | null = null;
let initStarted = false;
const loadedLangs = new Set<string>(); // 已注册进 highlighter
const fetchedMods = new Map<string, LangModule["default"]>(); // 已下载、可能还没注册
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

/** 惰性创建 highlighter：首次真正要高亮时才触发，不拖慢应用启动。 */
function ensureHighlighter(): void {
  if (hl || initStarted) return;
  initStarted = true;
  createHighlighterCore({
    themes: [lightPlus, darkPlus],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  })
    .then((h) => {
      hl = h;
      return registerFetched();
    })
    .catch((e) => {
      // 高亮是增强能力：初始化失败时内容保持无高亮可读态，但错误必须可见，不静默吞
      console.error("shiki 初始化失败，代码降级为无高亮", e);
    });
}

/** 把已下载但尚未注册的语法注册进 highlighter；highlighter 未就绪时留待其就绪后再调。 */
async function registerFetched(): Promise<void> {
  if (!hl) return;
  const todo = [...fetchedMods.entries()].filter(([id]) => !loadedLangs.has(id));
  if (!todo.length) return;
  for (const [id, mod] of todo) {
    await hl.loadLanguage(mod);
    loadedLangs.add(id);
  }
  notify(); // 通知调用方重渲染一次，把先前的无高亮内容换成着色版
}

/** 请求某语言的语法（每种只下载一次）。 */
function requestLang(id: string): void {
  if (loadedLangs.has(id) || fetchedMods.has(id)) return;
  ensureHighlighter();
  LANG_LOADERS[id]()
    .then((m) => {
      fetchedMods.set(id, m.default);
      return registerFetched();
    })
    .catch((e) => console.error(`shiki 语法 ${id} 加载失败，该语言降级为无高亮`, e));
}

/** 该语言此刻能否同步高亮（highlighter 与语法都已就绪）。 */
const ready = (langId: string) => !!hl && loadedLangs.has(langId);

/**
 * 把一段源码渲染为高亮 HTML。
 * 语法未就绪时先触发按需加载并返回**已转义**的无高亮 `<pre>`，就绪后由 onHighlighterReady 通知重渲染。
 * @param langId 已归一的 shiki 语言 id（用 langForPath / langForFence 取），null = 直接走纯文本
 */
export function highlightToHtml(code: string, langId: string | null): string {
  if (langId && ready(langId)) {
    return hl!.codeToHtml(code, { lang: langId, themes: THEMES, defaultColor: "light" });
  }
  if (langId) requestLang(langId);
  return plainToHtml(code);
}

/** 无高亮兜底：逐行包 <span class="line">，与 shiki 输出同构 —— 行号等按行的样式两条路径通用。 */
function plainToHtml(code: string): string {
  const lines = escapeHtml(code)
    .split("\n")
    .map((l) => `<span class="line">${l}</span>`)
    .join("\n");
  return `<pre><code>${lines}</code></pre>`;
}

/** 订阅「有新语法就绪」，收到后重渲染即可拿到着色版。返回取消订阅函数。 */
export function onHighlighterReady(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
