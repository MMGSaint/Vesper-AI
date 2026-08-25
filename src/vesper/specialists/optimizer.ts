import type { SimulatedHardware } from "../hardware/simulated.ts";
import type { HardwareSnapshot, OptimizerStatus, OptimizerTelemetry } from "../types.ts";

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
    setAvailable(value: boolean) {
      available = value;
    },
  };
}

export type MockOptimizer = ReturnType<typeof createMockOptimizer>;

export function createHttpOptimizerAdapter(endpoint: string): OptimizerAdapter {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${endpoint.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Optimizer HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    async getStatus() {
      try {
        return await call<OptimizerStatus>("/status");
      } catch (error) {
        return {
          available: false,
          mode: "unavailable",
          currentProfile: null,
          lastAction: null,
          lastResult: null,
          performanceState: null,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async getTelemetry() {
      return await call("/telemetry");
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
      return await call("/analyze", { method: "POST" });
    },
    async requestOptimization(input) {
      return await call("/optimize", { method: "POST", body: JSON.stringify(input) });
    },
    async requestRollback() {
      return await call("/rollback", { method: "POST" });
    },
    async getLastAction() {
      const status = await this.getStatus();
      return status.lastAction;
    },
    async getOptimizationResult() {
      const status = await this.getStatus();
      return status.lastResult;
    },
  };
}
