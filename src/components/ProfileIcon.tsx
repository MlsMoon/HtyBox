import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";
import opencodeIcon from "../assets/opencode.svg";
import cursorIcon from "../assets/cursor.svg";

/** Kimi 品牌图标（内联 SVG：白 K + 蓝点）。K 的 fill 走 .kimi-k，深色主题经 CSS 反转成白底黑 K（见 index.css .kimi-glyph）。 */
export function KimiIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={"kimi-glyph " + (className ?? "")} aria-hidden="true">
      <path
        d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z"
        fill="#1783FF"
      />
      <path
        className="kimi-k"
        fill="#fff"
        d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"
      />
    </svg>
  );
}

/** 按 Profile id 渲染品牌图标：Claude / Codex / Cursor 用官方 SVG 素材，Kimi 用内联 KimiIcon；PowerShell 用终端 >_。 */
export function ProfileIcon({ id }: { id: string }) {
  if (id === "claude")
    return (
      <img src={claudeIcon} alt="Claude" className="h-4 w-4" draggable={false} />
    );
  if (id === "codex")
    return (
      <img src={codexIcon} alt="Codex" className="codex-glyph h-4 w-4" draggable={false} />
    );
  if (id === "opencode")
    return <img src={opencodeIcon} alt="OpenCode" className="h-4 w-4" draggable={false} />;
  if (id === "cursor")
    return (
      <img src={cursorIcon} alt="Cursor" className="cursor-glyph h-4 w-4" draggable={false} />
    );
  if (id === "kimi") return <KimiIcon className="h-4 w-4" />;
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 7 9 12 4 17" />
      <line x1="11" y1="17" x2="19" y2="17" />
    </svg>
  );
}
