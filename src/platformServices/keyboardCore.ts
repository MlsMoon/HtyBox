import type { PlatformKind } from "./runtime";

export interface TerminalTextInput {
  inputType: string;
  data: string | null;
  isComposing: boolean;
}

/** WebKit 在 macOS 上提交 Shift+/ 时由应用接管一次，避开 xterm 的 keyCode 229 延迟路径。 */
export function terminalTextInputData(
  platform: PlatformKind,
  event: TerminalTextInput,
): string | undefined {
  if (
    platform !== "macos" ||
    event.inputType !== "insertText" ||
    event.isComposing ||
    event.data !== "?"
  ) {
    return undefined;
  }
  return event.data;
}
