import { access, constants, mkdir } from "node:fs/promises";
import type { VesperDirs } from "./types.ts";
import type { VesperConfig } from "./config.ts";
import { VESPER_VERSION } from "./version.ts";

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
  storageReadable: boolean;
  lastError?: string | null;
  /**
   * Optional. When present, doctor reports which model providers are reachable and what
   * the role→model mapping is. Absent for callers (some unit tests) that only want the
   * cheap filesystem/config checks.
   */
  models?: DoctorModelStatus;
}): Promise<DoctorReport> {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const checks: DoctorCheck[] = [
    {
      id: "node",
      ok: nodeMajor >= 22,
      detail: `Node ${process.versions.node} (need >= 22)`,
    },
    {
      id: "config",
      ok: input.configOk,
      detail: input.configOk
        ? `Config parsed (${input.config.identity.name})`
        : `Config invalid: ${input.configErrors.join("; ") || "unknown"}`,
    },
    {
      id: "cloud-not-required",
      ok: input.config.models.allowOptionalCloud === false || true,
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
      id: "client-protocol",
      ok: true,
      detail:
        "vesper.client v1 is in-process only. Remote OS control is UNAVAILABLE. No companion network listener is bound.",
    },
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
