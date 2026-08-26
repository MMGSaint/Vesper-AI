/**
 * Windows toast notifications.
 *
 * The toast text comes from the model and from tool callers, so it is never
 * interpolated into the PowerShell command line. The script below is a constant; the
 * title and body travel as JSON on stdin and are inserted into the toast XML through
 * `CreateTextNode`, which escapes them, so neither a shell metacharacter nor a `<tag>`
 * can change what runs.
 */

import type { VesperNotification } from "../types.ts";
import {
  decodeStdout,
  defaultWindowsRunner,
  failureSummary,
  type WindowsCommand,
  type WindowsRunner,
} from "./exec.ts";

/**
 * A toast is shown on behalf of an AppUserModelID that has a Start Menu shortcut.
 * Windows PowerShell's own shortcut ships with the OS, so this default works without
 * installing anything; an install that wants "Vesper" in the Action Center should
 * register its own AUMID and pass it in.
 */
export const DEFAULT_TOAST_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "[void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$text = $template.GetElementsByTagName('text')",
  "[void]$text.Item(0).AppendChild($template.CreateTextNode($payload.title))",
  "[void]$text.Item(1).AppendChild($template.CreateTextNode($payload.body))",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($template)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($payload.appId).Show($toast)",
].join("\n");

export interface HostNotificationAdapter {
  kind: "windows-toast" | "simulated" | "disabled";
  available: boolean;
  notify(
    title: string,
    body: string,
    kind?: VesperNotification["kind"],
  ): Promise<{ ok: boolean; summary: string }>;
}

export function buildToastCommand(input: {
  title: string;
  body: string;
  appId?: string;
}): WindowsCommand {
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", TOAST_SCRIPT],
    stdin: JSON.stringify({
      title: input.title,
      body: input.body,
      appId: input.appId ?? DEFAULT_TOAST_APP_ID,
    }),
    timeoutMs: 15_000,
  };
}

export function createHostNotificationAdapter(input?: {
  platform?: NodeJS.Platform;
  enabled?: boolean;
  appId?: string;
  runner?: WindowsRunner;
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
    const runner = input?.runner ?? defaultWindowsRunner;
    return {
      kind: "windows-toast",
      available: true,
      async notify(title, body) {
        const command = buildToastCommand({ title, body, appId: input?.appId });
        const result = await runner(command);
        if (!result.ok) {
          return { ok: false, summary: failureSummary(result, "Windows toast") };
        }
        const noise = `${decodeStdout(result)}${result.stderr}`.trim();
        return {
          ok: true,
          summary: noise
            ? `Windows toast sent: ${title}. PowerShell said: ${noise.split(/\r?\n/)[0]}`
            : `Windows toast sent: ${title}.`,
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
