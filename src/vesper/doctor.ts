import { access, constants, mkdir } from "node:fs/promises";
import type { VesperDirs } from "./types.ts";
import type { VesperConfig } from "./config.ts";
import { VESPER_VERSION } from "./version.ts";
import { CLIENT_PROTOCOL_VERSION } from "./client/protocol.ts";

export interface DoctorCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  node: string;
  platform: string;
  checks: DoctorCheck[];
}

/**
 * How the `config` check names where the settings came from.
 *
 * Three distinct claims, deliberately worded so they cannot be confused:
 *   - `file`        — this exact file was read; what follows is what it says.
 *   - `default`     — no readable file; every value below is a built-in default.
 *   - `locked-down` — a file exists but could not be trusted, so authority was dropped.
 *
 * When the caller passes no source at all we say so rather than implying a file was
 * read, for the same reason `NOT_CONFIGURED` is not `UNAVAILABLE`.
 */
function configOrigin(
  source: string | undefined,
  path: string | undefined,
  name: string,
): string {
  const at = path ? ` at ${path}` : "";
  if (source === "file") return `Config read from ${path ?? "disk"} (${name})`;
  if (source === "default") {
    return (
      `No config file${at} — running on built-in defaults. ` +
      `Every setting below is a default, not something you set.`
    );
  }
  if (source === "locked-down") {
    return `Config${at} could not be trusted and was locked down; running with no approved roots.`;
  }
  return `Config parsed${at} (${name}); source not reported`;
}

async function writable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface DoctorModelStatus {
  /** The active role/provider id, or "auto" when no override is set. */
  active: string;
  /** As returned by `router.status().available`. Each provider that has been probed. */
  available: { id: string; kind: string; available: boolean }[];
  /** Configured role → { provider, model } — from `config.models.roles`. */
  roles: Record<string, { provider: string; model: string }>;
}

export async function runDoctor(input: {
  dirs: VesperDirs;
  config: VesperConfig;
  configOk: boolean;
  configErrors: string[];
  /**
   * Where the configuration actually came from, and the file that was consulted.
   *
   * Optional so the unit-test callers that only want the cheap filesystem checks keep
   * working, but the host always passes it: without it, `config: Config parsed` is the
   * same line whether Vesper read the user's file or never found one and reported its
   * own built-in defaults. See the `config` check below.
   */
  configSource?: "file" | "default" | "locked-down";
  configPath?: string;
  storageReadable: boolean;
  lastError?: string | null;
  /**
   * Optional. When present, doctor reports which model providers are reachable and what
   * the role→model mapping is. Absent for callers (some unit tests) that only want the
   * cheap filesystem/config checks.
   */
  models?: DoctorModelStatus;
  /**
   * Optional. When present, doctor reports the current readiness state and which
   * components are settled. Absent for a doctor run before start().
   */
  readiness?: {
    state: string;
    settled: boolean;
    summary: string;
    components: Array<{ id: string; state: string; detail: string; optional: boolean }>;
  };
  /**
   * Optional. When present, doctor reports whether the Windows Run key matches the
   * user's `windows.startOnLogin` preference. Absent when reg.exe was not consulted
   * (non-Windows host, or a doctor run that opted out).
   */
  startup?: {
    preferred: boolean;
    inSync: boolean;
    detail: string;
  };
}): Promise<DoctorReport> {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const checks: DoctorCheck[] = [
    {
      id: "node",
      ok: nodeMajor >= 22,
      detail: `Node ${process.versions.node} (need >= 22)`,
    },
    {
      // Name the FILE and the SOURCE, not just "parsed".
      //
      // "Config parsed (Vesper)" was printed identically whether Vesper had read the
      // user's file or had found no file at all and fallen back to built-in defaults —
      // and the role lines below then reported those defaults in the same shape as a
      // real setting. A user whose config lives on a path this process does not resolve
      // to therefore saw a green report describing a configuration they never wrote,
      // with nothing on screen to distinguish it from theirs.
      //
      // Vesper resolves its root differently depending on `VESPER_ENV` (see
      // paths.ts `resolveVesperDirs`), so two config files on one machine is a normal
      // state, not a corner case: `npm run doctor` reads a CWD-relative dev tree while
      // the packaged launcher sets VESPER_ENV=production and reads LOCALAPPDATA. Which
      // one answered is exactly the fact a diagnostic exists to report.
      //
      // `--config-check` already printed `Config OK (<source>) at <path>`. The doctor
      // being quieter than the narrower command was the bug.
      id: "config",
      ok: input.configOk,
      detail: input.configOk
        ? configOrigin(input.configSource, input.configPath, input.config.identity.name)
        : `Config invalid: ${input.configErrors.join("; ") || "unknown"}`,
    },
    {
      // `ok` is deliberately always true, and now says so instead of computing it.
      //
      // The expression here was `allowOptionalCloud === false || true`, which makes the
      // left operand dead: the check could never fail whatever the config said. That
      // reads as a computed check and is a constant, which is worse than a constant —
      // anyone auditing the doctor would count this as a cloud guarantee that is being
      // verified.
      //
      // Always-true is nevertheless the right answer, for the reason the detail gives:
      // enabling optional cloud in config does not make Vesper depend on it, and the
      // local-first guarantee is enforced by the router, not by this line. The truth
      // lives in `detail`, following the same convention the model checks use.
      id: "cloud-not-required",
      ok: true,
      detail: input.config.models.allowOptionalCloud
        ? "Optional cloud is enabled in config (still not required at runtime)"
        : "Optional cloud is disabled",
    },
    {
      id: "never-autonomous",
      ok: input.config.permissions.neverAllowAutonomous.length > 0,
      detail: `neverAllowAutonomous=${input.config.permissions.neverAllowAutonomous.join(",")}`,
    },
    {
      id: "data-dir",
      ok: await writable(input.dirs.data),
      detail: input.dirs.data,
    },
    {
      id: "logs-dir",
      ok: await writable(input.dirs.logs),
      detail: input.dirs.logs,
    },
    {
      id: "config-dir",
      ok: await writable(input.dirs.config),
      detail: input.dirs.config,
    },
    {
      id: "storage",
      ok: input.storageReadable,
      detail: input.storageReadable ? "Storage readable" : "Storage unreadable",
    },
    {
      id: "last-error",
      ok: !input.lastError,
      detail: input.lastError ? `Last recorded error: ${input.lastError}` : "No persisted last-error",
    },
    {
      // Not a failure — a simulated hardware source is the correct state on every
      // machine that is not the target PC. It is a check because "live" is settable and
      // does nothing, and a setting that silently does nothing is the kind of thing a
      // user only discovers by trusting a number that was never measured.
      id: "hardware-source",
      ok: true,
      detail:
        input.config.hardware.mode === "live"
          ? "hardware.mode is 'live' but no live source is implemented; readings are simulated."
          : `hardware.mode is '${input.config.hardware.mode}'; readings are simulated.`,
    },
    {
      id: "client-protocol",
      ok: true,
      detail:
        `vesper.client v${CLIENT_PROTOCOL_VERSION} is in-process only. Remote OS control is UNAVAILABLE. No companion network listener is bound.`,
    },
    ...readinessChecks(input.readiness),
    ...startupChecks(input.startup),
    ...modelChecks(input.models),
  ];
  return {
    ok: checks.every((check) => check.ok || check.id === "last-error"),
    version: VESPER_VERSION,
    node: process.versions.node,
    platform: process.platform,
    checks,
  };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [
    `Vesper doctor ${report.version} on ${report.platform} (node ${report.node})`,
    report.ok ? "Result: OK" : "Result: ATTENTION NEEDED",
    "",
  ];
  for (const check of report.checks) {
    lines.push(`${check.ok ? "ok" : "!!"}  ${check.id}: ${check.detail}`);
  }
  lines.push("");
  lines.push("This check does not claim Windows tray, AMD telemetry, microphone, or optimizer API validation.");
  return lines.join("\n");
}


/**
 * What the user actually wants to know about their setup: which of the configured
 * providers are reachable, and if none are, why Vesper is running as a command router
 * rather than an assistant. `available: false` for every local provider is not an
 * *error* — Vesper starts, permissions and tools work, memory persists — but it is the
 * single most important thing to say out loud when someone runs `vesper --doctor` and
 * wonders why their local model was not answering.
 */
function readinessChecks(
  readiness?: {
    state: string;
    settled: boolean;
    summary: string;
    components: Array<{ id: string; state: string; detail: string; optional: boolean }>;
  },
): DoctorCheck[] {
  if (!readiness) return [];
  // Readiness is a status surface, not a permission decision. This doctor check is
  // therefore always `ok: true` even when the state is DEGRADED — a settled degraded
  // runtime is the honest answer for a machine with no local backend, and marking it
  // as a doctor failure would push the process exit code to 1 for a state Vesper's
  // own honesty rules already say is expected.
  return [
    {
      id: "readiness",
      ok: readiness.settled || readiness.state === "CORE_READY",
      detail: `${readiness.state}: ${readiness.summary}`,
    },
  ];
}

function startupChecks(
  startup?: { preferred: boolean; inSync: boolean; detail: string },
): DoctorCheck[] {
  if (!startup) return [];
  // A startup registration that is out of sync with the config is a real problem —
  // Vesper will not come up at logon the way the user asked. Not fatal (the assistant
  // is still usable in this session), but the exit code should reflect it, so `ok`
  // tracks `inSync` honestly.
  return [
    {
      id: "startup-registration",
      ok: startup.inSync,
      detail: startup.detail,
    },
  ];
}


function modelChecks(status: DoctorModelStatus | undefined): DoctorCheck[] {
  if (!status) return [];
  const reachable = status.available.filter((entry) => entry.available);
  const localReachable = reachable.filter((entry) => entry.kind === "local");
  const others = status.available.filter((entry) => !entry.available);

  const summary: DoctorCheck = localReachable.length
    ? {
        id: "local-model",
        ok: true,
        detail: `Local inference backend(s) reachable: ${localReachable.map((entry) => entry.id).join(", ")}. ` +
          `Active router selection: ${status.active}.`,
      }
    : {
        // `ok: true` intentionally. Vesper works with no local model — deterministic
        // intents, tools, memory, notifications, and the security boundary all run —
        // and the doctor should not report a machine as broken because the user has not
        // started their model server. The detail line is what says what is missing.
        id: "local-model",
        ok: true,
        detail:
          "No local inference backend is reachable. Vesper starts and runs deterministic " +
          "intents, tools, memory, and the security boundary — but a natural-language " +
          "question that needs the model will get a fallback reply that says so. Start a " +
          "backend (for example, `ollama serve` and `ollama pull qwen2.5:14b`) and rerun " +
          "`--doctor`.",
      };

  const checks: DoctorCheck[] = [summary];

  // Show every unreachable provider once, with which URL was probed — the most common
  // reason a backend fails to answer is that it is listening on a different port.
  for (const entry of others) {
    const url = urlForProvider(entry.id, status);
    checks.push({
      id: `provider-${entry.id}`,
      ok: true, // unreachable is not an error — see above
      detail: url
        ? `Provider '${entry.id}' (${entry.kind}) did not answer at ${url}.`
        : `Provider '${entry.id}' (${entry.kind}) did not answer.`,
    });
  }

  // Roles that reference a provider that is not reachable — the mapping is honest,
  // but Vesper will fall back for that role.
  for (const [role, target] of Object.entries(status.roles)) {
    const provider = status.available.find((entry) => entry.id === target.provider);
    const ready = provider?.available === true;
    checks.push({
      id: `role-${role}`,
      ok: true,
      detail: ready
        ? `Role '${role}' → ${target.provider} / ${target.model} (reachable).`
        : `Role '${role}' → ${target.provider} / ${target.model} (provider not reachable; router will fall back).`,
    });
  }

  return checks;
}

/** Best-effort provider→endpoint mapping so the "did not answer" line names the port. */
function urlForProvider(providerId: string, status: DoctorModelStatus): string | null {
  // The role config carries what the user asked for, but the endpoint lives in the
  // full config, not in the status snapshot — so this returns null unless the caller
  // wants to extend the shape. The current shape keeps the doctor loose-coupled to
  // the router; adding endpoint would tighten it needlessly for a diagnostic line.
  void providerId;
  void status;
  return null;
}
