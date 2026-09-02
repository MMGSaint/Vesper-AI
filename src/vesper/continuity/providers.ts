/**
 * Browser and desktop provider seams.
 *
 * These are contracts, not implementations. Every future action still goes through
 * the permission gate. Page, file, and screen content is untrusted_external unless
 * a person explicitly promotes it. Disabled means no I/O — not an empty capture.
 */

import type { ContinuityTrust } from "./types.ts";

export type ProviderKind = "inspect" | "extract" | "search" | "act" | "observe" | "interact";

export interface ProviderResult {
  ok: boolean;
  kind: ProviderKind;
  summary: string;
  trust: ContinuityTrust;
  openedDevice: false;
  executed: false;
}

const DISABLED: Omit<ProviderResult, "kind" | "summary"> = {
  ok: false,
  trust: "untrusted_external",
  openedDevice: false,
  executed: false,
};

export interface BrowserProvider {
  inspect(): Promise<ProviderResult>;
  currentPage(): Promise<ProviderResult>;
  extract(): Promise<ProviderResult>;
  search(_query: string): Promise<ProviderResult>;
  act(_action: string): Promise<ProviderResult>;
}

export interface DesktopProvider {
  inspect(): Promise<ProviderResult>;
  observe(): Promise<ProviderResult>;
  interact(_action: string): Promise<ProviderResult>;
  act(_action: string): Promise<ProviderResult>;
}

function disabled(kind: ProviderKind, surface: string): ProviderResult {
  return {
    ...DISABLED,
    kind,
    summary: `${surface} is disabled. No device was opened and nothing executed.`,
  };
}

export function createDisabledBrowserProvider(): BrowserProvider {
  return {
    inspect: async () => disabled("inspect", "Browser"),
    currentPage: async () => disabled("inspect", "Browser"),
    extract: async () => disabled("extract", "Browser"),
    search: async () => disabled("search", "Browser"),
    act: async () => disabled("act", "Browser"),
  };
}

export function createDisabledDesktopProvider(): DesktopProvider {
  return {
    inspect: async () => disabled("inspect", "Desktop"),
    observe: async () => disabled("observe", "Desktop"),
    interact: async () => disabled("interact", "Desktop"),
    act: async () => disabled("act", "Desktop"),
  };
}
