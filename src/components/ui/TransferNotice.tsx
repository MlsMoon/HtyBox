export type TransferNoticeTone = "busy" | "success" | "error";

export interface TransferNoticeValue {
  tone: TransferNoticeTone;
  message: string;
  details?: readonly string[];
}

export default function TransferNotice({
  value,
  onClose,
}: {
  value: TransferNoticeValue;
  onClose?: () => void;
}) {
  const toneClass =
    value.tone === "error"
      ? "border-[var(--danger)]/40 bg-[var(--danger)]/8"
      : value.tone === "success"
        ? "border-[var(--success)]/40 bg-[var(--success)]/8"
        : "border-[var(--accent-border)] bg-[var(--accent-soft)]";
  const textClass =
    value.tone === "error"
      ? "text-[var(--danger)]"
      : value.tone === "success"
        ? "text-[var(--success)]"
        : "text-[var(--accent-text)]";

  return (
    <div
      className={`mx-2.5 mb-1.5 flex min-w-0 items-start gap-2 rounded-md border px-2 py-1.5 ${toneClass}`}
      role={value.tone === "error" ? "alert" : "status"}
      aria-live={value.tone === "error" ? "assertive" : "polite"}
    >
      {value.tone === "busy" ? (
        <span
          className="mt-0.5 h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--accent)] border-t-transparent"
          aria-hidden="true"
        />
      ) : (
        <span className={`shrink-0 text-[11px] leading-relaxed ${textClass}`} aria-hidden="true">
          {value.tone === "success" ? "✓" : "⚠"}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[10.5px] leading-relaxed ${textClass}`} title={value.message}>
          {value.message}
        </div>
        {value.details?.map((detail, index) => (
          <div
            key={`${index}:${detail}`}
            className="truncate text-[9.5px] leading-relaxed text-[var(--text-3)]"
            title={detail}
          >
            {detail}
          </div>
        ))}
      </div>
      {value.tone !== "busy" && onClose && (
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-[10px] text-[var(--text-3)] hover:text-[var(--text)]"
          title="关闭提示"
          aria-label="关闭提示"
        >
          ✕
        </button>
      )}
    </div>
  );
}
