// 按扩展名给出的文件类型徽章图标（实心彩色圆角方块 + 白色符号）。
// 主窗终端 dock 的 Tab 与内容预览窗口的 Tab 共用同一套，避免两处各画一份导致风格漂移。
import { CODE_RE, IMAGE_RE, MD_RE, SVG_RE } from "../../fileKinds";

export default function FileTypeIcon({ path, className }: { path: string; className?: string }) {
  const cls = className ?? "h-[15px] w-[15px] shrink-0";
  if (IMAGE_RE.test(path))
    return (
      <svg className={cls} viewBox="0 0 24 24">
        <rect x="2" y="3.5" width="20" height="17" rx="5" fill="#2fa35e" />
        <circle cx="8" cy="9.5" r="1.6" fill="#fff" />
        <path d="M4.5 16.5 L9 12 L12 14.5 L15.5 11 L19.5 16" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (SVG_RE.test(path))
    return (
      <svg className={cls} viewBox="0 0 24 24">
        <rect x="2" y="3.5" width="20" height="17" rx="5" fill="#d97757" />
        <path d="M5 15 C 8.5 9.5, 15.5 9.5, 19 15" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
        <rect x="3.4" y="13.6" width="3" height="3" rx="0.5" fill="#fff" />
        <rect x="17.6" y="13.6" width="3" height="3" rx="0.5" fill="#fff" />
        <circle cx="12" cy="9.2" r="1.5" fill="#fff" />
      </svg>
    );
  if (MD_RE.test(path))
    return (
      <svg className={cls} viewBox="0 0 24 24">
        <rect x="2" y="3.5" width="20" height="17" rx="5" fill="#4f7cc4" />
        <path d="M6 15 V9.2 L8.4 12.2 L10.8 9.2 V15" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14.6 9.2 V13.6 M12.5 11.8 L14.6 14 L16.7 11.8" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (CODE_RE.test(path))
    return (
      <svg className={cls} viewBox="0 0 24 24">
        <rect x="2" y="3.5" width="20" height="17" rx="5" fill="#8b7cff" />
        <polyline points="9 8.5 6 12 9 15.5" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points="15 8.5 18 12 15 15.5" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="13.2" y1="7.6" x2="10.8" y2="16.4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg className={cls} viewBox="0 0 24 24">
      <rect x="2" y="3.5" width="20" height="17" rx="5" fill="#8c8a82" />
      <line x1="7" y1="9" x2="17" y2="9" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      <line x1="7" y1="12" x2="17" y2="12" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      <line x1="7" y1="15" x2="13" y2="15" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
