import { invoke } from "@tauri-apps/api/core";

export type PlatformKind = "macos" | "windows" | "unix";

export interface PlatformCapabilities {
  kind: PlatformKind;
  primaryShortcutUsesMeta: boolean;
}

const browserFallback = (): PlatformCapabilities => {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  const kind: PlatformKind = platform.includes("mac")
    ? "macos"
    : userAgent.includes("windows")
      ? "windows"
      : "unix";
  return { kind, primaryShortcutUsesMeta: kind === "macos" };
};

let capabilities: PlatformCapabilities = browserFallback();

export async function initPlatformServices(): Promise<void> {
  try {
    capabilities = await invoke<PlatformCapabilities>("platform_capabilities");
  } catch {
    capabilities = browserFallback();
  }
}

export function platformCapabilities(): PlatformCapabilities {
  return capabilities;
}

export function isWindowsPlatform(): boolean {
  return capabilities.kind === "windows";
}
