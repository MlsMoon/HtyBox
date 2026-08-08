import { useCallback, useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeClipboardText } from "../platformServices";
import {
  applyPreset,
  exportAccounts,
  importAccounts,
  listAccounts,
  loginCancel,
  loginStart,
  loginWait,
  removePreset,
  renamePreset,
  saveApikeyPreset,
  type ListResult,
  type LoginPoll,
  type PresetView,
} from "../agentAccounts";
import { ProfileIcon } from "./ProfileIcon";
import ConfirmModal from "./ui/ConfirmModal";
import ContextMenu, { MENU_SEP } from "./ui/ContextMenu";
import { useMaskDismiss } from "./ui/maskDismiss";

const AGENT = "kimi";

const btnCls =
  "shrink-0 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-1.5 text-[12px] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-text)] disabled:cursor-default disabled:opacity-60 disabled:hover:border-[var(--border)] disabled:hover:text-[var(--text)]";
const softBtnCls =
  "shrink-0 rounded-lg border border-[var(--accent-border-soft)] bg-[var(--accent-soft)] px-3 py-1.5 text-[12px] font-semibold text-[var(--accent-text)] transition-colors hover:border-[var(--accent-border)] disabled:cursor-default disabled:opacity-60";
const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";

/** 弹窗骨架（遮罩外点关闭 + 卡片）。 */
function Dialog({
  title,
  onClose,
  children,
  width = 380,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  const mask = useMaskDismiss(onClose);
  return (
    <div className="fixed inset-0 z-[115] flex items-center justify-center bg-black/30" {...mask}>
      <div
        className="rounded-2xl border border-[var(--border)] bg-[var(--elevated)] p-4 shadow-2xl"
        style={{ width, maxWidth: "92vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm font-semibold text-[var(--text)]">{title}</div>
        {children}
      </div>
    </div>
  );
}

/** 重命名弹窗（单名称字段）。 */
function NameModal({
  initial,
  onSubmit,
  onClose,
}: {
  initial: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) {
      setErr("名称不能为空");
      return;
    }
    setBusy(true);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="重命名预设" onClose={onClose}>
      <input
        autoFocus
        className={inputCls}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
      />
      {err && <div className="mt-2 text-[11px] text-[var(--danger)]">{err}</div>}
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className={btnCls}>
          取消
        </button>
        <button disabled={busy} onClick={() => void submit()} className={softBtnCls}>
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </Dialog>
  );
}

/** 新建 / 编辑 API Key 预设弹窗（编辑时 key 留空 = 保持不变）。 */
function ApikeyModal({
  edit,
  onDone,
  onClose,
}: {
  /** null = 新建；否则编辑该预设 */
  edit: PresetView | null;
  onDone: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(edit?.name ?? "");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(edit?.baseUrl ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) {
      setErr("名称不能为空");
      return;
    }
    if (!edit && !key.trim()) {
      setErr("API Key 不能为空");
      return;
    }
    setBusy(true);
    try {
      await saveApikeyPreset(AGENT, edit?.id ?? null, name.trim(), key.trim(), baseUrl.trim() || null);
      onDone();
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={edit ? "编辑 API Key 预设" : "新建 API Key 预设"} onClose={onClose}>
      <div className="space-y-2.5">
        <div>
          <div className="mb-1 text-[11px] text-[var(--text-2)]">名称</div>
          <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <div className="mb-1 text-[11px] text-[var(--text-2)]">
            API Key{edit && <span className="text-[var(--text-faint)]">（留空保持不变：{edit.hint}）</span>}
          </div>
          <input
            className={inputCls + " font-mono text-[12.5px]"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-..."
            type="password"
          />
        </div>
        <div>
          <div className="mb-1 text-[11px] text-[var(--text-2)]">Base URL（可选，默认官方）</div>
          <input
            className={inputCls + " font-mono text-[12.5px]"}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.kimi.com/coding/v1"
          />
        </div>
      </div>
      <div className="mt-2 text-[10.5px] text-[var(--text-faint)]">key 仅保存在本机 HtyBox 配置目录，可随导出包迁移</div>
      {err && <div className="mt-1.5 text-[11px] text-[var(--danger)]">{err}</div>}
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className={btnCls}>
          取消
        </button>
        <button disabled={busy} onClick={() => void submit()} className={softBtnCls}>
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </Dialog>
  );
}

/** 新增登录预设弹窗：填名称 → 启动隔离 device-code 登录 → 展示授权链接/码 + 等待 → 成功自动关闭。 */
function LoginModal({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState<string | null>(null);
  const [poll, setPoll] = useState<LoginPoll | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const handleRef = useRef<string | null>(null);

  // 仅卸载时取消仍在进行的登录（kill + 清 staging）。
  // cleanup 绝不能依赖 [handle] —— setHandle 触发依赖变化会误跑 cleanup 把
  // cancelledRef 置 true，登录成功后被 `if (cancelledRef.current) return` 拦截，弹窗永不关闭。
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (handleRef.current) void loginCancel(handleRef.current).catch(() => undefined);
    };
  }, []);

  const start = async () => {
    if (!name.trim()) {
      setErr("请先填预设名称");
      return;
    }
    setErr(null);
    try {
      const h = await loginStart(AGENT, name.trim());
      handleRef.current = h;
      setHandle(h);
      const final = await loginWait(h, setPoll);
      if (cancelledRef.current) return;
      if (final.status === "success") {
        onDone();
        onClose();
      } else {
        setErr(final.detail ?? "登录失败，请重试");
        setHandle(null);
      }
    } catch (e) {
      if (!cancelledRef.current) {
        setErr(String(e));
        setHandle(null);
      }
    }
  };

  const cancel = () => {
    cancelledRef.current = true;
    if (handleRef.current) void loginCancel(handleRef.current).catch(() => undefined);
    onClose();
  };

  return (
    <Dialog title="新增登录预设 · Kimi Code" onClose={cancel} width={400}>
      <div className="mb-1 text-[11px] text-[var(--text-2)]">预设名称</div>
      <input
        autoFocus
        className={inputCls}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={handle !== null}
        onKeyDown={(e) => e.key === "Enter" && handle === null && void start()}
      />

      {handle !== null && (
        <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3">
          <div className="text-[11px] text-[var(--text-2)]">已为你打开浏览器完成授权；未打开请手动访问：</div>
          {poll?.url ? (
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[11px] text-[var(--accent-text)]" title={poll.url}>
                {poll.url.replace(/^https?:\/\/(www\.)?/, "").split("?")[0]}
              </span>
              <button
                onClick={() => void writeClipboardText(poll.url ?? "")}
                className={btnCls + " px-2 py-1 text-[11px]"}
              >
                复制链接
              </button>
            </div>
          ) : (
            <div className="mt-1 text-[11px] text-[var(--text-faint)]">正在获取授权链接…</div>
          )}
          {poll?.userCode && (
            <div className="mt-2 font-mono text-[20px] font-bold tracking-[2px] text-[var(--text)]">
              {poll.userCode}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <span className="agent-cli-indet-track relative h-1 w-4 overflow-hidden rounded-full bg-[var(--surface-hover)]">
              <span className="agent-cli-indet-bar" />
            </span>
            <span className="text-[11px] text-[var(--text-2)]">等待授权完成…（成功后自动保存并关闭）</span>
          </div>
          <div className="mt-1.5 text-[10px] text-[var(--text-faint)]">
            授权码有时效 · 也可用其他设备访问该链接 · 登录在隔离环境进行，不影响当前账号
          </div>
        </div>
      )}

      {err && <div className="mt-2 text-[11px] text-[var(--danger)]">{err}</div>}
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={cancel} className={btnCls}>
          取消
        </button>
        {handle === null && (
          <button onClick={() => void start()} className={softBtnCls}>
            开始登录
          </button>
        )}
      </div>
    </Dialog>
  );
}

/** 设置「Agent 配置」页：Kimi 账号 / API Key 预设管理 + 一键切换（第一期仅 kimi）。 */
export default function AgentAccountsSettings() {
  const [data, setData] = useState<ListResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; preset: PresetView } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PresetView | null>(null);
  const [confirmApply, setConfirmApply] = useState<PresetView | null>(null);
  const [apikeyEdit, setApikeyEdit] = useState<PresetView | "new" | null>(null);
  const [renameTarget, setRenameTarget] = useState<PresetView | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmImport, setConfirmImport] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await listAccounts(AGENT));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setNotice(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  };

  const doApply = (preset: PresetView) =>
    run(async () => {
      setBusyId(preset.id);
      try {
        const r = await applyPreset(AGENT, preset.id);
        if (r.autoArchived) setNotice(`已自动存档切换前的登录为「${r.autoArchived}」`);
      } finally {
        setBusyId(null);
      }
    });

  const doExport = () =>
    run(async () => {
      const destination = await save({
        title: "导出 Agent 配置",
        defaultPath: "agent-accounts.htybox-accounts",
        filters: [{ name: "HtyBox Agent 配置", extensions: ["htybox-accounts"] }],
      });
      if (!destination) return;
      const path = await exportAccounts(destination);
      setNotice(`已导出到 ${path}`);
    });

  const doImport = async () => {
    setErr(null);
    setNotice(null);
    const source = await open({
      title: "导入 Agent 配置",
      multiple: false,
      filters: [{ name: "HtyBox Agent 配置", extensions: ["htybox-accounts"] }],
    });
    if (typeof source === "string") setConfirmImport(source);
  };

  const current = data?.current;
  const matchedName =
    current?.matchedPresetId && data?.presets.find((p) => p.id === current.matchedPresetId)?.name;
  const modeLabel =
    current?.mode === "oauth" ? "账号登录" : current?.mode === "apikey" ? "API Key" : null;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--text)]">账号 / API Key 预设</div>
          <div className="text-[11px] text-[var(--text-faint)]">
            预设多个登录账号或 API Key 一键切换（cc-switch 式）；预设全局共享，支持导入导出
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={() => void doImport()} className={btnCls}>
            导入
          </button>
          <button onClick={() => void doExport()} className={btnCls}>
            导出
          </button>
        </div>
      </div>

      {/* ===== 当前生效卡 ===== */}
      <div className="mx-3 rounded-xl border border-[var(--border)] bg-[var(--elevated)] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={
              "h-2 w-2 shrink-0 rounded-full " +
              (current?.mode === "none" || !current ? "bg-[var(--text-3)]" : "bg-[var(--success)]")
            }
          />
          <span className="text-[12.5px] font-semibold text-[var(--text)]">
            {!current || current.mode === "none"
              ? "当前未检测到生效的登录 / Key"
              : `当前生效：${modeLabel}${matchedName ? ` · ${matchedName}` : current.matchedPresetId ? "" : "（未保存为预设）"}`}
          </span>
          {current && current.mode !== "none" && !current.matchedPresetId && (
            <span className="ml-auto shrink-0 text-[10.5px] text-[var(--text-faint)]">切换预设时自动存档</span>
          )}
        </div>
        {current && current.mode !== "none" && current.hint && (
          <div className="ml-4 mt-0.5 font-mono text-[10.5px] text-[var(--text-3)]">
            {current.hint}
            {current.mode === "oauth" ? "  ·  ~/.kimi-code/credentials/kimi-code.json" : "  ·  ~/.kimi-code/config.toml"}
          </div>
        )}
      </div>

      {/* ===== Kimi 区块 ===== */}
      <div className="flex items-center gap-2.5 px-3 pt-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">
          <ProfileIcon id="kimi" />
        </span>
        <span className="text-[13px] font-semibold text-[var(--text)]">Kimi Code</span>
        <code className="font-mono text-[10px] text-[var(--text-faint)]">kimi</code>
      </div>

      {/* ===== 预设列表 ===== */}
      <div className="mx-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--elevated)]">
        {!data || data.presets.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <div className="text-[13px] font-semibold text-[var(--text-2)]">暂无预设</div>
            <div className="mt-1 text-[11px] text-[var(--text-faint)]">
              新增登录预设完成授权，或新建 API Key 预设，之后即可一键切换
            </div>
          </div>
        ) : (
          data.presets.map((p, i) => {
            const active = current?.matchedPresetId === p.id;
            return (
              <div
                key={p.id}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, preset: p });
                }}
                className={
                  "flex items-center gap-3 px-3.5 py-2.5 " +
                  (active ? "bg-[var(--surface-soft)]" : "hover:bg-[var(--surface-soft)]") +
                  (i > 0 ? " border-t border-[var(--border-soft)]" : "")
                }
              >
                <span
                  className={
                    "shrink-0 rounded-md px-2 py-0.5 text-[10.5px] font-semibold " +
                    (p.kind === "oauth"
                      ? "bg-[var(--accent-soft)] text-[var(--accent-text)]"
                      : "bg-[var(--surface-hover)] text-[var(--text-2)]")
                  }
                >
                  {p.kind === "oauth" ? "账号" : "API Key"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-[var(--text)]">{p.name}</div>
                  <div className="truncate font-mono text-[10px] text-[var(--text-3)]">
                    {p.hint}
                    {p.kind === "apikey" && p.baseUrl ? `  ·  ${p.baseUrl.replace(/^https?:\/\//, "")}` : ""}
                  </div>
                </div>
                {active ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--success)]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
                    生效中
                  </span>
                ) : (
                  <button
                    disabled={busyId !== null}
                    onClick={() => setConfirmApply(p)}
                    className={btnCls + " px-2.5 py-1 text-[11.5px]"}
                  >
                    {busyId === p.id ? "切换中…" : "切换"}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ===== 底部操作 ===== */}
      <div className="flex items-center gap-2 px-3 pt-2">
        <button onClick={() => setLoginOpen(true)} className={softBtnCls}>
          + 新增登录预设
        </button>
        <button onClick={() => setApikeyEdit("new")} className={btnCls}>
          + 新建 API Key 预设
        </button>
      </div>

      {notice && <div className="px-3 pt-1.5 text-[11px] text-[var(--accent-text)]">{notice}</div>}
      {err && <div className="px-3 pt-1.5 text-[11px] text-[var(--danger)]">{err}</div>}

      {/* ===== 说明 ===== */}
      <div className="space-y-0.5 px-3 pt-2 text-[10.5px] leading-relaxed text-[var(--text-faint)]">
        <div>· 切换对之后新开的 kimi 终端生效；已在运行的终端请重启后生效</div>
        <div>· 登录预设经「新增登录预设」弹窗内完成授权（device-code），不影响当前登录</div>
        <div>· 右键预设行：重命名 / 编辑 / 删除（删除需确认）</div>
      </div>

      {/* ===== 右键菜单 / 弹窗 ===== */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { id: "rename", label: "重命名" },
            ...(menu.preset.kind === "apikey" ? [{ id: "edit", label: "编辑 Key / Base URL" }] : []),
            MENU_SEP,
            { id: "delete", label: "删除预设", danger: true },
          ]}
          onAction={(id) => {
            if (id === "rename") setRenameTarget(menu.preset);
            if (id === "edit") setApikeyEdit(menu.preset);
            if (id === "delete") setConfirmDelete(menu.preset);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {renameTarget && (
        <NameModal
          initial={renameTarget.name}
          onSubmit={async (name) => {
            await renamePreset(AGENT, renameTarget.id, name);
            await reload();
          }}
          onClose={() => setRenameTarget(null)}
        />
      )}
      {apikeyEdit !== null && (
        <ApikeyModal
          edit={apikeyEdit === "new" ? null : apikeyEdit}
          onDone={() => void reload()}
          onClose={() => setApikeyEdit(null)}
        />
      )}
      {loginOpen && <LoginModal onDone={() => void reload()} onClose={() => setLoginOpen(false)} />}
      {confirmDelete && (
        <ConfirmModal
          title={`删除预设「${confirmDelete.name}」？`}
          message="仅删除 HtyBox 保存的预设，不影响当前正在生效的登录状态。"
          confirmText="删除"
          onConfirm={() =>
            void run(async () => {
              await removePreset(AGENT, confirmDelete.id);
            })
          }
          onClose={() => setConfirmDelete(null)}
        />
      )}
      {confirmImport && (
        <ConfirmModal
          title="导入 Agent 配置？"
          message="导入将替换当前全部预设（导入失败会自动回滚）。"
          confirmText="导入并替换"
          onConfirm={() =>
            void run(async () => {
              const count = await importAccounts(confirmImport);
              setNotice(`已导入 ${count} 个预设`);
            })
          }
          onClose={() => setConfirmImport(null)}
        />
      )}
      {confirmApply && (
        <Dialog title={`切换到「${confirmApply.name}」？`} onClose={() => setConfirmApply(null)}>
          <div className="text-[12px] leading-relaxed text-[var(--text-2)]">
            {confirmApply.kind === "oauth"
              ? "将清空 config.toml 的 API Key 并恢复该账号的登录凭证。对之后新开的 kimi 终端生效；已在运行的 kimi 终端请重启后生效。"
              : "将写入 API Key 到 config.toml 并撤下当前登录凭证（当前登录会自动存档为快照预设）。对之后新开的 kimi 终端生效；已在运行的 kimi 终端请重启后生效。"}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setConfirmApply(null)} className={btnCls}>
              取消
            </button>
            <button
              onClick={() => {
                const p = confirmApply;
                setConfirmApply(null);
                void doApply(p);
              }}
              className={softBtnCls}
            >
              切换
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
