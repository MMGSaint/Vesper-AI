import type { SimulatedHardware } from "../hardware/simulated.ts";
import { isolateFailure, sleep } from "../recover.ts";
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

export function createMockOptimizer(hardware: SimulatedHardware): OptimizerAdapter {
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
      if (!available) return { accepted: false, summary: "I could not access the optimizer." };
      const next = input.profile ?? (hardware.getScenario() === "idle" ? "efficiency" : "performance");
      profile = next;
      lastAction = `request_optimization:${next}`;
      lastResult = `mock-applied:${next}`;
      return {
        accepted: true,
        summary: `I requested a mock optimization to profile '${next}'. The real optimizer was not contacted.`,
      };
    },
    async requestRollback() {
      if (!available) return { accepted: false, summary: "I could not access the optimizer." };
      profile = "balanced";
      lastAction = "request_rollback";
      lastResult = "mock-rolled-back:balanced";
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

export function createHttpOptimizerAdapter(
  endpoint: string,
  options: HttpOptimizerOptions = {},
): OptimizerAdapter {
  const timeoutMs = options.timeoutMs ?? 2500;
  const retries = Math.max(0, options.retries ?? 1);
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log;
  let lastError: string | null = null;
  let lastLatency: number | null = null;

  async function call(path: string, init?: RequestInit): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    const url = `${endpoint.replace(/\/$/, "")}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      });
      lastLatency = Date.now() - started;
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
      lastError = error instanceof Error ? error.message : String(error);
      return { ok: false, error: lastError };
    } finally {
      clearTimeout(timer);
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
      const parsed = parseStatus(result.data);
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
      const result = await call("/optimize", { method: "POST", body: JSON.stringify(input) });
      if (!result.ok) return { accepted: false, summary: `I could not access the optimizer: ${result.error}` };
      const parsed = parseAccepted(result.data);
      if (!parsed) {
        log?.warn("optimizer", "Optimizer did not confirm optimization", {});
        return { accepted: false, summary: "The optimizer did not confirm that an optimization happened." };
      }
      if (parsed.accepted !== true) {
        return { accepted: false, summary: parsed.summary || "The optimizer declined the request." };
      }
      return parsed;
    },
    async requestRollback() {
      const result = await call("/rollback", { method: "POST" });
      if (!result.ok) return { accepted: false, summary: `I could not access the optimizer: ${result.error}` };
      const parsed = parseAccepted(result.data);
      if (!parsed || parsed.accepted !== true) {
        return { accepted: false, summary: "The optimizer did not confirm that a rollback happened." };
      }
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

function parseStatus(value: unknown): OptimizerStatus | null {
  const obj = asObject(value);
  if (!obj || typeof obj.available !== "boolean") return null;
  const mode = obj.mode === "live" || obj.mode === "mock" || obj.mode === "unavailable" ? obj.mode : "unavailable";
  return {
    available: obj.available,
    mode,
    currentProfile: typeof obj.currentProfile === "string" ? obj.currentProfile : null,
    lastAction: typeof obj.lastAction === "string" ? obj.lastAction : null,
    lastResult: typeof obj.lastResult === "string" ? obj.lastResult : null,
    performanceState: typeof obj.performanceState === "string" ? obj.performanceState : null,
    detail: typeof obj.detail === "string" ? obj.detail : "Optimizer status.",
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
    notes: Array.isArray(obj.notes) ? obj.notes.filter((item): item is string => typeof item === "string") : [],
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
    notes: Array.isArray(obj.notes) ? obj.notes.filter((item): item is string => typeof item === "string") : [],
    summary: obj.summary,
  };
}

function parseAccepted(value: unknown): { accepted: boolean; summary: string } | null {
  const obj = asObject(value);
  if (!obj || typeof obj.accepted !== "boolean") return null;
  return {
    accepted: obj.accepted,
    summary: typeof obj.summary === "string" ? obj.summary : obj.accepted ? "Accepted." : "Declined.",
  };
}
