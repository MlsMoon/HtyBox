// Plans/Bugs/技术债分类页(共用):全量列表 + 搜索 + 状态筛选 chips(仅 plans)+ 分页导航。
// 用户反馈:数据量大用分页不靠长滚动条;小数据量如实单页(Pager 自隐)。
import { useEffect, useState } from "react";
import type { DocPage } from "../../../htyenv";
import { Pager, PreviewModal, fmtUtc } from "./shared";

const PAGE_SIZE = 20;
/** plan-create 模板常见状态(contains 匹配;非常见状态仍在「全部」可见) */
const PLAN_STATUS_CHIPS = ["全部", "执行中", "主体完成", "已完工", "待确认"];

export default function DocListSection({
  title,
  hasStatus,
  fetchPage,
}: {
  title: string;
  /** plans=true:显示状态列与状态筛选 chips */
  hasStatus: boolean;
  fetchPage: (offset: number, limit: number, query?: string, status?: string) => Promise<DocPage>;
}) {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("全部");
  const [data, setData] = useState<DocPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const statusFilter = hasStatus && status !== "全部" ? status : undefined;
    fetchPage((page - 1) * PAGE_SIZE, PAGE_SIZE, query.trim() || undefined, statusFilter)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [fetchPage, page, query, status, hasStatus]);

  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="flex h-full flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-[13px] font-bold">
          {title}({data?.total ?? "…"})
        </span>
        {data != null && data.parseFailures > 0 && (
          <span className="text-[10px] text-[var(--danger)]">解析失败 {data.parseFailures} 项(已排除)</span>
        )}
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          placeholder="按名称搜索…"
          className="ml-auto w-56 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-1.5 text-[11px] text-[var(--text)] placeholder:text-[var(--text-3)] focus:border-[var(--accent-border)] focus:outline-none"
        />
      </div>
      {hasStatus && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {PLAN_STATUS_CHIPS.map((c) => (
            <button
              key={c}
              onClick={() => {
                setStatus(c);
                setPage(1);
              }}
              className={
                "rounded-full border px-2.5 py-0.5 text-[10px] transition-colors " +
                (status === c
                  ? "border-[var(--accent-border)] bg-[var(--accent-soft)] font-semibold text-[var(--accent-text)]"
                  : "border-[var(--border)] text-[var(--text-3)] hover:text-[var(--text)]")
              }
            >
              {c}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="py-6 text-center text-[11px] text-[var(--danger)]">{error}</div>
        ) : !data ? (
          <div className="py-6 text-center text-xs text-[var(--text-3)]">加载中…</div>
        ) : data.items.length === 0 ? (
          <div className="py-6 text-center text-xs text-[var(--text-3)]">
            {data.total === 0 && !query && status === "全部" ? "暂无条目" : "无匹配结果"}
          </div>
        ) : (
          data.items.map((d) => (
            <div
              key={d.path}
              onDoubleClick={() => setPreview(d.path)}
              title="双击预览全文"
              className="flex cursor-default items-center gap-3 border-b border-[var(--border-soft)] py-2 last:border-b-0 hover:bg-[var(--elevated)]/50"
            >
              <span className="w-20 shrink-0 font-mono text-[10px] text-[var(--text-3)]">{d.date ?? "-"}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text)]" title={d.name}>
                {d.name}
              </span>
              {hasStatus && (
                <span className="w-56 shrink-0 truncate text-right text-[10.5px] text-[var(--text-3)]" title={d.status}>
                  {d.status ?? ""}
                </span>
              )}
              <span className="w-20 shrink-0 text-right font-mono text-[9.5px] text-[var(--text-faint)]">
                {fmtUtc(d.modifiedUtc)}
              </span>
            </div>
          ))
        )}
      </div>
      <Pager page={page} pageCount={pageCount} onPage={setPage} />
      {preview && <PreviewModal path={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
