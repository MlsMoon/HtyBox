// 按扩展名的文件种类判定，全项目共用一份。
// 此前 DockEditor 与 FileTypeIcon 各存了一份同义正则，改动时容易只改一处而漂移，故收敛到这里。

/** 位图（走只读图片预览；svg 是文本，不在此列）。 */
export const IMAGE_RE = /\.(png|jpe?g|jfif|gif|webp|bmp|ico|avif)$/i;

/** 源码 / 结构化文本（可给只读语法高亮预览态；具体有没有语法由 highlighter.langForPath 决定）。 */
export const CODE_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|pyw|rs|go|java|c|h|cc|cpp|cxx|hpp|hh|cs|rb|php|swift|kt|kts|scala|sh|bash|zsh|ps1|psm1|psd1|bat|cmd|lua|sql|r|dart|vue|svelte|astro|json|json5|jsonc|ya?ml|toml|ini|cfg|conf|editorconfig|xml|xaml|csproj|props|targets|plist|html?|css|scss|sass|less|styl|graphql|proto)$/i;

export const MD_RE = /\.(md|markdown)$/i;
export const SVG_RE = /\.svg$/i;
