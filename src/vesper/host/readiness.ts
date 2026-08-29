/**
 * Runtime readiness states.
 *
 * The rule from the mission: "do not infer readiness merely because the process
 * exists." Vesper has a lot of subsystems and they come up in stages. Some are ready
 * before start() returns (the core agent, memory, tools, permissions); some come up
 * later in the background (backend probes, capability manifest, knowledge index); some
 * may never come up on this machine (a local model, NEXUS). A caller that reads
 * "started === true" and treats every one of those as ready gets exactly the class of
 * defect this state machine exists to prevent.
 *
 * ## The states
 *
 *   INITIALIZING  — before start() has returned. Critical setup running.
 *   CORE_READY    — start() returned. Deterministic intents, tools, memory, permissions
 *                   are all live. A user can `--ask` and get an answer. Optional
 *                   subsystems (model, NEXUS, knowledge) may still be coming up.
 *   READY         — every subsystem the local configuration asks for has answered. On
 *                   a machine with no local backend configured this reaches READY as
 *                   soon as the honest "no backend" state is established, because the
 *                   correct answer to "is Vesper ready" there is yes.
 *   DEGRADED      — a subsystem the config asks for is not available. The runtime is
 *                   still usable but a caller can tell.
 *   STOPPING      — shutdown() has started.
 *   STOPPED       — shutdown() completed.
 *   FAILED        — an initialization step threw in a way the runtime cannot recover
 *                   from. Distinct from DEGRADED, which is expected. Rare.
 *
 * ## What this module does not do
 *
 * It does not decide readiness on its own. Callers observe the world (backend probed,
 * manifest refreshed, knowledge indexed) and hand facts in through `mark…` methods.
 * A state machine that computed its own readiness would need to know about every
 * subsystem, and every new subsystem would have to teach it a new fact.
 *
 * It does not become an authority. This is a status surface a diagnostic and a phone
 * can read. A change in readiness cannot grant a permission or relax a check —
 * asserted structurally: this module imports nothing from `permissions.ts`,
 * `autonomy.ts`, or the registry.
 */

import type { EventBus } from "../events.ts";
import type { Logger } from "../logging.ts";
import type { JsonObject } from "../types.ts";

/** The states, ordered from earliest to latest for `advanceTo`'s monotonic check. */
export const READINESS_STATES = [
  "INITIALIZING",
  "CORE_READY",
  "DEGRADED",
  "READY",
  "STOPPING",
  "STOPPED",
  "FAILED",
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

/**
 * One initialization step the readiness monitor is aware of, and what the caller
 * observed about it.
 *
 * `optional` marks the ones whose absence should degrade rather than fail. A local
 * model is the motivating case: it is optional in the sense the runtime is useful
 * without it, but a user with `models.roles.everyday` configured has told us they
 * expect one, so its absence is a DEGRADED, not a READY.
 */
export interface ReadinessComponent {
  id: string;
  description: string;
  optional: boolean;
  state: "pending" | "ready" | "degraded" | "failed";
  detail: string;
}

export interface ReadinessSnapshot {
  state: ReadinessState;
  since: string;
  components: ReadinessComponent[];
  /** True when nothing pending remains — READY or DEGRADED. */
  settled: boolean;
  /** A one-liner summarising the state, for logs and status. */
  summary: string;
}

export interface ReadinessMonitorOptions {
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
  /** Every component the caller intends to report on. All start as pending. */
  components: Array<Omit<ReadinessComponent, "state" | "detail"> & { detail?: string }>;
}

/**
 * A small, deliberate state machine. All transitions go through `advanceTo` (which is
 * monotonic — never moves backwards toward INITIALIZING) or `markComponent` (which
 * observes a component and re-evaluates whether the aggregate should advance).
 */
export class ReadinessMonitor {
  private readonly events: EventBus | undefined;
  private readonly log: Logger | undefined;
  private readonly clock: () => Date;
  private readonly components = new Map<string, ReadinessComponent>();
  private currentState: ReadinessState = "INITIALIZING";
  private stateSince: string;

  constructor(options: ReadinessMonitorOptions) {
    this.events = options.events;
    this.log = options.log;
    this.clock = options.now ?? (() => new Date());
    this.stateSince = this.clock().toISOString();
    for (const c of options.components) {
      this.components.set(c.id, {
        id: c.id,
        description: c.description,
        optional: c.optional,
        state: "pending",
        detail: c.detail ?? "not started",
      });
    }
  }

  /** Read-only snapshot. Safe to persist or surface through a diagnostic. */
  snapshot(): ReadinessSnapshot {
    const components = [...this.components.values()].map((c) => ({ ...c }));
    const settled = this.currentState === "READY" || this.currentState === "DEGRADED";
    return {
      state: this.currentState,
      since: this.stateSince,
      components,
      settled,
      summary: this.summarise(components),
    };
  }

  /** Observe a component. Re-evaluates the aggregate state. */
  markComponent(id: string, state: ReadinessComponent["state"], detail: string): void {
    const existing = this.components.get(id);
    if (!existing) {
      // Silently accept an unknown id, to make the wiring resilient — but a debug log
      // is worth it, because a typo would otherwise mean a component that never became
      // ready and a runtime stuck in DEGRADED forever.
      this.log?.debug?.("lifecycle", "readiness mark for unknown component", { id, state });
      return;
    }
    existing.state = state;
    existing.detail = detail;
    this.reevaluate();
  }

  /**
   * Advance to a state directly. Callers use this for INITIALIZING → CORE_READY (once
   * start() returns) and for STOPPING/STOPPED/FAILED, which are not component
   * observations. Monotonic within the pre-shutdown ladder so a stale caller cannot
   * pull the state backwards; STOPPING/STOPPED/FAILED always win.
   */
  advanceTo(target: ReadinessState, detail?: string): void {
    if (target === this.currentState) return;
    if (this.isShutdownState(this.currentState) && !this.isShutdownState(target)) {
      return;
    }
    const forward = this.isForward(this.currentState, target);
    if (!forward && !this.isShutdownState(target)) return;
    this.setState(target, detail);
  }

  private reevaluate(): void {
    if (this.isShutdownState(this.currentState)) return;
    // Before CORE_READY, component observations may accumulate but the aggregate stays
    // at INITIALIZING — the runtime has not returned start() yet.
    if (this.currentState === "INITIALIZING") return;

    const components = [...this.components.values()];
    const anyPending = components.some((c) => c.state === "pending");
    const anyFailed = components.some((c) => c.state === "failed");
    const anyDegraded = components.some((c) => c.state === "degraded");
    if (anyPending) {
      // Stay wherever we are — probably CORE_READY or DEGRADED. Never regress toward
      // INITIALIZING.
      return;
    }
    if (anyFailed) {
      this.setState("DEGRADED", "One or more critical components failed to initialize.");
      return;
    }
    if (anyDegraded) {
      this.setState("DEGRADED", "One or more optional components are unavailable.");
      return;
    }
    this.setState("READY", "All configured components are ready.");
  }

  private setState(target: ReadinessState, detail?: string): void {
    if (this.currentState === target) return;
    const from = this.currentState;
    this.currentState = target;
    this.stateSince = this.clock().toISOString();
    const summary = detail ?? this.summarise([...this.components.values()]);
    this.log?.info?.("lifecycle", `readiness ${from} → ${target}`, { detail: summary });
    this.events?.emit({
      type: "lifecycle.readiness",
      title: `Vesper readiness: ${target}`,
      detail: summary,
      severity: target === "FAILED" ? "error" : target === "DEGRADED" ? "warn" : "info",
      retention: "durable",
      provenance: { author: "subsystem", source: "readiness-monitor" },
      data: { from, to: target } as JsonObject,
    });
  }

  private isShutdownState(state: ReadinessState): boolean {
    return state === "STOPPING" || state === "STOPPED" || state === "FAILED";
  }

  private isForward(from: ReadinessState, to: ReadinessState): boolean {
    const rank = READINESS_STATES.indexOf(from);
    const targetRank = READINESS_STATES.indexOf(to);
    if (rank < 0 || targetRank < 0) return false;
    return targetRank >= rank;
  }

  private summarise(components: ReadinessComponent[]): string {
    if (this.currentState === "INITIALIZING") return "Vesper is initializing.";
    if (this.isShutdownState(this.currentState)) {
      if (this.currentState === "STOPPING") return "Vesper is shutting down.";
      if (this.currentState === "STOPPED") return "Vesper stopped.";
      return "Vesper failed to initialize.";
    }
    const pending = components.filter((c) => c.state === "pending");
    if (pending.length > 0) {
      return `Core ready. Waiting on: ${pending.map((c) => c.id).join(", ")}.`;
    }
    const failed = components.filter((c) => c.state === "failed");
    const degraded = components.filter((c) => c.state === "degraded");
    const problems = [...failed, ...degraded];
    if (problems.length === 0) return "Vesper is ready.";
    return `Ready with degradation: ${problems
      .map((c) => `${c.id} ${c.state} (${c.detail})`)
      .join("; ")}.`;
  }
}
