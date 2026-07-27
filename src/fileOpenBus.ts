// 「在当前窗口打开另一个文件」的通道。
// md 预览里的相对链接被点击时，DockEditor 需要打开目标文件——但它在主窗与内容预览窗口里
// 各有一套宿主：主窗要走 dockBus（会按预览窗是否开着做分流），预览窗要在本窗开 Tab。
// DockEditor 只认这个通道，两侧各自注册，互不依赖，也避免预览窗被迫 import 主窗的窗口状态机。
const openers = new Map<string, (path: string) => void>();

/** 注册某作用域（工作区 id）的"打开文件"实现。返回注销函数。 */
export function registerFileOpener(scope: string, fn: (path: string) => void): () => void {
  openers.set(scope, fn);
  return () => {
    if (openers.get(scope) === fn) openers.delete(scope);
  };
}

/** 在指定作用域内打开文件；无注册者时静默忽略（该窗口没有可承载的宿主）。 */
export function openFileInScope(scope: string, path: string): void {
  openers.get(scope)?.(path);
}

// 「本面板被激活 → 请宿主揭示该文件」的通道。主窗由 TerminalDock 注册（转给左栏文件树定位），
// 内容预览窗口没有左栏、不注册 → 天然 no-op。DockEditor 因此不必 import 主窗的 dockBus。
const revealers = new Map<string, (path: string) => void>();

export function registerFileRevealer(scope: string, fn: (path: string) => void): () => void {
  revealers.set(scope, fn);
  return () => {
    if (revealers.get(scope) === fn) revealers.delete(scope);
  };
}

export function revealFileInScope(scope: string, path: string): void {
  revealers.get(scope)?.(path);
}
