/**
 * NEXUS IPC optimizer adapter.
 *
 * Speaks the real NEXUS Vesper contract: Windows named pipe or POSIX unix domain
 * socket, newline-delimited JSON, no TCP. See NEXUS `docs/vesper-interface.md` and
 * `src/vesper/contract.ts`.
 *
 * Vesper adapts TO NEXUS — this file never asks NEXUS to grow a network listener.
 *
 * Mode honesty: when this adapter is selected, Vesper's provenance label is `live`
 * (a real IPC client is talking to a configured specialist). NEXUS fidelity
 * (`live` / `mocked` / `simulated` / …) is reported in summaries and never allowed to
 * redefine Vesper's own `mode` field.
 */

import { createConnection, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";

import { sanitiseInline } from "../untrusted.ts";
import type { Logger } from "../logging.ts";
import type {
  HardwareSnapshot,
  JsonObject,
  OptimizerHealth,
  OptimizerStatus,
  OptimizerTelemetry,
} from "../types.ts";
import type { OptimizerAdapter } from "./optimizer.ts";

/** Contract major we speak. Must match NEXUS `VESPER_CONTRACT_VERSION` major. */
export const NEXUS_CONTRACT_VERSION = "1.0.0";

export const NEXUS_TOKEN_FILENAME = "vesper-token";
export const NEXUS_SOCK_FILENAME = "vesper.sock";

/** Join path segments for a target platform without using the host OS rules. */
function joinForPlatform(platform: NodeJS.Platform, ...parts: string[]): string {
  if (platform === "win32") {
    const cleaned = parts.map((p, i) =>
      i === 0 ? p.replace(/[/\\]+$/g, "") : p.replace(/^[/\\]+|[/\\]+$/g, ""),
    );
    return cleaned.join("\\");
  }
  return join(...parts);
}

function resolveHome(home: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    // Do not run POSIX path.resolve on a Windows path — it would mangle the drive letter.
    return home.replace(/[/\\]+$/g, "") || home;
  }
  return resolve(home);
}


export type NexusFidelity = "live" | "simulated" | "mocked" | "unverified" | "unavailable";

export interface NexusIpcSuccess {
  readonly v: string;
  readonly id: string;
  readonly ok: true;
  readonly fidelity: NexusFidelity;
  readonly result: unknown;
}

export interface NexusIpcFailure {
  readonly v: string;
  readonly id: string;
  readonly ok: false;
  readonly fidelity: NexusFidelity;
  readonly error: { readonly code: string; readonly message: string };
}

export type NexusIpcResponse = NexusIpcSuccess | NexusIpcFailure;

export type NexusIpcCallResult =
  | {
      readonly ok: true;
      readonly fidelity: NexusFidelity;
      readonly result: unknown;
      readonly latencyMs: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code?: string;
      readonly fidelity?: NexusFidelity;
      readonly latencyMs: number;
    };

export interface NexusIpcClientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly contractVersion?: string;
  /** Injected for tests. */
  readonly connectImpl?: typeof createConnection;
}

const MAX_LINE_BYTES = 64 * 1024;

function safeText(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const clean = sanitiseInline(value, max);
  return clean.length > 0 ? clean : null;
}

function safeTextOr(value: unknown, fallback: string, max = 240): string {
  return safeText(value, max) ?? fallback;
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function requestId(): string {
  return `vesper-${randomBytes(8).toString("hex")}`;
}

/**
 * One NDJSON request over a path-based socket. Connects, sends, waits for the matching
 * `id`, then closes. Failure modes (timeout, malformed JSON, connect error) become
 * honest `{ ok: false }` results — never throws into the assistant path.
 */
export function createNexusIpcClient(options: NexusIpcClientOptions): {
  call(method: string, params?: Record<string, unknown>): Promise<NexusIpcCallResult>;
} {
  const timeoutMs = options.timeoutMs ?? 2500;
  const version = options.contractVersion ?? NEXUS_CONTRACT_VERSION;
  const connect = options.connectImpl ?? createConnection;
  // Token is held in closure; never placed in log fields by this module.
  const token = options.token;
  const endpoint = options.endpoint;

  return {
    async call(method, params): Promise<NexusIpcCallResult> {
      const id = requestId();
      const started = Date.now();
      const body: Record<string, unknown> = {
        v: version,
        id,
        method,
        token,
      };
      if (params !== undefined) body.params = params;

      return await new Promise<NexusIpcCallResult>((resolvePromise) => {
        let settled = false;
        let buffer = "";
        let socket: Socket | null = null;

        const finish = (result: NexusIpcCallResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            socket?.destroy();
          } catch {
            /* ignore */
          }
          resolvePromise(result);
        };

        const timer = setTimeout(() => {
          finish({
            ok: false,
            error: `NEXUS did not answer within ${timeoutMs}ms.`,
            code: "E_TIMEOUT",
            latencyMs: Date.now() - started,
          });
        }, timeoutMs);

        try {
          socket = connect({ path: endpoint });
        } catch (error) {
          finish({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            code: "E_CONNECT",
            latencyMs: Date.now() - started,
          });
          return;
        }

        socket.setEncoding("utf8");
        socket.setTimeout(timeoutMs);

        socket.once("connect", () => {
          try {
            socket?.write(`${JSON.stringify(body)}\n`);
          } catch (error) {
            finish({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              code: "E_IO",
              latencyMs: Date.now() - started,
            });
          }
        });

        socket.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.length > MAX_LINE_BYTES) {
            finish({
              ok: false,
              error: "NEXUS response exceeded the size limit.",
              code: "E_INVALID_INPUT",
              latencyMs: Date.now() - started,
            });
            return;
          }
          let index = buffer.indexOf("\n");
          while (index >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (line.trim() !== "") {
              let parsed: unknown;
              try {
                parsed = JSON.parse(line);
              } catch {
                finish({
                  ok: false,
                  error: "Malformed NEXUS JSON.",
                  code: "E_INVALID_INPUT",
                  latencyMs: Date.now() - started,
                });
                return;
              }
              const obj = asObject(parsed);
              if (!obj || typeof obj.id !== "string") {
                finish({
                  ok: false,
                  error: "Malformed NEXUS response envelope.",
                  code: "E_INVALID_INPUT",
                  latencyMs: Date.now() - started,
                });
                return;
              }
              if (obj.id !== id) {
                // Not ours — keep waiting (should not happen on a fresh connection).
                index = buffer.indexOf("\n");
                continue;
              }
              if (obj.ok === true) {
                const fidelity = parseFidelity(obj.fidelity) ?? "unverified";
                finish({
                  ok: true,
                  fidelity,
                  result: obj.result,
                  latencyMs: Date.now() - started,
                });
                return;
              }
              if (obj.ok === false) {
                const errObj = asObject(obj.error);
                const code = typeof errObj?.code === "string" ? errObj.code : "E_UNKNOWN";
                const message =
                  safeText(errObj?.message, 400) ?? "NEXUS refused the request.";
                finish({
                  ok: false,
                  error: message,
                  code,
                  fidelity: parseFidelity(obj.fidelity) ?? "unavailable",
                  latencyMs: Date.now() - started,
                });
                return;
              }
              finish({
                ok: false,
                error: "Malformed NEXUS response envelope.",
                code: "E_INVALID_INPUT",
                latencyMs: Date.now() - started,
              });
              return;
            }
            index = buffer.indexOf("\n");
          }
        });

        socket.on("error", (error) => {
          finish({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            code: "E_IO",
            latencyMs: Date.now() - started,
          });
        });

        socket.on("timeout", () => {
          finish({
            ok: false,
            error: `NEXUS did not answer within ${timeoutMs}ms.`,
            code: "E_TIMEOUT",
            latencyMs: Date.now() - started,
          });
        });

        socket.on("close", () => {
          if (!settled) {
            finish({
              ok: false,
              error: "NEXUS closed the connection before answering.",
              code: "E_IO",
              latencyMs: Date.now() - started,
            });
          }
        });
      });
    },
  };
}

function parseFidelity(value: unknown): NexusFidelity | null {
  if (
    value === "live" ||
    value === "simulated" ||
    value === "mocked" ||
    value === "unverified" ||
    value === "unavailable"
  ) {
    return value;
  }
  return null;
}

/* ------------------------------------------------------------------ paths */

export interface NexusIpcEndpointResolution {
  readonly endpoint: string;
  readonly tokenPath: string;
  readonly transport: "unix-socket" | "named-pipe";
}

/**
 * Resolve a local IPC endpoint from config. Rejects anything that looks like a
 * network host — NEXUS never binds TCP, and Vesper must not invent a remote path.
 */
export function resolveNexusIpcEndpoint(input: {
  socketPath?: string | null;
  pipeName?: string | null;
  home?: string | null;
  tokenPath?: string | null;
  platform?: NodeJS.Platform;
}): { ok: true; value: NexusIpcEndpointResolution } | { ok: false; reason: string } {
  const platform = input.platform ?? process.platform;
  const home = input.home?.trim() || null;
  const socketPath = input.socketPath?.trim() || null;
  const pipeName = input.pipeName?.trim() || null;
  const tokenOverride = input.tokenPath?.trim() || null;

  if (home && !isSafeLocalPath(home)) {
    return { ok: false, reason: "optimizer.home must be an absolute local filesystem path." };
  }
  if (socketPath && !isSafeLocalPath(socketPath)) {
    return { ok: false, reason: "optimizer.socketPath must be an absolute local filesystem path." };
  }
  if (tokenOverride && !isSafeLocalPath(tokenOverride)) {
    return { ok: false, reason: "optimizer.tokenPath must be an absolute local filesystem path." };
  }
  if (pipeName && !isSafePipeName(pipeName)) {
    return {
      ok: false,
      reason: 'optimizer.pipeName must be a local Windows pipe of the form \\\\.\\pipe\\nexus-…',
    };
  }

  if (platform === "win32") {
    if (pipeName) {
      return {
        ok: true,
        value: {
          endpoint: pipeName,
          tokenPath:
            tokenOverride ??
            (home ? joinForPlatform("win32", resolveHome(home, "win32"), "runtime", NEXUS_TOKEN_FILENAME) : ""),
          transport: "named-pipe",
        },
      };
    }
    if (home) {
      const root = resolveHome(home, "win32");
      return {
        ok: true,
        value: {
          endpoint: `\\\\.\\pipe\\nexus-${endpointDiscriminator(root, "win32")}`,
          tokenPath: tokenOverride ?? joinForPlatform("win32", root, "runtime", NEXUS_TOKEN_FILENAME),
          transport: "named-pipe",
        },
      };
    }
    return {
      ok: false,
      reason: "NEXUS IPC on Windows requires optimizer.pipeName or optimizer.home.",
    };
  }

  // POSIX
  if (socketPath) {
    const endpoint = resolve(socketPath);
    const tokenPath =
      tokenOverride ??
      (home
        ? join(resolve(home), "runtime", NEXUS_TOKEN_FILENAME)
        : join(dirname(endpoint), NEXUS_TOKEN_FILENAME));
    return {
      ok: true,
      value: { endpoint, tokenPath, transport: "unix-socket" },
    };
  }
  if (home) {
    const root = resolve(home);
    return {
      ok: true,
      value: {
        endpoint: join(root, "runtime", NEXUS_SOCK_FILENAME),
        tokenPath: tokenOverride ?? join(root, "runtime", NEXUS_TOKEN_FILENAME),
        transport: "unix-socket",
      },
    };
  }
  return {
    ok: false,
    reason: "NEXUS IPC requires optimizer.socketPath or optimizer.home.",
  };
}

/** Absolute path, no host:port shape, no UNC remote share, no empty segments. */
export function isSafeLocalPath(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  // Refuse anything that looks like host:port or a URL.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(trimmed)) return false;
  if (/^localhost:\d+$/i.test(trimmed)) return false;
  // Remote UNC (\\host\share) — local pipes use \\.\pipe\ and are handled separately.
  if (trimmed.startsWith("\\\\") && !trimmed.toLowerCase().startsWith("\\\\.\\pipe\\")) {
    return false;
  }
  // Accept POSIX and Windows absolute forms regardless of the host OS — config may
  // be authored for the target PC while Vesper is developed elsewhere.
  const absolute =
    isAbsolute(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("\\\\.\\pipe\\");
  if (!absolute) return false;
  return true;
}

export function isSafePipeName(raw: string): boolean {
  // Local named pipe only. Remote \\host\pipe\… is refused.
  return /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(raw);
}

/** Same FNV-1a discriminator NEXUS uses so `home` alone addresses the right pipe. */
export function endpointDiscriminator(home: string, platform: NodeJS.Platform = process.platform): string {
  let h = 0x811c9dc5;
  const normalized = platform === "win32" ? home.toLowerCase() : home;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export async function readNexusToken(tokenPath: string): Promise<
  { ok: true; token: string } | { ok: false; error: string }
> {
  if (!tokenPath) {
    return { ok: false, error: "NEXUS token path is not configured." };
  }
  try {
    const raw = await readFile(tokenPath, "utf8");
    const token = raw.trim();
    if (token.length < 32) {
      return { ok: false, error: "NEXUS token file is too short to be valid." };
    }
    return { ok: true, token };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, error: `NEXUS token file not found at ${tokenPath}.` };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* --------------------------------------------------------------- adapter */

export interface NexusIpcOptimizerOptions {
  readonly endpoint: string;
  readonly tokenPath: string;
  readonly timeoutMs?: number;
  readonly log?: Logger;
  /** Preloaded token (tests). When set, the file is not read. */
  readonly token?: string;
  /** Injected client factory for tests. */
  readonly clientFactory?: (token: string) => {
    call(method: string, params?: Record<string, unknown>): Promise<NexusIpcCallResult>;
  };
}

const emptyHardware = (): HardwareSnapshot => ({
  mode: "unavailable",
  os: "unknown",
  cpu: { name: "unknown", cores: 0, threads: 0, utilizationPct: 0, tempC: null },
  gpu: null,
  ram: { totalGB: 0, usedGB: 0 },
  notes: ["NEXUS telemetry summary does not include a full hardware snapshot."],
  capturedAt: new Date().toISOString(),
});

const unavailableStatus = (detail: string): OptimizerStatus => ({
  available: false,
  mode: "unavailable",
  currentProfile: null,
  lastAction: null,
  lastResult: null,
  performanceState: null,
  detail,
});

function createRefusedNexusOptimizer(reason: string, log?: Logger): OptimizerAdapter {
  const refuse = (action: string, data: JsonObject = {}) => {
    log?.error("optimizer", "Refused a NEXUS IPC request: endpoint is not allowed", {
      action,
      reason,
      ...data,
    });
    return { accepted: false, summary: `I did not contact NEXUS: ${reason}` };
  };
  return {
    async getStatus() {
      return unavailableStatus(reason);
    },
    async getTelemetry() {
      return { available: false, hardware: emptyHardware(), bound: "unknown", notes: [reason] };
    },
    async getCurrentProfile() {
      return null;
    },
    async getPerformanceState() {
      return null;
    },
    async analyze() {
      return { bound: "unknown", notes: [reason], summary: "I could not access NEXUS." };
    },
    async requestOptimization(input) {
      return refuse("request_optimization", {
        profile: input.profile ?? null,
        reason: input.reason ?? null,
      });
    },
    async requestRollback() {
      return refuse("request_rollback");
    },
    async getLastAction() {
      return null;
    },
    async getOptimizationResult() {
      return null;
    },
    async getHealth() {
      return { reachable: false, latencyMs: null, lastError: reason, mode: "unavailable" };
    },
  };
}

function workloadToBound(workload: unknown): OptimizerTelemetry["bound"] {
  if (workload === "cpu_bound" || workload === "development") return "cpu";
  if (
    workload === "gpu_bound" ||
    workload === "gaming" ||
    workload === "streaming" ||
    workload === "ai_inference"
  ) {
    return "gpu";
  }
  if (workload === "idle") return "idle";
  return "unknown";
}

function isNonLiveFidelity(fidelity: NexusFidelity): boolean {
  return fidelity === "mocked" || fidelity === "simulated";
}

function appliedStatus(status: unknown): boolean {
  return (
    status === "applied_kept" ||
    status === "applied_rolled_back" ||
    status === "applied_unverified"
  );
}

/**
 * Live IPC adapter for NEXUS. Vesper's `mode` is always `live` when reachable —
 * that is the provenance of *this adapter*, not a claim NEXUS is allowed to redefine.
 */
export function createNexusIpcOptimizerAdapter(
  options: NexusIpcOptimizerOptions,
): OptimizerAdapter {
  const log = options.log;
  const timeoutMs = options.timeoutMs ?? 2500;

  if (!options.endpoint || (!options.token && !options.tokenPath)) {
    return createRefusedNexusOptimizer("NEXUS IPC endpoint or token path is missing.", log);
  }
  // Endpoint must be a path (or local pipe), never a URL / host:port.
  const looksLikePipe = isSafePipeName(options.endpoint);
  const looksLikePath = isSafeLocalPath(options.endpoint);
  if (!looksLikePipe && !looksLikePath) {
    log?.error("optimizer", "Refused NEXUS IPC endpoint", { endpointKind: "invalid" });
    return createRefusedNexusOptimizer(
      "NEXUS IPC endpoint must be a local socket path or \\\\.\\pipe\\… name.",
      log,
    );
  }

  let lastError: string | null = null;
  let lastLatency: number | null = null;
  let lastAction: string | null = null;
  let lastResult: string | null = null;
  let lastCheckpointId: string | null = null;
  let lastOutcomeId: string | null = null;
  let cachedToken: string | null = options.token ?? null;

  async function ensureToken(): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
    if (cachedToken) return { ok: true, token: cachedToken };
    const loaded = await readNexusToken(options.tokenPath);
    if (!loaded.ok) return loaded;
    cachedToken = loaded.token;
    return loaded;
  }

  function clientFor(token: string) {
    if (options.clientFactory) return options.clientFactory(token);
    return createNexusIpcClient({
      endpoint: options.endpoint,
      token,
      timeoutMs,
    });
  }

  async function invoke(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<NexusIpcCallResult> {
    const tokenResult = await ensureToken();
    if (!tokenResult.ok) {
      lastError = tokenResult.error;
      return { ok: false, error: tokenResult.error, code: "E_AUTH", latencyMs: 0 };
    }
    const result = await clientFor(tokenResult.token).call(method, params);
    lastLatency = result.latencyMs;
    if (!result.ok) {
      lastError = result.error;
      // Auth failure: drop cached token so the next call re-reads the file.
      if (result.code === "E_AUTH") cachedToken = options.token ?? null;
    } else {
      lastError = null;
    }
    return result;
  }

  return {
    async getStatus() {
      const statusCall = await invoke("getStatus");
      if (!statusCall.ok) return unavailableStatus(statusCall.error);

      const profileCall = await invoke("getCurrentProfile");
      let currentProfile: string | null = null;
      if (profileCall.ok) {
        const profileObj = asObject(profileCall.result);
        const profile = asObject(profileObj?.profile);
        currentProfile =
          safeText(profile?.id, 60) ??
          safeText(profile?.name, 60) ??
          safeText(asObject(statusCall.result)?.activeProfileId, 60);
      } else {
        currentProfile = safeText(asObject(statusCall.result)?.activeProfileId, 60);
      }

      const health = asObject(statusCall.result);
      const runState = typeof health?.runState === "string" ? health.runState : null;
      const available = runState !== "stopped" && runState !== "failed";
      const fidelityNote =
        statusCall.fidelity !== "live" ? ` NEXUS fidelity: ${statusCall.fidelity}.` : "";
      const detail = safeTextOr(
        health?.recoverySummary ??
          (available
            ? `Connected to NEXUS over IPC (${runState ?? "ready"}).${fidelityNote}`
            : `NEXUS reported runState=${runState ?? "unknown"}.${fidelityNote}`),
        available ? "Connected to NEXUS over IPC." : "NEXUS is not ready.",
      );

      // mode is Vesper's provenance for this adapter — always live when we reached it.
      return {
        available,
        mode: available ? "live" : "unavailable",
        reportedMode: null,
        currentProfile,
        lastAction,
        lastResult,
        performanceState: null,
        detail,
      };
    },

    async getTelemetry() {
      const result = await invoke("getTelemetrySummary", { windowMs: 60_000 });
      if (!result.ok) {
        return {
          available: false,
          hardware: emptyHardware(),
          bound: "unknown",
          notes: [result.error],
        };
      }
      const summary = asObject(result.result);
      const metrics = Array.isArray(summary?.metrics) ? summary.metrics : [];
      let cpu: number | null = null;
      let gpu: number | null = null;
      const notes: string[] = [
        `NEXUS telemetry fidelity: ${result.fidelity}.`,
        `Samples: ${typeof summary?.sampleCount === "number" ? summary.sampleCount : 0}.`,
      ];
      for (const entry of metrics) {
        const m = asObject(entry);
        if (!m || typeof m.metric !== "string") continue;
        const last = typeof m.last === "number" ? m.last : typeof m.mean === "number" ? m.mean : null;
        if (m.metric.includes("cpu") && m.metric.includes("util") && last !== null) cpu = last;
        if (m.metric.includes("gpu") && m.metric.includes("util") && last !== null) gpu = last;
        const label = safeText(m.metric, 80);
        if (label && last !== null) notes.push(`${label}=${last}`);
      }
      let bound: OptimizerTelemetry["bound"] = "unknown";
      if (cpu !== null && gpu !== null) {
        if (gpu >= 85 && gpu >= cpu) bound = "gpu";
        else if (cpu >= 85) bound = "cpu";
        else if (cpu < 15 && gpu < 15) bound = "idle";
      } else if (cpu !== null && cpu >= 85) bound = "cpu";
      else if (gpu !== null && gpu >= 85) bound = "gpu";

      return {
        available: true,
        hardware: emptyHardware(),
        bound,
        notes: notes.map((n) => safeText(n) ?? "").filter((n) => n.length > 0),
      };
    },

    async getCurrentProfile() {
      const result = await invoke("getCurrentProfile");
      if (!result.ok) return null;
      const profile = asObject(asObject(result.result)?.profile);
      return safeText(profile?.id, 60) ?? safeText(profile?.name, 60);
    },

    async getPerformanceState() {
      const result = await invoke("analyzeWorkload");
      if (!result.ok) return null;
      const classification = asObject(result.result);
      return workloadToBound(classification?.workload);
    },

    async analyze() {
      const result = await invoke("analyzeWorkload");
      if (!result.ok) {
        return { bound: "unknown", notes: [result.error], summary: "I could not access NEXUS." };
      }
      const classification = asObject(result.result);
      const bound = workloadToBound(classification?.workload);
      const explanation = safeText(classification?.explanation, 400) ?? "NEXUS returned a workload classification.";
      const missing = Array.isArray(classification?.missingSignals)
        ? classification.missingSignals
            .filter((s): s is string => typeof s === "string")
            .map((s) => safeText(s, 80) ?? "")
            .filter((s) => s.length > 0)
        : [];
      const notes = [
        `workload=${safeText(classification?.workload, 40) ?? "unknown"}`,
        `confidence=${typeof classification?.confidence === "number" ? classification.confidence : "?"}`,
        `fidelity=${result.fidelity}`,
        ...missing.map((s) => `missing:${s}`),
      ];
      if (classification?.contextConflict === true) {
        notes.push("NEXUS reported a context conflict with a declared hint.");
      }
      const fidelityCaveat = isNonLiveFidelity(result.fidelity)
        ? ` This classification is ${result.fidelity}, not a live measurement claim from Vesper.`
        : "";
      return {
        bound,
        notes,
        summary: `${explanation}${fidelityCaveat}`,
      };
    },

    async requestOptimization(input) {
      log?.info("optimizer", "Optimizer state change requested", {
        action: "request_optimization",
        mode: "live",
        transport: "ipc",
        profile: input.profile ?? null,
        reason: input.reason ?? null,
      });
      const params: Record<string, unknown> = {};
      if (input.profile) params.profileId = input.profile;
      const result = await invoke("optimize", params);
      if (!result.ok) {
        log?.warn("optimizer", "Optimizer state change failed", {
          action: "request_optimization",
          mode: "live",
          transport: "ipc",
          error: result.error,
          code: result.code ?? null,
        });
        return { accepted: false, summary: `I could not reach NEXUS: ${result.error}` };
      }

      const outcome = asObject(result.result);
      if (!outcome || typeof outcome.status !== "string") {
        log?.warn("optimizer", "Optimizer did not confirm optimization", {
          action: "request_optimization",
          mode: "live",
          transport: "ipc",
        });
        return {
          accepted: false,
          summary: "NEXUS did not return a usable optimization outcome.",
        };
      }

      const fidelity = result.fidelity;
      const status = outcome.status;
      const summaryText = safeTextOr(outcome.summary, `NEXUS status=${status}.`);
      const outcomeId = safeText(outcome.id, 64);
      const checkpointId = safeText(outcome.checkpointId, 64);
      if (outcomeId) lastOutcomeId = outcomeId;
      if (checkpointId) lastCheckpointId = checkpointId;
      lastAction = `request_optimization:${input.profile ?? "default"}`;

      if (status === "no_action" || status === "rejected" || status === "failed" || status === "requires_confirmation") {
        lastResult = `nexus:${status}:${fidelity}`;
        log?.info("optimizer", "Optimizer declined the request", {
          action: "request_optimization",
          mode: "live",
          transport: "ipc",
          status,
          fidelity,
          summary: summaryText,
        });
        return {
          accepted: false,
          summary: summaryText,
        };
      }

      if (!appliedStatus(status)) {
        lastResult = `nexus:${status}:${fidelity}`;
        return {
          accepted: false,
          summary: summaryText || "NEXUS did not confirm that an optimization happened.",
        };
      }

      // Fidelity lattice: mocked/simulated must never be narrated as live hardware change.
      const machineStateChanged = fidelity === "live";
      lastResult = `nexus:${status}:${fidelity}`;
      const fidelitySummary = isNonLiveFidelity(fidelity)
        ? ` NEXUS reported fidelity=${fidelity}; this is not a live hardware change.`
        : fidelity === "unverified"
          ? " NEXUS reported fidelity=unverified."
          : "";

      log?.info("optimizer", "Optimizer confirmed an optimization", {
        action: "request_optimization",
        mode: "live",
        transport: "ipc",
        profile: input.profile ?? null,
        status,
        fidelity,
        machineStateChanged,
        summary: summaryText,
      });

      return {
        accepted: true,
        summary: `${summaryText}${fidelitySummary}`,
      };
    },

    async requestRollback() {
      log?.info("optimizer", "Optimizer state change requested", {
        action: "request_rollback",
        mode: "live",
        transport: "ipc",
      });
      if (!lastCheckpointId) {
        const msg = "No NEXUS checkpoint is recorded yet; rollback needs a checkpointId from a prior optimize.";
        log?.warn("optimizer", "Optimizer state change failed", {
          action: "request_rollback",
          mode: "live",
          transport: "ipc",
          error: msg,
        });
        return { accepted: false, summary: msg };
      }
      const result = await invoke("rollback", { checkpointId: lastCheckpointId });
      if (!result.ok) {
        log?.warn("optimizer", "Optimizer state change failed", {
          action: "request_rollback",
          mode: "live",
          transport: "ipc",
          error: result.error,
        });
        return { accepted: false, summary: `I could not reach NEXUS: ${result.error}` };
      }
      const restored = asObject(result.result);
      const complete = restored?.complete === true;
      const fidelity = result.fidelity;
      lastAction = "request_rollback";
      lastResult = `nexus:rollback:${complete ? "complete" : "incomplete"}:${fidelity}`;
      if (!complete) {
        log?.warn("optimizer", "Optimizer did not confirm rollback", {
          action: "request_rollback",
          mode: "live",
          transport: "ipc",
          fidelity,
        });
        return {
          accepted: false,
          summary: safeTextOr(
            restored && "summary" in restored ? restored.summary : null,
            "NEXUS did not confirm a complete rollback.",
          ),
        };
      }
      const machineStateChanged = fidelity === "live";
      const fidelitySummary = isNonLiveFidelity(fidelity)
        ? ` NEXUS reported fidelity=${fidelity}; this is not a live hardware change.`
        : "";
      log?.info("optimizer", "Optimizer confirmed a rollback", {
        action: "request_rollback",
        mode: "live",
        transport: "ipc",
        fidelity,
        machineStateChanged,
      });
      return {
        accepted: true,
        summary: `NEXUS restored checkpoint ${lastCheckpointId}.${fidelitySummary}`,
      };
    },

    async getLastAction() {
      return lastAction;
    },

    async getOptimizationResult() {
      if (lastOutcomeId) {
        const result = await invoke("getOptimizationResult", { outcomeId: lastOutcomeId });
        if (result.ok) {
          const outcome = asObject(result.result);
          const status = safeText(outcome?.status, 40);
          const summary = safeText(outcome?.summary, 200);
          const text = [status, summary, `fidelity=${result.fidelity}`].filter(Boolean).join(": ");
          lastResult = text || lastResult;
          return lastResult;
        }
      }
      return lastResult;
    },

    async getHealth(): Promise<OptimizerHealth> {
      const started = Date.now();
      const status = await this.getStatus();
      return {
        reachable: status.available,
        latencyMs: lastLatency ?? Date.now() - started,
        lastError: status.available ? null : status.detail,
        mode: status.mode,
      };
    },
  };
}

/**
 * Whether config selects the NEXUS IPC adapter (as opposed to HTTP or mock).
 */
export function isNexusIpcConfigured(optimizer: {
  mode: string;
  transport?: string | null;
  socketPath?: string | null;
  pipeName?: string | null;
  home?: string | null;
  endpoint?: string | null;
}): boolean {
  if (optimizer.mode !== "live") return false;
  if (optimizer.transport === "ipc") return true;
  if (optimizer.transport === "http") return false;
  // Auto: path-based config wins over HTTP endpoint.
  return Boolean(optimizer.socketPath || optimizer.pipeName || optimizer.home);
}
