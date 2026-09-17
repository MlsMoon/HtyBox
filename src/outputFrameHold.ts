/**
 * 同步输出帧合并(DEC 私有模式 2026,纯状态机,Node 可测)。
 *
 * 背景:支持同步输出的 TUI(如 Kimi Code 2.0 的 pi-tui)把一帧包在 `ESC[?2026h`(BSU)…`ESC[?2026l`(ESU)里;
 * 一帧若分多条 IPC 消息跨 rAF 到达,xterm 会在多个解析任务里消费它——行渲染虽被 xterm 的同步模式缓冲,
 * 但滚动条尺寸随每次 scroll 同步更新,全量重绘(清 scrollback + 整段重写)时滚动条先变满再逐帧缩回。
 * 本状态机让「BSU 到 ESU」之间的字节暂存,等 ESU 到齐再一次性写给 xterm,使整帧落在同一解析任务内;
 * 帧外字节(含同块里前一帧已闭合的部分)不受牵连,按到达顺序即时放行。
 *
 * 只识别这一对固定字节序列,不解析任何 TUI 语义;不改写、不丢、不重排字节——只决定「何时放行」。
 * 超时由调用侧经 `flush()` 兜底(与 xterm 自身 1000ms 同步超时同类的协议安全边界),
 * 放行后退化为逐块直写,直到下一个 BSU。
 */

export interface SyncOutputHold {
  /** 喂入一块输出;返回本次应写给 xterm 的字节块(可能为空 = 全部暂存;顺序与到达一致)。 */
  push(chunk: Uint8Array): Uint8Array[];
  /** 放行全部暂存并退出暂存态(超时 / 关闭时调用);无暂存返回空数组。 */
  flush(): Uint8Array[];
  /** 是否处于「BSU 已见、ESU 未到」的暂存态(调用侧据此起/清超时定时器)。 */
  readonly holding: boolean;
}

// ESC [ ? 2 0 2 6 —— 后跟 'h'(0x68)=BSU / 'l'(0x6c)=ESU
const PREFIX = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36];
const BSU_FINAL = 0x68;
const ESU_FINAL = 0x6c;

/**
 * @param maxHeldBytes 暂存字节上限:达到即在 push 内自动放行(防单帧无界积压)
 */
export function createSyncOutputHold(maxHeldBytes: number): SyncOutputHold {
  let matched = 0; // 已匹配的前缀字节数(跨块延续,天然处理序列被拆在两块边界)
  let holding = false;
  let held: Uint8Array[] = [];
  let heldBytes = 0;

  /**
   * 扫描一块:返回本块结束时仍未闭合的那个 BSU 在块内的起点(前缀跨块则为 0;
   * 块开始时已在暂存态且块内无新 BSU 亦为 0);块结束时不在帧内返回 -1。
   */
  const scan = (chunk: Uint8Array): number => {
    let openAt = holding ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (matched === PREFIX.length) {
        if (b === BSU_FINAL) openAt = Math.max(0, i - PREFIX.length);
        else if (b === ESU_FINAL) openAt = -1;
        matched = b === PREFIX[0] ? 1 : 0;
        continue;
      }
      if (b === PREFIX[matched]) matched++;
      else matched = b === PREFIX[0] ? 1 : 0;
    }
    return openAt;
  };

  const release = (): Uint8Array[] => {
    const out = held;
    held = [];
    heldBytes = 0;
    return out;
  };

  return {
    push(chunk) {
      const openAt = scan(chunk);
      if (openAt < 0) {
        holding = false;
        if (!held.length) return [chunk];
        held.push(chunk);
        return release();
      }
      holding = true;
      let out: Uint8Array[] = [];
      if (openAt > 0) {
        // 块前段属于已闭合的帧(或帧外),连同此前暂存一并放行;从 BSU 起暂存
        out = release();
        out.push(chunk.subarray(0, openAt));
        chunk = chunk.subarray(openAt);
      }
      held.push(chunk);
      heldBytes += chunk.length;
      if (heldBytes >= maxHeldBytes) {
        holding = false;
        out.push(...release());
      }
      return out;
    },
    flush() {
      holding = false;
      return release();
    },
    get holding() {
      return holding;
    },
  };
}
