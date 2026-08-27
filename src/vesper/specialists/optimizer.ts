import type { SimulatedHardware } from "../hardware/simulated.ts";
import { isolateFailure, sleep } from "../recover.ts";
import { isRedirect, linkAbort, NO_REDIRECT } from "../models/http.ts";
import { checkLocalEndpoint } from "../net.ts";
import { sanitiseInline } from "../untrusted.ts";
import type { Logger } from "../logging.ts";
import type {
  HardwareSnapshot,
  JsonObject,
  OptimizerHealth,
  OptimizerStatus,
  OptimizerTelemetry,
} from "../types.ts";

export interface OptimizerAdapter {
  getStatus(): Promise<OptimizerStatus>;
  getTelemetry(): Promise<OptimizerTelemetry>;
  getCurrentProfile(): Promise<string | null>;
  getPerformanceState(): Promise<string | null>;
  analyze(): Promise<{ bound: OptimizerTelemetry["bound"]; notes: string[]; summary: string }>;
  requestOptimization(input: { profile?: string; reason?: string }): Promise<{
    accepted: boolean;
    summary: string;
  }>;
  requestRollback(): Promise<{ accepted: boolean; summary: string }>;
  getLastAction(): Promise<string | null>;
  getOptimizationResult(): Promise<string | null>;
  getHealth(): Promise<OptimizerHealth>;
  setAvailable?(value: boolean): void;
}

export function createMockOptimizer(hardware: SimulatedHardware, log?: Logger): OptimizerAdapter {
  let profile = "balanced";
  let lastAction: string | null = null;
  let lastResult: string | null = null;
  let available = true;

  function boundFromSnapshot(snapshot: HardwareSnapshot): OptimizerTelemetry["bound"] {
    const gpu = snapshot.gpu?.utilizationPct ?? 0;
    const cpu = snapshot.cpu.utilizationPct;
    if (gpu >= 85 && gpu >= cpu) return "gpu";
    if (cpu >= 85) return "cpu";
    if (cpu < 15 && gpu < 15) return "idle";
    return "unknown";
  }

  return {
    async getStatus() {
      if (!available) {
        return {
          available: false,
          mode: "unavailable",
          currentProfile: null,
          lastAction,
          lastResult,
          performanceState: null,
          detail: "Optimizer adapter is unavailable.",
        };
      }
      const snapshot = hardware.snapshot();
      return {
        available: true,
        mode: "mock",
        currentProfile: profile,
        lastAction,
        lastResult,
        performanceState: boundFromSnapshot(snapshot),
        detail:
          "Mock optimizer adapter. The real PC optimizer API is not connected. No live optimization was performed.",
      };
    },
    async getTelemetry() {
      const hardwareSnap = hardware.snapshot();
      return {
        available,
        hardware: hardwareSnap,
        bound: boundFromSnapshot(hardwareSnap),
        notes: hardwareSnap.notes,
      };
    },
    async getCurrentProfile() {
      return available ? profile : null;
    },
    async getPerformanceState() {
      if (!available) return null;
      return boundFromSnapshot(hardware.snapshot());
    },
    async analyze() {
      if (!available) {
        return {
          bound: "unknown",
          notes: ["Optimizer unavailable."],
          summary: "I could not access the optimizer.",
        };
      }
      const snapshot = hardware.snapshot();
      const bound = boundFromSnapshot(snapshot);
      const notes = [
        `Simulated CPU ${snapshot.cpu.utilizationPct}% / ${snapshot.cpu.tempC ?? "?"}°C`,
        snapshot.gpu
          ? `Simulated GPU ${snapshot.gpu.utilizationPct}% / ${snapshot.gpu.tempC ?? "?"}°C`
          : "No GPU snapshot",
        `Bound: ${bound}`,
        "Analysis is from the mock adapter, not the real optimizer.",
      ];
      return {
        bound,
        notes,
        summary: `Mock analysis: workload appears ${bound}-bound on the simulated snapshot.`,
      };
    },
    async requestOptimization(input) {
      log?.info("optimizer", "Optimizer state change requested", {
        action: "request_optimization",
        mode: "mock",
        profile: input.profile ?? null,
        reason: input.reason ?? null,
      });
      if (!available) {
        log?.warn("optimizer", "Optimizer state change failed", {
          action: "request_optimization",
          mode: "mock",
          error: "Optimizer adapter is unavailable.",
        });
        return { accepted: false, summary: "I could not access the optimizer." };
      }
      const next = input.profile ?? (hardware.getScenario() === "idle" ? "efficiency" : "performance");
      profile = next;
      lastAction = `request_optimization:${next}`;
      lastResult = `mock-applied:${next}`;
      log?.info("optimizer", "Mock optimizer recorded a simulated profile change", {
        action: "request_optimization",
        mode: "mock",
        profile: next,
        machineStateChanged: false,
      });
      return {
        accepted: true,
        summary: `I requested a mock optimization to profile '${next}'. The real optimizer was not contacted.`,
      };
    },
    async requestRollback() {
      log?.info("optimizer", "Optimizer state change requested", {
        action: "request_rollback",
        mode: "mock",
      });
      if (!available) {
        log?.warn("optimizer", "Optimizer state change failed", {
          action: "request_rollback",
          mode: "mock",
          error: "Optimizer adapter is unavailable.",
        });
        return { accepted: false, summary: "I could not access the optimizer." };
      }
      profile = "balanced";
      lastAction = "request_rollback";
      lastResult = "mock-rolled-back:balanced";
      log?.info("optimizer", "Mock optimizer recorded a simulated rollback", {
        action: "request_rollback",
        mode: "mock",
        profile: "balanced",
        machineStateChanged: false,
      });
      return {
        accepted: true,
        summary: "I requested a mock rollback to 'balanced'. The real optimizer was not contacted.",
      };
    },
    async getLastAction() {
      return lastAction;
    },
    async getOptimizationResult() {
      return lastResult;
    },
    async getHealth() {
      return {
        reachable: available,
        latencyMs: available ? 0 : null,
        lastError: available ? null : "Optimizer adapter is unavailable.",
        mode: available ? "mock" : "unavailable",
      };
    },
    setAvailable(value: boolean) {
      available = value;
    },
  };
}

export type MockOptimizer = ReturnType<typeof createMockOptimizer>;

export interface HttpOptimizerOptions {
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  log?: Logger;
  /**
   * Explicit opt-in for an optimizer endpoint that is neither loopback nor private.
   * Off by default, and it can never unlock a link-local or metadata address.
   */
  allowRemoteEndpoint?: boolean;
}

const unavailableStatus = (detail: string): OptimizerStatus => ({
  available: false,
  mode: "unavailable",
  currentProfile: null,
  lastAction: null,
  lastResult: null,
  performanceState: null,
  detail,
});

const emptyHardware = (): HardwareSnapshot => ({
  mode: "unavailable",
  os: "unknown",
  cpu: { name: "unknown", cores: 0, threads: 0, utilizationPct: 0, tempC: null },
  gpu: null,
  ram: { totalGB: 0, usedGB: 0 },
  notes: ["Optimizer telemetry was unavailable."],
  capturedAt: new Date().toISOString(),
});

/**
 * An adapter for an endpoint Vesper refused to talk to.
 *
 * Returning this rather than throwing keeps the refusal on the same path as every other
 * optimizer failure: the assistant degrades and says why, instead of the host dying at
 * construction because a config file named a bad host.
 */
function createRefusedOptimizer(reason: string, log?: Logger): OptimizerAdapter {
  const refuse = (action: string, data: JsonObject = {}) => {
    log?.error("optimizer", "Refused an optimizer request: endpoint is not allowed", {
      action,
      reason,
      ...data,
    });
    return { accepted: false, summary: `I did not contact the optimizer: ${reason}` };
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
      return { bound: "unknown", notes: [reason], summary: "I could not access the optimizer." };
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

export function createHttpOptimizerAdapter(
  endpoint: string,
  options: HttpOptimizerOptions = {},
): OptimizerAdapter {
  const timeoutMs = options.timeoutMs ?? 2500;
  const retries = Math.max(0, options.retries ?? 1);
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log;

  // The endpoint is config, and config is attacker-influenced input. An optimizer that is
  // not on this machine (or, opted in, this LAN) is not this user's optimizer, and a
  // link-local address is an SSRF target rather than a service. Checked once, here, so no
  // request is ever issued to a host that failed the check.
  const endpointCheck = checkLocalEndpoint(endpoint, {
    allowRemote: options.allowRemoteEndpoint,
    label: "optimizer.endpoint",
  });
  if (!endpointCheck.ok) {
    log?.error("optimizer", "Refused optimizer endpoint", {
      reason: endpointCheck.reason,
      scope: endpointCheck.scope,
      host: endpointCheck.host,
    });
    return createRefusedOptimizer(endpointCheck.reason, log);
  }
  const origin = new URL(endpoint).origin;

  let lastError: string | null = null;
  let lastLatency: number | null = null;

  async function call(path: string, init?: RequestInit): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    const url = `${endpoint.replace(/\/$/, "")}${path}`;
    // Cheap invariant: the request must still be aimed at the host that passed validation.
    if (new URL(url).origin !== origin) {
      lastError = "Optimizer request would leave the validated endpoint.";
      log?.error("optimizer", lastError, { path });
      return { ok: false, error: lastError };
    }
    const abort = linkAbort(undefined, timeoutMs);
    const started = Date.now();
    try {
      const res = await fetchImpl(url, {
        ...init,
        // A local optimizer has no reason to redirect. Following one would re-issue the
        // request - body included - against a host that never passed the check above.
        ...NO_REDIRECT,
        signal: abort.signal,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      });
      lastLatency = Date.now() - started;
      if (isRedirect(res.status)) {
        lastError = `Optimizer tried to redirect (HTTP ${res.status}); refused.`;
        log?.warn("optimizer", lastError, { path, location: res.headers.get("location") ?? null });
        return { ok: false, error: lastError };
      }
      if (!res.ok) {
        lastError = `Optimizer HTTP ${res.status}`;
        return { ok: false, error: lastError };
      }
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        lastError = "Malformed optimizer JSON.";
        log?.warn("optimizer", lastError, { path });
        return { ok: false, error: lastError };
      }
      lastError = null;
      return { ok: true, data };
    } catch (error) {
      lastLatency = Date.now() - started;
      lastError = abort.timedOut()
        ? `Optimizer did not answer within ${timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : String(error);
      return { ok: false, error: lastError };
    } finally {
      abort.release();
    }
  }

  async function callGet(path: string) {
    let result = await call(path);
    for (let attempt = 0; attempt < retries && !result.ok; attempt += 1) {
      await sleep(40);
      result = await call(path);
    }
    return result;
  }

  return {
    async getStatus() {
      const result = await callGet("/status");
      if (!result.ok) return unavailableStatus(result.error);
      // "live" is what this adapter *is*: it was constructed because the configuration
      // named a live endpoint, and it is issuing real HTTP requests to it.
      const parsed = parseStatus(result.data, "live");
      if (!parsed) {
        log?.warn("optimizer", "Malformed optimizer status", {});
        return unavailableStatus("Malformed optimizer status response.");
      }
      return parsed;
    },
    async getTelemetry() {
      const result = await isolateFailure(
        async () => callGet("/telemetry"),
        { ok: false as const, error: "Optimizer telemetry failed." },
      );
      if (!result.ok) {
        return { available: false, hardware: emptyHardware(), bound: "unknown", notes: [result.error] };
      }
      const parsed = parseTelemetry(result.data);
      if (!parsed) {
        return {
          available: false,
          hardware: emptyHardware(),
          bound: "unknown",
          notes: ["Malformed optimizer telemetry."],
        };
      }
      return parsed;
    },
    async getCurrentProfile() {
      const status = await this.getStatus();
      return status.currentProfile;
    },
    async getPerformanceState() {
      const status = await this.getStatus();
      return status.performanceState;
    },
    async analyze() {
      const result = await call("/analyze", { method: "POST" });
      if (!result.ok) {
        return { bound: "unknown", notes: [result.error], summary: "I could not access the optimizer." };
      }
      const parsed = parseAnalysis(result.data);
      if (!parsed) {
        return {
          bound: "unknown",
          notes: ["Malformed optimizer analysis."],
          summary: "The optimizer response was malformed. No analysis was applied.",
        };
      }
      return parsed;
    },
    async requestOptimization(input) {
      // Anything that can change machine state leaves a trail: what was asked, with
      // which parameters, and what actually came back - including the failures.
      log?.info("optimizer", "Optimizer state change requested", {
        action: "request_optimization",
        mode: "live",
        origin,
        profile: input.profile ?? null,
        reason: input.reason ?? null,
      });
      const result = await call("/optimize", { method: "POST", body: JSON.stringify(input) });
      if (!result.ok) {
        log?.warn("optimizer", "Optimizer state change failed", {
          action: "request_optimization",
          mode: "live",
          origin,
          error: result.error,
        });
        return { accepted: false, summary: `I could not access the optimizer: ${result.error}` };
      }
      const parsed = parseAccepted(result.data);
      if (!parsed) {
        log?.warn("optimizer", "Optimizer did not confirm optimization", {
          action: "request_optimization",
          mode: "live",
          origin,
        });
        return { accepted: false, summary: "The optimizer did not confirm that an optimization happened." };
      }
      if (parsed.accepted !== true) {
        log?.info("optimizer", "Optimizer declined the request", {
          action: "request_optimization",
          mode: "live",
          origin,
          summary: parsed.summary || null,
        });
        return { accepted: false, summary: parsed.summary || "The optimizer declined the request." };
      }
      log?.info("optimizer", "Optimizer confirmed an optimization", {
        action: "request_optimization",
        mode: "live",
        origin,
        profile: input.profile ?? null,
        summary: parsed.summary || null,
      });
      return parsed;
    },
    async requestRollback() {
      log?.info("optimizer", "Optimizer state change requested", {
        action: "request_rollback",
        mode: "live",
        origin,
      });
      const result = await call("/rollback", { method: "POST" });
      if (!result.ok) {
        log?.warn("optimizer", "Optimizer state change failed", {
          action: "request_rollback",
          mode: "live",
          origin,
          error: result.error,
        });
        return { accepted: false, summary: `I could not access the optimizer: ${result.error}` };
      }
      const parsed = parseAccepted(result.data);
      if (!parsed || parsed.accepted !== true) {
        log?.warn("optimizer", "Optimizer did not confirm rollback", {
          action: "request_rollback",
          mode: "live",
          origin,
        });
        return { accepted: false, summary: "The optimizer did not confirm that a rollback happened." };
      }
      log?.info("optimizer", "Optimizer confirmed a rollback", {
        action: "request_rollback",
        mode: "live",
        origin,
        summary: parsed.summary || null,
      });
      return parsed;
    },
    async getLastAction() {
      const status = await this.getStatus();
      return status.lastAction;
    },
    async getOptimizationResult() {
      const status = await this.getStatus();
      return status.lastResult;
    },
    async getHealth() {
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

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

/**
 * Every string the optimizer sends, made safe to repeat.
 *
 * Sanitised here, at the boundary where the response is parsed, rather than at each
 * place a reply is composed. The system-prompt and tool-result routes were already
 * screened, but every *deterministic* reply path — the status composer, the analysis
 * summary, the confirmation text — read these fields straight out of the parsed status
 * and concatenated them into what Vesper says in its own voice. Patching those one at a
 * time would leave the next one to be written unprotected; sanitising on the way in
 * means a consumer cannot forget.
 *
 * The optimizer is a separate subsystem reached over HTTP. Its text is data.
 */
function safeText(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const clean = sanitiseInline(value, max);
  return clean.length > 0 ? clean : null;
}

/** The same, where the caller has a sensible default and the field is not nullable. */
function safeTextOr(value: unknown, fallback: string, max = 240): string {
  return safeText(value, max) ?? fallback;
}

/**
 * Read a status body. `mode` is deliberately **not** taken from it.
 *
 * `mode` is Vesper's own provenance label for which adapter is in use — the LIVE /
 * SIMULATED / MOCKED distinction the product promises the user — and Vesper knows the
 * answer locally: `config.optimizer.mode === "live" && endpoint` is what selected the
 * HTTP adapter in the first place. It was being taken from the response body, so an
 * endpoint could answer `mode: "mock"`, and `detail: "No live optimization was
 * performed"`, while `POST /optimize` was genuinely issued to it. Vesper's status, its
 * health report, and its own honesty classification in diagnostics all repeated the
 * claim.
 *
 * That is a subsystem's assertion being accepted as attestation about Vesper itself. The
 * caller supplies the mode; the endpoint's own claim is kept as `reportedMode` for the
 * one place it is worth showing — a disagreement between the two is worth surfacing —
 * and no honesty label reads it.
 */
function parseStatus(value: unknown, mode: OptimizerStatus["mode"]): OptimizerStatus | null {
  const obj = asObject(value);
  if (!obj || typeof obj.available !== "boolean") return null;
  const reportedMode =
    obj.mode === "live" || obj.mode === "mock" || obj.mode === "unavailable" ? obj.mode : null;
  return {
    available: obj.available,
    mode: obj.available ? mode : "unavailable",
    reportedMode,
    currentProfile: safeText(obj.currentProfile, 60),
    lastAction: safeText(obj.lastAction, 120),
    lastResult: safeText(obj.lastResult, 120),
    performanceState: safeText(obj.performanceState, 60),
    detail: safeTextOr(obj.detail, "Optimizer status."),
  };
}

function parseTelemetry(value: unknown): OptimizerTelemetry | null {
  const obj = asObject(value);
  if (!obj || typeof obj.available !== "boolean") return null;
  const bound =
    obj.bound === "cpu" || obj.bound === "gpu" || obj.bound === "io" || obj.bound === "idle" || obj.bound === "unknown"
      ? obj.bound
      : "unknown";
  return {
    available: obj.available,
    hardware: emptyHardware(),
    bound,
    notes: Array.isArray(obj.notes)
      ? obj.notes
          .filter((item): item is string => typeof item === "string")
          .map((note) => safeText(note) ?? "")
          .filter((note) => note.length > 0)
      : [],
  };
}

function parseAnalysis(value: unknown): { bound: OptimizerTelemetry["bound"]; notes: string[]; summary: string } | null {
  const obj = asObject(value);
  if (!obj) return null;
  const bound =
    obj.bound === "cpu" || obj.bound === "gpu" || obj.bound === "io" || obj.bound === "idle" || obj.bound === "unknown"
      ? obj.bound
      : "unknown";
  if (typeof obj.summary !== "string") return null;
  return {
    bound,
    notes: Array.isArray(obj.notes)
      ? obj.notes
          .filter((item): item is string => typeof item === "string")
          .map((note) => safeText(note) ?? "")
          .filter((note) => note.length > 0)
      : [],
    summary: safeText(obj.summary) ?? "",
  };
}

function parseAccepted(value: unknown): { accepted: boolean; summary: string } | null {
  const obj = asObject(value);
  if (!obj || typeof obj.accepted !== "boolean") return null;
  return {
    accepted: obj.accepted,
    summary: safeTextOr(obj.summary, obj.accepted ? "Accepted." : "Declined."),
  };
}
