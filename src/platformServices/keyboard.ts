import { platformCapabilities } from "./runtime";
import { terminalTextInputData, type TerminalTextInput } from "./keyboardCore";

export function hasPrimaryShortcutModifier(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">,
): boolean {
  return platformCapabilities().primaryShortcutUsesMeta ? event.metaKey : event.ctrlKey;
}

export function primaryShortcutUsesMeta(): boolean {
  return platformCapabilities().primaryShortcutUsesMeta;
}

export function macosTerminalTextInputData(
  event: TerminalTextInput,
): string | undefined {
  return terminalTextInputData(platformCapabilities().kind, event);
}
