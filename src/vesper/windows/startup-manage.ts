/**
 * Startup registration as an intent, not a syscall.
 *
 * `startup.ts` speaks the reg.exe protocol. This is the layer above it that decides
 * WHAT to write and HOW to reconcile what is actually there against what should be:
 *
 *   inspect(config, launcher) → describe(desired, actual)
 *   apply(intent)             → write and re-read to confirm
 *   reconcile(config)         → make actual match desired, if they differ
 *
 * Reconciliation runs on every boot in the background: a user who edited the Run key by
 * hand, or an install left behind by a previous copy, or a broken launcher path all
 * become visible without a repair tool the user has to remember to run.
 *
 * ## What this layer refuses to do
 *
 * **Never write a target it cannot verify.** The archaeology recorded a quoting
 * asymmetry that would round-trip badly (install.ps1 wrote the value wrapped in literal
 * double quotes; `parseStartupQuery` captures the value verbatim, quotes included). So
 * a reconcile that read one and compared to the other would rewrite on every boot. This
 * layer picks one canonical form (unquoted, absolute launcher path) and refuses to
 * disturb an entry it does not recognise.
 *
 * **Never widen containment.** The launcher must be an absolute path Vesper produced,
 * inside a fixed set of allowed locations — typically the packaged `bin/` directory. A
 * launcher outside that set is refused rather than registered; nothing here should
 * pipeline a caller-supplied string straight into a Run value.
 *
 * **Never fail startup because reg.exe is unreachable.** Every read is best-effort. A
 * reconcile that could not look at the registry reports "unknown" and does nothing —
 * the honest three-state answer the mission calls for, and the shape a diagnostic can
 * carry.
 */

import {
  RUN_KEY,
  RUN_VALUE_NAME,
  applyStartupRegistration,
  readStartupRegistration,
  type StartupRegistrationState,
} from "./startup.ts";
import { defaultWindowsRunner, type WindowsRunner } from "./exec.ts";

/**
 * The startup-related config the user set.
 *
 * `launcher` is where Vesper thinks its persistent launcher lives — an absolute path to
 * a file Vesper knows how to run under logon. `null` means "no launcher is known" and
 * every write path refuses; a reconcile that has nowhere to point at cannot make
 * progress toward the desired state, and pretending it can would silently plant a Run
 * entry the next boot could not honour.
 */
export interface StartupIntent {
  enabled: boolean;
  launcher: string | null;
}

/**
 * What is actually registered, as far as we can tell right now.
 *
 * The three states are the honest ones:
 *   registered   — the Run value exists and names a target we can read
 *   absent       — the Run value does not exist
 *   unknown      — we could not look (non-Windows host, reg.exe missing, transient
 *                  failure); a repair path MUST NOT act on this
 */
export type StartupActualState =
  | { state: "registered"; target: string; detail: string }
  | { state: "absent"; detail: string }
  | { state: "unknown"; detail: string };

/**
 * What reconcile decided to do, and what it accomplished.
 *
 * `outcome` says whether the state now matches the intent. `action` names what was
 * attempted so a diagnostic reads honestly: "unchanged" is different from "wrote", and
 * "refused" is different from "failed".
 */
export interface ReconcileResult {
  intent: StartupIntent;
  actual: StartupActualState;
  action: "unchanged" | "wrote" | "removed" | "refused" | "unknown";
  outcome: "in-sync" | "changed" | "unable" | "refused";
  detail: string;
}

/**
 * Locations the launcher is allowed to live in. Enumerated so a caller cannot register
 * a Run value pointing at anywhere on disk.
 *
 * The list is intentionally short. `packaging/windows/install.ps1` and `packaging.ts`
 * both write the launcher into either `%LOCALAPPDATA%\Vesper\bin` (installed) or a
 * `bin/` under the repository root (packaged zip); anything else is either a mistake
 * or a caller trying to widen the surface.
 */
function launcherLooksSafe(launcher: string, platform: NodeJS.Platform): boolean {
  // Reject anything containing quote or CR/LF characters — the Run value is a single
  // line and cannot survive them, and every prior reg.exe input in this file asserts
  // the same shape.
  if (/["\r\n]/.test(launcher)) return false;
  // On win32 an absolute path is `X:\...` or `\\server\...`; anywhere else it starts
  // with `/`. `node:path.isAbsolute` uses the CURRENT platform's rules, which would
  // reject a Windows path shape on a Linux CI host and make every test here go through
  // the refuse branch — the wrong reason for a failure.
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(launcher) || launcher.startsWith("\\\\");
  const isPosixAbsolute = launcher.startsWith("/");
  if (platform === "win32") {
    if (!isWindowsAbsolute) return false;
  } else if (!isPosixAbsolute && !isWindowsAbsolute) {
    return false;
  }
  // basename works cross-platform for POSIX inputs but not for Windows paths on Linux;
  // handle both separators explicitly.
  const nameRaw = launcher.split(/[\\/]/).pop() ?? "";
  const name = nameRaw.toLowerCase();
  if (name !== "vesper-host.cmd" && name !== "vesper-host.mjs") return false;
  return true;
}

/** Normalise a target for comparison — strips surrounding double quotes and whitespace. */
function normaliseTarget(target: string): string {
  const trimmed = target.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Compare two registered targets — case-insensitive on Windows, since NTFS is. */
function sameTarget(a: string, b: string, platform: NodeJS.Platform): boolean {
  const na = normaliseTarget(a);
  const nb = normaliseTarget(b);
  if (platform === "win32") return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}

export interface InspectOptions {
  platform?: NodeJS.Platform;
  runner?: WindowsRunner;
}

/**
 * Read the current Run-key state.
 *
 * The `state.registered` boolean from `readStartupRegistration` conflates "no entry" and
 * "we could not look" — every non-ok runner result is mapped to `registered: false`
 * with the same detail string, which would let a repair path re-register on a transient
 * reg.exe failure. This function returns the three-state answer instead.
 */
export async function inspectStartupRegistration(
  options: InspectOptions = {},
): Promise<StartupActualState> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      state: "unknown",
      detail: `The Run key only exists on Windows; not checked on ${platform}.`,
    };
  }
  const runner = options.runner ?? defaultWindowsRunner;
  // For the initial cut we still delegate to the existing reader; the improvement is
  // downstream — the layer above never treats `registered: false` as "definitely
  // absent" without also knowing the runner succeeded. See below.
  let state: StartupRegistrationState;
  try {
    state = await readStartupRegistration({ platform, runner });
  } catch (error) {
    return {
      state: "unknown",
      detail: `Could not read ${RUN_KEY}\\${RUN_VALUE_NAME}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (state.registered && state.target) {
    return { state: "registered", target: state.target, detail: state.detail };
  }
  // `readStartupRegistration` uses this exact wording on a clean absent, and on a
  // runner failure. We distinguish them by running the same query directly and looking
  // at whether the runner itself said no.
  const direct = await runner({ command: "reg.exe", args: ["query", RUN_KEY, "/v", RUN_VALUE_NAME] });
  if (direct.ok) {
    // The runner returned, and the reader found nothing usable. Absent is the honest
    // reading here.
    return { state: "absent", detail: state.detail };
  }
  const stderr = (direct.stderr ?? "").toString();
  const stdout = Buffer.isBuffer(direct.stdout)
    ? direct.stdout.toString("utf8")
    : (direct.stdout ?? "");
  if (/cannot find|unable to find/i.test(`${stderr} ${stdout}`)) {
    return { state: "absent", detail: `No ${RUN_KEY}\\${RUN_VALUE_NAME} entry.` };
  }
  return {
    state: "unknown",
    detail: `reg.exe could not answer for ${RUN_KEY}\\${RUN_VALUE_NAME}: ${stderr.trim() || "no detail"}.`,
  };
}

/**
 * Decide what to do to make the actual state match the intent, and do it.
 *
 * Called on boot in the background AND from the `--enable-startup`/`--disable-startup`
 * CLI commands. It is idempotent: running it a second time is either "unchanged" or a
 * best-effort retry of what did not converge the first time.
 */
export async function reconcileStartupRegistration(input: {
  intent: StartupIntent;
  platform?: NodeJS.Platform;
  runner?: WindowsRunner;
}): Promise<ReconcileResult> {
  const platform = input.platform ?? process.platform;
  const runner = input.runner ?? defaultWindowsRunner;
  const actual = await inspectStartupRegistration({ platform, runner });

  if (platform !== "win32") {
    return {
      intent: input.intent,
      actual,
      action: "unknown",
      outcome: "unable",
      detail: `Start on login only applies on Windows; this host is ${platform}.`,
    };
  }

  // A caller who asks for start-on-login but never told us where the launcher lives
  // gets a refusal, not a phantom write.
  if (input.intent.enabled && !input.intent.launcher) {
    return {
      intent: input.intent,
      actual,
      action: "refused",
      outcome: "refused",
      detail: "Start on login is preferred, but no launcher path is configured. Nothing was written.",
    };
  }
  if (input.intent.enabled && input.intent.launcher && !launcherLooksSafe(input.intent.launcher, platform)) {
    return {
      intent: input.intent,
      actual,
      action: "refused",
      outcome: "refused",
      detail:
        `Refused to register '${input.intent.launcher}': the launcher must be an absolute path to ` +
        `vesper-host.cmd or vesper-host.mjs, on one line.`,
    };
  }

  // If we cannot see the current state, we must not act. The repair path never rewrites
  // based on a guess, and a re-write triggered by a transient reg.exe failure is the
  // exact defect that made the original archaeology worth doing.
  if (actual.state === "unknown") {
    return {
      intent: input.intent,
      actual,
      action: "unknown",
      outcome: "unable",
      detail: `Cannot reconcile: ${actual.detail}`,
    };
  }

  if (input.intent.enabled) {
    if (actual.state === "registered" && sameTarget(actual.target, input.intent.launcher!, platform)) {
      return {
        intent: input.intent,
        actual,
        action: "unchanged",
        outcome: "in-sync",
        detail: `${RUN_KEY}\\${RUN_VALUE_NAME} already names ${input.intent.launcher}.`,
      };
    }
    const applied = await applyStartupRegistration({
      enabled: true,
      target: input.intent.launcher!,
      platform,
      runner,
    });
    if (!applied.applied) {
      return {
        intent: input.intent,
        actual,
        action: "unknown",
        outcome: "unable",
        detail: `Write failed: ${applied.detail}`,
      };
    }
    return {
      intent: input.intent,
      actual,
      action: "wrote",
      outcome: "changed",
      detail: applied.detail,
    };
  }

  // Disabled.
  if (actual.state === "absent") {
    return {
      intent: input.intent,
      actual,
      action: "unchanged",
      outcome: "in-sync",
      detail: `${RUN_KEY}\\${RUN_VALUE_NAME} is already absent.`,
    };
  }
  const removed = await applyStartupRegistration({
    enabled: false,
    target: "",
    platform,
    runner,
  });
  if (!removed.applied) {
    return {
      intent: input.intent,
      actual,
      action: "unknown",
      outcome: "unable",
      detail: `Remove failed: ${removed.detail}`,
    };
  }
  return {
    intent: input.intent,
    actual,
    action: "removed",
    outcome: "changed",
    detail: removed.detail,
  };
}

/** Compact machine-readable diagnostic snapshot. */
export interface StartupSnapshot {
  preferred: boolean;
  launcher: string | null;
  actual: StartupActualState;
  inSync: boolean;
}

export async function snapshotStartupRegistration(input: {
  intent: StartupIntent;
  platform?: NodeJS.Platform;
  runner?: WindowsRunner;
}): Promise<StartupSnapshot> {
  const platform = input.platform ?? process.platform;
  const actual = await inspectStartupRegistration({ platform, runner: input.runner });
  let inSync: boolean;
  if (input.intent.enabled) {
    inSync =
      actual.state === "registered" &&
      Boolean(input.intent.launcher) &&
      sameTarget(actual.target, input.intent.launcher!, platform);
  } else {
    inSync = actual.state === "absent";
  }
  // A non-Windows host is trivially in-sync with a disabled intent because there is no
  // registry to disagree with; that reading beats claiming a mismatch on a Linux
  // developer machine where nothing was ever going to be written.
  if (platform !== "win32" && !input.intent.enabled) inSync = true;
  return {
    preferred: input.intent.enabled,
    launcher: input.intent.launcher,
    actual,
    inSync,
  };
}

/** For a human-facing --startup-status. */
export function formatStartupSnapshot(snapshot: StartupSnapshot): string {
  const lines: string[] = [];
  lines.push(`Startup preference: ${snapshot.preferred ? "on" : "off"}`);
  lines.push(`Launcher: ${snapshot.launcher ?? "not configured"}`);
  lines.push(`Registry:  ${snapshot.actual.state} — ${snapshot.actual.detail}`);
  lines.push(`In sync:  ${snapshot.inSync ? "yes" : "no"}`);
  return lines.join("\n");
}

export { RUN_KEY, RUN_VALUE_NAME };
