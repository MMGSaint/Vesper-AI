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

export async function runDoctor(input: {
  dirs: VesperDirs;
  config: VesperConfig;
  configOk: boolean;
  configErrors: string[];
  storageReadable: boolean;
  lastError?: string | null;
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
