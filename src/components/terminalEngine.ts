import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { invoke, Channel } from "@tauri-apps/api/core";
import { pingAgentActivity } from "../agentStatus";
import { attachMiddleScroll } from "../middleScroll";
import "@xterm/xterm/css/xterm.css";

/**
 * 终端引擎注册表 —— xterm.js 官方最小集成模式（一次性清掉历史补丁，全部交给成熟机制）。
 *
 * 1. DOM 渲染器（xterm 默认）：无 WebGL → 无纹理图集损坏、无浏览器 WebGL context 上限。
 * 2. 零 term.refresh() 强制重绘：重绘交给 xterm 自身渲染循环 + 内置 IntersectionObserver
 *    （容器不可见时自动暂停、恢复显示自动全量重绘 —— VS Code 同款，杜绝自写"切屏空白/残留"）。
 * 3. 尺寸：单一 ResizeObserver + 防抖 fit；尺寸稳定后才按真实列宽建 PTY，之后仅在尺寸真的变了
 *    才 resize；绝不在切区/激活时乱 resize（claude 整屏重绘错位叠影的根因就是启动期被乱 resize）。
 * 4. 粘贴：只走标准 paste 事件一条路径（capture 阶段拦截，避免 xterm 再粘一遍 → 双重粘贴）。
 * 5. 引擎与 React/dockview 挂载解耦：dockview 重排会卸载重挂面板，xterm 挂在游离 host 元素上，
 *    attach=塞进容器、detach=移出保留、dispose=面板真正关闭时才结束 PTY。
 */
interface Engine {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement; // 游离 host 元素，承载 xterm
  opened: boolean;
  ro?: ResizeObserver;
  onTitle?: (title: string) => void; // 程序设置终端标题(OSC)时回调（Tab 自动命名）
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
  pendingLaunch?: string; // 待发的启动命令（如 "claude\r"），等 created+提示符就绪才发
  created: boolean; // 后端 PTY 是否已创建
  launchArmed: boolean; // shell 提示符已就绪（createPty 后 ~600ms）
  launched: boolean; // 启动命令已发出
  lastCols?: number; // 上次发给 PTY 的尺寸；去重避免多余 SIGWINCH 把运行中的 TUI 画花
  lastRows?: number;
  fitTimer?: number; // 防抖句柄：合并连续尺寸变化（挂载布局抖动 / 拖动分屏），稳定后只 fit 一次
  lastOutputAt?: number; // 最近一次收到 PTY 输出的时间戳（M7-D：静默=回合物理结束、可安全注入）
  agentKind?: string; // "claude"|"codex"|"shell"：决定是否把 PTY 活动上报运行状态总线
  lastPingAt?: number; // 最近一次向 agentStatus 上报活动的时刻（节流 PTY 高频输出，避免每帧都 ping）
  midScroll: () => void; // 解绑中键自动滚动（dispose 时调用；见 middleScroll.ts）
}

const engines = new Map<string, Engine>();

/**
 * 把粘贴文本规范化换行 + 成对 bracketed-paste 包裹，让 claude/codex 折叠成 [Pasted text +N lines]。
 * 强制包裹(不赌可能被 ConPTY 吞掉的 ?2004h)，换行统一 \n —— claude/codex 的 TUI 均按 \n 计行
 * (codex 实测 \n 折叠；claude 原生 Alt+V 内部也用 \n)。普通 shell 不包裹、换行转 \r 当逐行回车。
 */
function pasteData(agentKind: string | undefined, raw: string): string {
  if (agentKind === "claude" || agentKind === "codex") {
    const t = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return `\x1b[200~${t}\x1b[201~`;
  }
  return raw.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
}

/** 确保某 termId 的引擎存在；已存在则忽略。此时只建 xterm，PTY 延迟到尺寸稳定后才建。 */
export function ensureEngine(
  termId: string,
  shell?: string,
  launchCmd?: string,
  cwd?: string,
  env?: Record<string, string>,
  agentKind?: string, // "claude"|"codex"|"shell"：决定粘贴的换行/包裹方式
): void {
  if (engines.has(termId)) return;

  const el = document.createElement("div");
  el.style.width = "100%";
  el.style.height = "100%";

  const term = new Terminal({
    allowProposedApi: true, // Unicode11Addon 需要
    convertEol: false,
    // 英文走 Cascadia Code / Consolas；中文显式落 Microsoft YaHei，避免 Chromium 对 monospace 的
    // CJK 兜底落到偏细粗糙的 SimSun(宋体) → 中文渲染更平滑、贴近原生终端（Bug B：字体锐化）。
    fontFamily: '"Cascadia Code", "Consolas", "Microsoft YaHei", monospace',
    fontSize: 13,
    cursorBlink: true,
    cursorStyle: "bar", // 竖线光标（非粗块）
    scrollback: 5000,
    theme: {
      background: "#1f1e1d",
      foreground: "#e5e2dc",
      cursor: "#d97757",
      selectionBackground: "#3a3631",
    },
    // Windows=ConPTY：必须显式告知 xterm（VS Code 同款）。ConPTY 不透传转义序列、自己整屏重绘；
    // 关键：buildNumber<21376 的旧 ConPTY 不支持 reflow，此时 xterm 必须【禁用自身 reflow】，否则
    // resize 时 xterm 重排行 + ConPTY 整屏重绘【双重处理】→ 行错位/重复/叠影（claude 退出 resume
    // 选择器整屏重绘时最明显）。buildNumber 暂硬编码当前系统(Win10 19045)，待加 Rust 动态获取以
    // 适配 Win11(>=21376 时 ConPTY 支持 reflow、xterm 不禁用)。
    windowsPty: navigator.userAgent.includes("Windows")
      ? { backend: "conpty", buildNumber: 19045 }
      : undefined,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon()); // 现代 Unicode 宽度表（默认 V6 算错宽字符宽度→列错位叠影）

  // 程序通过 OSC 设标题时回调（Tab 自动命名）
  term.onTitleChange((title) => engines.get(termId)?.onTitle?.(title));
  // 前端 → 后端：用户输入（PTY 未建时后端忽略）
  term.onData((data) =>
    invoke("write_terminal", { id: termId, data }).catch(() => {}),
  );

  // 复制粘贴：
  // · Ctrl+V → 用 navigator.clipboard 读剪贴板(本 WebView 实测可用；paste 事件的 clipboardData
  //   在 WebView2 读不到，故不用)，按 agent 规范化换行 + bracketed 包裹后注入。
  // · Ctrl+C → 有选区复制并清选区，无选区放行(=SIGINT)。
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !e.ctrlKey || e.altKey) return true;
    if (e.key === "v" || e.key === "V") {
      navigator.clipboard
        ?.readText()
        .then((raw) => {
          if (raw)
            invoke("write_terminal", {
              id: termId,
              data: pasteData(agentKind, raw),
            }).catch(() => {});
        })
        .catch(() => {});
      return false;
    }
    if ((e.key === "c" || e.key === "C") && !e.shiftKey) {
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard?.writeText(sel).catch(() => {});
        term.clearSelection();
        return false;
      }
    }
    return true;
  });

  // 吞掉 WebView 原生 paste 事件：上面 Ctrl+V 已自己读剪贴板注入，这里 preventDefault 阻止
  // xterm 再用自带 paste 逻辑粘一遍 → 杜绝"Ctrl+V 粘两遍"。
  el.addEventListener(
    "paste",
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    },
    true,
  );

  engines.set(termId, {
    term,
    fit,
    el,
    opened: false,
    shell,
    cwd,
    env,
    agentKind,
    pendingLaunch: launchCmd,
    created: false,
    launchArmed: false,
    launched: false,
    // 中键自动滚动挂宿主 el（与 paste 拦截同位置）：跟随引擎生命周期，dockview 重排不丢
    midScroll: attachMiddleScroll(term, el),
  });
}

/** 按"当前已 fit 的真实列宽"创建后端 PTY（每个引擎只建一次）。 */
function createPty(termId: string): void {
  const e = engines.get(termId);
  if (!e || e.created) return;
  e.created = true;
  const cols = e.term.cols || 80;
  const rows = e.term.rows || 24;
  e.lastCols = cols;
  e.lastRows = rows;

  const onOutput = new Channel<number[]>();
  onOutput.onmessage = (bytes) => {
    const now = Date.now();
    e.lastOutputAt = now; // 记录输出时刻 → 供 M7-D 静默检测(物理确认)
    // 运行状态总线（agentStatus 三态）：agent 终端的 PTY 字节流活动 = 正在跑。比 OSC 标题跳动更可靠
    // —— TUI 的 spinner 是【正文行高频重绘】(走 PTY)，而 OSC 标题(OSC 2)仅在状态/会话名切换时低频更新；
    // 只盯标题会在"spinner 在转但标题静默"时把运行中误判为完成。节流 250ms，避免每帧 ping。
    if (
      (e.agentKind === "claude" || e.agentKind === "codex") &&
      now - (e.lastPingAt ?? 0) >= 250
    ) {
      e.lastPingAt = now;
      pingAgentActivity(termId);
    }
    e.term.write(new Uint8Array(bytes));
  };

  invoke("create_terminal", {
    id: termId,
    opts: { shell: e.shell, cwd: e.cwd, cols, rows, env: e.env },
    onOutput,
  })
    .then(() => {
      // shell 起到提示符（~600ms）后武装启动命令；尺寸已就绪 → maybeLaunch 即发
      setTimeout(() => {
        const e2 = engines.get(termId);
        if (e2) {
          e2.launchArmed = true;
          maybeLaunch(termId);
        }
      }, 600);
    })
    .catch((err) =>
      e.term.write(`\r\n\x1b[31m[create_terminal 失败] ${err}\x1b[0m\r\n`),
    );
}

/** shell 就绪 + PTY 已按真实列宽建好后，发启动命令（claude/codex 在正确尺寸下首次绘制）。 */
function maybeLaunch(termId: string): void {
  const e = engines.get(termId);
  if (!e || e.launched || !e.launchArmed || !e.pendingLaunch || !e.created)
    return;
  e.launched = true;
  invoke("write_terminal", { id: termId, data: e.pendingLaunch }).catch(
    () => {},
  );
}

/** 防抖：合并连续尺寸变化（挂载布局抖动 / 拖动分屏），稳定 100ms 后只 fit 一次。 */
function scheduleFit(termId: string): void {
  const e = engines.get(termId);
  if (!e) return;
  if (e.fitTimer) clearTimeout(e.fitTimer);
  e.fitTimer = window.setTimeout(() => doFit(termId), 100);
}

/**
 * 尺寸稳定后：首次 open + fit + 按真实列宽建 PTY；之后仅在列宽/行高真的变了才 resize。
 * 不做任何强制重绘 —— 重绘交给 xterm 渲染循环与内置 IntersectionObserver（恢复显示自会全量重画）。
 */
function doFit(termId: string): void {
  const e = engines.get(termId);
  if (!e) return;
  e.fitTimer = undefined;
  // 容器隐藏(display:none / 未布局)尺寸为 0：跳过；恢复显示时 xterm 内置 IntersectionObserver 自会重绘
  if (e.el.clientWidth === 0 || e.el.clientHeight === 0) return;
  if (!e.opened) {
    e.term.open(e.el);
    e.opened = true;
    // 激活 Unicode 11 宽度表（须在 open 后）：与 claude/ConPTY 的宽字符列计算对齐，避免列错位
    try {
      e.term.unicode.activeVersion = "11";
    } catch {
      /* ignore */
    }
    e.term.focus();
  }
  try {
    e.fit.fit();
  } catch {
    return; // 容器尺寸暂不可用
  }
  if (!e.created) {
    createPty(termId); // 尺寸已稳 → 按真实列宽建 PTY（claude 一出生即最终尺寸，启动期零 resize）
    return;
  }
  const { cols, rows } = e.term;
  if (cols !== e.lastCols || rows !== e.lastRows) {
    e.lastCols = cols;
    e.lastRows = rows;
    invoke("resize_terminal", { id: termId, cols, rows }).catch(() => {});
  }
  maybeLaunch(termId);
}

/** 外部（dockview 尺寸/可见性事件）触发重排：仅防抖 fit，重绘交给 xterm 自身。 */
export function refitEngine(termId: string): void {
  scheduleFit(termId);
}

/** 把引擎挂进容器（open 推迟到 doFit 容器就绪时），并监听尺寸。 */
export function attachEngine(termId: string, container: HTMLElement): void {
  const e = engines.get(termId);
  if (!e) return;
  container.appendChild(e.el);
  requestAnimationFrame(() => scheduleFit(termId));
  const ro = new ResizeObserver(() => scheduleFit(termId));
  ro.observe(container);
  e.ro = ro;
  if (e.opened) e.term.focus();
}

/** 从容器移出（保留 xterm + PTY，供重新挂载）。 */
export function detachEngine(termId: string): void {
  const e = engines.get(termId);
  if (!e) return;
  e.ro?.disconnect();
  e.ro = undefined;
  if (e.fitTimer) clearTimeout(e.fitTimer);
  e.el.parentElement?.removeChild(e.el);
}

/** 彻底销毁：结束 PTY、释放 xterm。仅在面板真正关闭时调用。 */
export function disposeEngine(termId: string): void {
  const e = engines.get(termId);
  if (!e) return;
  e.ro?.disconnect();
  if (e.fitTimer) clearTimeout(e.fitTimer);
  e.midScroll(); // 解绑中键滚动；若滚动会话正属于本终端则一并清场
  if (e.created) invoke("close_terminal", { id: termId }).catch(() => {});
  e.term.dispose();
  e.el.parentElement?.removeChild(e.el);
  engines.delete(termId);
}

/** 让某终端获得键盘焦点（拖拽注入后调用）。 */
export function focusEngine(termId: string): void {
  engines.get(termId)?.term.focus();
}

/**
 * M7-D 全自动接力：等该终端静默(回合物理结束)后再向 PTY 注入 data，避免打断运行中的 TUI 撕裂画面。
 * 轮询直到静默 ≥ quietMs，或超过 timeoutMs 兜底注入；终端已不存在则放弃。
 */
export function autoInjectWhenQuiet(
  termId: string,
  data: string,
  opts?: { quietMs?: number; timeoutMs?: number },
): void {
  const quietNeed = opts?.quietMs ?? 1000;
  const deadline = Date.now() + (opts?.timeoutMs ?? 6000);
  const tick = () => {
    const e = engines.get(termId);
    if (!e || !e.created) return; // 终端没了 → 放弃
    const quiet = Date.now() - (e.lastOutputAt ?? 0);
    if (quiet >= quietNeed || Date.now() >= deadline) {
      invoke("write_terminal", { id: termId, data }).catch(() => {});
      e.term.focus();
      return;
    }
    window.setTimeout(tick, 300);
  };
  tick();
}

/** 注册/清除"终端标题变化"回调（Tab 自动命名用）。 */
export function setEngineTitleHandler(
  termId: string,
  fn: ((title: string) => void) | undefined,
): void {
  const e = engines.get(termId);
  if (e) e.onTitle = fn;
}

/** 结束某前缀（= 某 workspace）的所有终端，关闭工作区时用。 */
export function disposeByPrefix(prefix: string): void {
  for (const id of [...engines.keys()]) {
    if (id.startsWith(prefix)) disposeEngine(id);
  }
}
