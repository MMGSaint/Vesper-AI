import type { VesperNotification } from "../types.ts";

export interface HostNotificationAdapter {
  kind: "windows-toast" | "simulated" | "disabled";
  available: boolean;
  notify(title: string, body: string, kind?: VesperNotification["kind"]): Promise<{ ok: boolean; summary: string }>;
}

export function createHostNotificationAdapter(input?: {
  platform?: NodeJS.Platform;
  enabled?: boolean;
}): HostNotificationAdapter {
  const enabled = input?.enabled ?? true;
  const platform = input?.platform ?? process.platform;
  if (!enabled) {
    return {
      kind: "disabled",
      available: false,
      async notify() {
        return { ok: false, summary: "Notifications are disabled." };
      },
    };
  }
  if (platform === "win32") {
    return {
      kind: "windows-toast",
      available: false,
      async notify(title, body) {
        return {
          ok: false,
          summary: `Windows toast requested (${title}: ${body.slice(0, 80)}). Native toasts are hardware-dependent and were not sent from this host.`,
        };
      },
    };
  }
  return {
    kind: "simulated",
    available: true,
    async notify(title, body) {
      return { ok: true, summary: `Simulated notification: ${title} — ${body}` };
    },
  };
}
