import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";
import cursorIcon from "../assets/cursor.svg";

/** 按 Profile id 渲染品牌图标：Claude / Codex / Cursor 用官方 SVG 素材；PowerShell 用终端 >_。 */
export function ProfileIcon({ id }: { id: string }) {
  if (id === "claude")
    return (
      <img src={claudeIcon} alt="Claude" className="h-4 w-4" draggable={false} />
    );
  if (id === "codex")
    return (
      <img src={codexIcon} alt="Codex" className="codex-glyph h-4 w-4" draggable={false} />
    );
  if (id === "cursor")
    return (
      <img src={cursorIcon} alt="Cursor" className="cursor-glyph h-4 w-4" draggable={false} />
    );
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
