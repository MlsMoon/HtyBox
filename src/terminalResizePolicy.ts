/**
 * 终端 resize 策略(纯逻辑,Node 可测;接线见 terminalEngine.ts 的 doFit)。
 *
 * 背景:HtyBox 给 xterm 设了 `windowsPty: { backend: "conpty", buildNumber: 19045 }` 以关掉 xterm 自身
 * 的 reflow(旧 ConPTY 不支持 reflow,双方都重排会造成行错位/叠影)。但该选项还会连带改变
 * **行数变多**时的缓冲区行为:xterm 转而在缓冲区末尾追加空行,不把回滚区历史拉回视口
 * (源码注释的理由是「conpty 会按自己的世界观重绘整屏」)。
 *
 * 实测该前提在本机不成立:连续 resize ConPTY 零字节输出、完全不重绘。于是行数变多后
 * 内容留在视口上部、光标下方留一片空行 —— 用户看到的「界面被拉到最上面」。会自己响应
 * 终端尺寸变化重绘的 TUI(如 Kimi)能自愈,不重绘的(cursor-agent 的 Ink 在文本未变时不写、
 * PowerShell 的提示符)就一直留白。**与具体 agent 无关**,故治在 resize 层、不做 agent 分支。
 *
 * 对策:仅当「列数不变、行数变多」时,按非 ConPTY 语义做这一次 resize(让 xterm 把回滚区历史
 * 拉回视口填充)。列数不变即不会触发 reflow(xterm 的 reflow 首行就是 `cols 未变则返回`),
 * 因此不会重新引入叠影问题。
 */

export interface TermDims {
  cols: number;
  rows: number;
}

/**
 * 这次 resize 是否应按「非 ConPTY」语义执行(把回滚区历史拉回视口、而不是在底部追加空行)。
 *
 * @param current 当前 xterm 尺寸
 * @param proposed fit 计算出的目标尺寸(不可用时传 undefined)
 */
export function shouldPullScrollbackOnGrow(
  current: TermDims,
  proposed: TermDims | undefined,
): boolean {
  if (!proposed) return false;
  if (!Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return false;
  // 列数变化会牵动 reflow，交回默认路径处理，避免与 ConPTY 双重重排
  if (proposed.cols !== current.cols) return false;
  return proposed.rows > current.rows;
}
