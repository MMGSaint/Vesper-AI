/**
 * TaskScheduler — the component that actually turns a queued task into an executed
 * task, or refuses to.
 *
 * The task queue models seven states (queued/assigned/blocked/running/done/failed/
 * cancelled) with retries, dependencies, capability-based routing, mid-flight requeue
 * on restart, and lifecycle events. What it does NOT do: pick up a task the router
 * assigned to this device and actually run something. This module closes that loop.
 *
 * Invariants (each has a named test):
 *   - A task in a terminal state (done, failed, cancelled) is never re-driven.
 *   - Only tasks routed to THIS device by routeTask() are picked up here.
 *   - Only tasks with a registered executor kind are picked up; an unknown kind
 *     emits a task.executor_missing event and the task stays assigned but not
 *     re-attempted on the same tick.
 *   - Concurrent ticks cannot start the same task twice (inFlight guard).
 *   - Executor throws are caught and translated into fail() with the error message.
 *     The retry policy in the queue decides whether the task moves to `queued` or
 *     `failed` after that.
 *   - The scheduler never invents authority. `start()` is a state transition; the
 *     actual work happens inside the executor, which the runtime wires to the
 *     tool registry / permission gate for anything security-sensitive.
 *   - A task the user cancelled between assign and start is not started. The
 *     scheduler re-fetches the task's current state right before invoking the
 *     executor — a `cancelled` state seen there aborts.
 *
 * Not implemented (deliberately, for now):
 *   - Time-based backoff between retry attempts. The queue re-queues immediately.
 *     Backoff belongs to a scheduling policy this class can grow into.
 *   - Cross-device dispatch: this scheduler runs tasks assigned to itself; another
 *     device with the same runtime picks up its own share. The routing decision is
 *     already deterministic per task.
 */

import type { TaskQueue, VesperTask } from "./distributed/tasks.ts";
import type { DeviceRecord } from "./distributed/registry.ts";
import { manifestHas } from "./distributed/capabilities.ts";
import type { EventBus } from "./events.ts";
import type { Logger } from "./logging.ts";
import type { JsonObject } from "./types.ts";

export interface TaskExecutionResult {
  ok: boolean;
  summary: string;
  /** Optional structured data. Preserved on the task's result string as JSON. */
  data?: JsonObject;
}

export interface TaskExecutorContext {
  /** The device id running this executor — always the local device id. */
  deviceId: string;
  /** Signal that fires if the runtime is stopping or the task is cancelled. */
  signal: AbortSignal;
  log: Logger;
}

export type TaskExecutor = (
  task: VesperTask,
  ctx: TaskExecutorContext,
) => Promise<TaskExecutionResult>;

/**
 * A registry for named executors. Keeping this separate from the scheduler lets tests
 * install and override executors without instantiating a runtime.
 */
export class TaskExecutorRegistry {
  private readonly executors = new Map<string, TaskExecutor>();

  register(kind: string, executor: TaskExecutor): void {
    if (this.executors.has(kind)) {
      throw new Error(`Task executor already registered: ${kind}`);
    }
    this.executors.set(kind, executor);
  }

  get(kind: string): TaskExecutor | undefined {
    return this.executors.get(kind);
  }

  has(kind: string): boolean {
    return this.executors.has(kind);
  }

  known(): string[] {
    return [...this.executors.keys()];
  }
}

export interface TaskSchedulerOptions {
  taskQueue: TaskQueue;
  registry: TaskExecutorRegistry;
  events: EventBus;
  log: Logger;
  deviceId: string;
  /**
   * Provides the current device roster to routeTask(). Called on every tick; the
   * scheduler does not cache — device presence and capabilities change under it.
   */
  devices: () => Promise<DeviceRecord[]>;
  /** Optional cap on concurrent executions started per tick. */
  maxPerTick?: number;
  /** Feature flag — off by default so a runtime with no executors is silent. */
  enabled?: boolean;
}

/**
 * Terminal states — a task in one of these must never be started again. The queue
 * itself has no source-state guard on `start()`, per the synthesis report; this is
 * where the invariant is enforced.
 */
const TERMINAL_STATES = new Set<VesperTask["state"]>(["done", "failed", "cancelled"]);

export class TaskScheduler {
  private readonly opts: TaskSchedulerOptions;
  private readonly inFlight = new Set<string>();
  private stopping = false;
  private abortController = new AbortController();

  constructor(opts: TaskSchedulerOptions) {
    this.opts = opts;
  }

  enable(): void {
    // Re-arm the abort controller so a stop/enable cycle behaves cleanly.
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
    this.stopping = false;
  }

  stop(): void {
    this.stopping = true;
    this.abortController.abort();
  }

  /** Snapshot for /diagnostics; keep it JSON-serialisable. */
  status(): { enabled: boolean; inFlight: number; executors: string[] } {
    return {
      enabled: !!this.opts.enabled && !this.stopping,
      inFlight: this.inFlight.size,
      executors: this.opts.registry.known(),
    };
  }

  /**
   * One scheduler pass. Called by the idle-scheduler's onTick, but also directly
   * from tests. Returns a summary that a diagnostic can display.
   */
  async tick(): Promise<{ routed: number; started: number; skipped: number; reasons: string[] }> {
    if (!this.opts.enabled || this.stopping) {
      return { routed: 0, started: 0, skipped: 0, reasons: ["scheduler-disabled"] };
    }
    const devices = await this.opts.devices();
    const routingResults = await this.opts.taskQueue.schedule(devices);
    // Newly-assigned tasks to this device are the only candidates.
    const candidates = routingResults
      .filter((r) => r.outcome.kind === "assigned" && r.task.assignedTo === this.opts.deviceId)
      .map((r) => r.task);

    // Also pick up tasks already assigned to us before this tick (a task from a
    // previous tick that failed the executor-missing check, or a restart-requeued
    // task that has been re-assigned by routing). This avoids the queue getting stuck
    // in an "assigned but never picked up" limbo.
    const all = await this.opts.taskQueue.list();
    for (const task of all) {
      if (task.assignedTo !== this.opts.deviceId) continue;
      if (task.state !== "assigned") continue;
      if (candidates.some((c) => c.id === task.id)) continue;
      candidates.push(task);
    }

    const reasons: string[] = [];
    let started = 0;
    const cap = this.opts.maxPerTick ?? 4;
    for (const task of candidates) {
      if (started >= cap) {
        reasons.push(`per-tick cap ${cap} reached`);
        break;
      }
      const outcome = await this.tryStart(task, devices);
      reasons.push(`${task.id.slice(-8)}:${outcome}`);
      if (outcome === "started") started += 1;
    }
    return {
      routed: routingResults.length,
      started,
      skipped: candidates.length - started,
      reasons,
    };
  }

  /**
   * Re-verify that THIS device is still authorized to run the task, right now.
   *
   * An assignment made by routeTask() while the device was trusted, online, and
   * capable is a snapshot — it does not expire when the device is revoked, loses a
   * capability, or goes offline. `schedule()` only re-routes tasks in `queued` or
   * `blocked` state, so an `assigned` task keeps its stale assignment forever.
   * Without this check, a revoked device still executes work the router would now
   * refuse. Mirrors the runtime's "trust is read live, never cached into a session"
   * invariant.
   */
  private authorizedNow(task: VesperTask, devices: DeviceRecord[]): { ok: boolean; reason: string } {
    const self = devices.find((d) => d.identity.deviceId === this.opts.deviceId);
    if (!self) return { ok: false, reason: "self-not-in-roster" };
    if (self.trust !== "trusted") return { ok: false, reason: `trust-is-${self.trust}` };
    if (self.presence.reachability !== "online") return { ok: false, reason: "self-offline" };
    if (task.eligibleDevices?.length && !task.eligibleDevices.includes(this.opts.deviceId)) {
      return { ok: false, reason: "not-in-eligible-devices" };
    }
    for (const capability of task.requiredCapabilities) {
      if (!manifestHas(self.capabilities, capability)) {
        return { ok: false, reason: `missing-capability:${capability}` };
      }
    }
    return { ok: true, reason: "" };
  }

  private async tryStart(task: VesperTask, devices: DeviceRecord[]): Promise<string> {
    // Concurrency guard: a second tick that fires while a task is running must not
    // start it twice. The check-then-add MUST be atomic against parallel ticks —
    // JavaScript's single-threaded event loop guarantees synchronous code is atomic,
    // so we claim the slot NOW, before any await. If a later check refuses the task,
    // we release the slot in a finally.
    if (this.inFlight.has(task.id)) return "already-in-flight";
    this.inFlight.add(task.id);

    let handoff = false;
    try {
      // Authorization is re-checked HERE, not only at routing time. The router's
      // decision is a snapshot; this device may have been revoked, gone offline, or
      // lost a capability since the assignment was made.
      const authorized = this.authorizedNow(task, devices);
      if (!authorized.ok) {
        this.opts.events.emit({
          type: "task.authorization_revoked",
          title: `Task '${task.description}' is assigned here but this device is no longer authorized (${authorized.reason})`,
          severity: "warn",
          retention: "durable",
          provenance: { author: "subsystem", source: "task-scheduler" },
          data: { taskId: task.id, reason: authorized.reason } as JsonObject,
        });
        // Release the assignment so a re-route can place it on a device that IS
        // authorized. Leaving it `assigned` here would strand the work forever.
        await this.opts.taskQueue.releaseAssignment(task.id);
        return `unauthorized:${authorized.reason}`;
      }

      // Executor kind must be registered. A task with an unknown kind stays assigned
      // and emits a visible event so an operator can see the shortfall.
      if (!task.kind || !this.opts.registry.has(task.kind)) {
        this.opts.events.emit({
          type: "task.executor_missing",
          title: `No executor for task kind '${task.kind ?? "<none>"}' — task '${task.description}' stays assigned`,
          severity: "warn",
          retention: "durable",
          provenance: { author: "subsystem", source: "task-scheduler" },
          data: { taskId: task.id, kind: task.kind ?? "<none>" } as JsonObject,
        });
        return "executor-missing";
      }

      // Re-fetch the task right before starting. Between routing and start, a user or
      // remote device may have cancelled it — the mission's rule "a cancelled task must
      // never later execute" is enforced here, not just at the queue.
      const fresh = await this.opts.taskQueue.get(task.id);
      if (!fresh) return "vanished";
      if (TERMINAL_STATES.has(fresh.state)) return `terminal:${fresh.state}`;
      if (fresh.state !== "assigned") return `not-assigned:${fresh.state}`;
      if (fresh.assignedTo !== this.opts.deviceId) return "reassigned-away";

      const executor = this.opts.registry.get(fresh.kind!)!;
      const started = await this.opts.taskQueue.start(fresh.id);
      if (!started || started.state !== "running") return "start-refused";

      // Hand off to the fire-and-forget executor. Its finally releases the slot;
      // do NOT also release it below.
      handoff = true;
      void this.runExecutor(started, executor).finally(() => this.inFlight.delete(task.id));
      return "started";
    } finally {
      if (!handoff) this.inFlight.delete(task.id);
    }
  }

  private async runExecutor(task: VesperTask, executor: TaskExecutor): Promise<void> {
    const ctx: TaskExecutorContext = {
      deviceId: this.opts.deviceId,
      signal: this.abortController.signal,
      log: this.opts.log,
    };
    try {
      const result = await executor(task, ctx);
      // Before writing the result: the task must still be ours AND still running.
      // A task cancelled while the executor ran is no longer this scheduler's
      // business, and one re-assigned elsewhere belongs to another device now.
      // Writing `done` in either case would silently un-cancel or steal a result.
      // (The queue's own complete()/fail() guards refuse a terminal task too — this
      // is the earlier, more specific check that also covers reassignment.)
      const fresh = await this.opts.taskQueue.get(task.id);
      if (!fresh || TERMINAL_STATES.has(fresh.state)) return;
      if (fresh.state !== "running") return;
      if (fresh.assignedTo !== this.opts.deviceId) return;
      const payload = result.data
        ? JSON.stringify({ summary: result.summary, data: result.data })
        : result.summary;
      if (result.ok) {
        await this.opts.taskQueue.complete(task.id, payload);
      } else {
        await this.opts.taskQueue.fail(task.id, result.summary);
      }
    } catch (error) {
      const fresh = await this.opts.taskQueue.get(task.id);
      if (!fresh || TERMINAL_STATES.has(fresh.state)) return;
      if (fresh.state !== "running") return;
      if (fresh.assignedTo !== this.opts.deviceId) return;
      const message = error instanceof Error ? error.message : String(error);
      // Executor throws are also emitted so a debugger sees the raw message even if
      // the retry policy re-queues.
      this.opts.events.emit({
        type: "task.execution_error",
        title: `Executor threw for task '${task.description}': ${message}`,
        severity: "warn",
        retention: "durable",
        provenance: { author: "subsystem", source: "task-scheduler" },
        data: { taskId: task.id, error: message } as JsonObject,
      });
      await this.opts.taskQueue.fail(task.id, message);
    }
  }
}

/**
 * The one built-in executor. Any task whose kind is 'noop' completes with a fixed
 * receipt. Useful for smoke tests, reminders, and as a placeholder for tasks a user
 * queued to see the lifecycle wired up before real executors exist.
 */
export function registerBuiltinExecutors(registry: TaskExecutorRegistry): void {
  registry.register("noop", async (task) => ({
    ok: true,
    summary: `noop task '${task.description}' complete`,
  }));
}
