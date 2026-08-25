import type { BackgroundHealth, TrayMenuItem } from "../types.ts";
import { createTrayMenu } from "./runtime.ts";

export interface NativeTrayAdapter {
  available: boolean;
  applied: boolean;
  platform: string;
  menu(health: BackgroundHealth): TrayMenuItem[];
  attach(health: BackgroundHealth): { ok: boolean; summary: string };
}

export function createNativeTrayAdapter(input?: {
  platform?: NodeJS.Platform;
  enableTray?: boolean;
}): NativeTrayAdapter {
  const platform = input?.platform ?? process.platform;
  const enabled = input?.enableTray ?? true;
  const available = enabled && platform === "win32";
  return {
    available,
    applied: false,
    platform,
    menu: (health) => createTrayMenu(health),
    attach(health) {
      const items = createTrayMenu(health);
      if (!enabled) {
        return { ok: false, summary: "Tray is disabled in configuration." };
      }
      if (!available) {
        return {
          ok: true,
          summary: `Tray menu is defined (${items.length} items) but native Windows tray attach is hardware-dependent and was not applied on ${platform}.`,
        };
      }
      return {
        ok: true,
        summary:
          "Native tray attach is implemented as an interface. Physical Shell_NotifyIcon validation still requires the target Windows PC.",
      };
    },
  };
}
