/**
 * Cross-device tasks.
 *
 * A task records what needs doing and what it needs to be done *with*, so the decision
 * of where it runs is made from capabilities rather than from where it was typed. A
 * benchmark asked for on a phone belongs on the desktop; asking on the phone should not
 * make the phone try.
 *
 * Two rules constrain routing and neither may be relaxed for convenience:
 *
 *   - A task never runs somewhere that lacks a capability it declared. Degrading the
 *     work to fit an available device silently produces a wrong answer.
 *   - A task marked private never leaves the devices the user owns, even when that means
 *     waiting. "The preferred device is offline" is not a reason to send private work
 *     somewhere else.
 */

import { randomUUID } from "node:crypto";
import type { StorageAdapter } from "../storage.ts";
import type { JsonValue } from "../types.ts";
import type { Capability } from "./capabilities.ts";
import { isGranted, manifestHas } from "./capabilities.ts";
import type { DeviceRecord } from "./registry.ts";

const KEY = "tasks.queue";

export const TASK_STATES = [
  "queued",
  "assigned",
  "running",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_PRIORITIES = ["low", "normal", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface RetryPolicy {
  maxAttempts: number;
  attempts: number;
}

export interface VesperTask {
  id: string;
  description: string;
  state: TaskState;
  priority: TaskPriority;
  createdAt: string;
  updatedAt: string;
  /** The device that asked for it, which is often not the device that runs it. */
  createdBy: string;
  requiredCapabilities: Capability[];
  preferredDevice?: string;
  /** When set, routing considers only these devices. */
  eligibleDevices?: string[];
  /** Task ids that must reach `done` first. */
  dependsOn: string[];
  assignedTo: string | null;
  result: string | null;
  error: string | null;
  retry: RetryPolicy;
  /** Private work stays on the user's own devices, even if that means queuing. */
  private: boolean;
  /**
   * Names the executor that should run this task. Optional for backwards
   * compatibility — a task without a kind is a description-only reminder that no
   * scheduler will start on its own. The kind resolves through TaskExecutorRegistry.
   */
  kind?: string;
  /**
   * Free-form arguments the executor consumes. Kept as JsonObject so a task can
   * survive a restart via the same JSON persistence the rest of the queue uses.
   */
  args?: import("../types.ts").JsonObject;
  /**
   * When set, the scheduler must not start this task before this instant.
   * ISO-8601, stored as an absolute timestamp so a restart does not re-delay it.
   * Absent means "due as soon as it is assigned" — the previous behaviour.
   */
  dueAt?: string;
  /**
   * Optimistic-concurrency claim, written by `start()`.
   *
   * The StorageAdapter interface is get/set/delete/keys — it has no compare-and-swap,
   * so a read-modify-write across two processes sharing one store is not atomic: both
   * can refresh, both see `assigned`, both write `running`. `start()` therefore writes
   * a unique claim, re-reads, and only reports success if its own claim survived. The
   * loser sees a different claim and backs off without executing.
   *
   * This narrows the race to "two writers, one winner" rather than eliminating the
   * window — a genuine CAS at the storage layer would be needed for that, and is
   * recorded as a limitation rather than claimed as solved.
   */
  claim?: string;
}

export interface CreateTaskInput {
  description: string;
  createdBy: string;
  requiredCapabilities?: Capability[];
  priority?: TaskPriority;
  preferredDevice?: string;
  eligibleDevices?: string[];
  dependsOn?: string[];
  maxAttempts?: number;
  private?: boolean;
  kind?: string;
  args?: import("../types.ts").JsonObject;
  /** Absolute ISO-8601 instant. Prefer this over `inSeconds` at the call site. */
  dueAt?: string;
}

/**
 * Ten years. A delay that large is not a timer anyone will wait for, and some Date
 * implementations overflow well before the JS spec's maximum.
 */
export const MAX_TASK_DELAY_SECONDS = 10 * 365 * 24 * 60 * 60;

/**
 * Turn the two ways a caller can say "when" into one absolute timestamp, or refuse.
 *
 * `dueAt` and `inSeconds` together are ambiguous — they can disagree — so both is an
 * error rather than a preference. `inSeconds` is converted at parse time so a restart
 * does not add the delay again.
 */
export function parseTaskDueAt(input: {
  dueAt?: unknown;
  inSeconds?: unknown;
  nowMs?: number;
}): { dueAt: string } | { dueAt?: undefined } | { error: string } {
  const hasDue = typeof input.dueAt === "string" && input.dueAt.trim().length > 0;
  const hasIn = input.inSeconds !== undefined && input.inSeconds !== null;
  if (hasDue && hasIn) {
    return { error: "Pass dueAt or inSeconds, not both." };
  }
  if (!hasDue && !hasIn) return {};
  if (hasDue) {
    const ms = Date.parse((input.dueAt as string).trim());
    if (!Number.isFinite(ms)) return { error: "dueAt must be an ISO-8601 timestamp." };
    return { dueAt: new Date(ms).toISOString() };
  }
  if (typeof input.inSeconds !== "number" || !Number.isFinite(input.inSeconds) || input.inSeconds < 0) {
    return { error: "inSeconds must be a non-negative number." };
  }
  if (input.inSeconds > MAX_TASK_DELAY_SECONDS) {
    return { error: "inSeconds is larger than the ten-year maximum." };
  }
  const now = input.nowMs ?? Date.now();
  return { dueAt: new Date(now + input.inSeconds * 1000).toISOString() };
}

/**
 * Whether the scheduler may start this task *now*.
 *
 * A missing dueAt is due immediately (the previous behaviour). A garbage timestamp is
 * its own state so the scheduler can fail the task rather than fire it or skip it
 * forever.
 */
export function taskDueState(
  task: { dueAt?: string },
  nowMs: number,
): "due" | "not-due" | "invalid-dueAt" {
  if (!task.dueAt) return "due";
  const ms = Date.parse(task.dueAt);
  if (!Number.isFinite(ms)) return "invalid-dueAt";
  return nowMs < ms ? "not-due" : "due";
}

export type RoutingOutcome =
  | { kind: "assigned"; deviceId: string; reason: string }
  | { kind: "queued"; reason: string }
  | { kind: "blocked"; reason: string };

/**
 * Choose where a task should run.
 *
 * Returns `queued` rather than a second-best device when nothing qualifies. A caller
 * that cannot tell "no device can do this yet" from "here is a device that mostly can"
 * will eventually run the task somewhere it does not belong.
 */
export function routeTask(input: {
  task: VesperTask;
  devices: DeviceRecord[];
  completedTaskIds: ReadonlySet<string>;
}): RoutingOutcome {
  const unmet = input.task.dependsOn.filter((id) => !input.completedTaskIds.has(id));
  if (unmet.length) {
    return { kind: "blocked", reason: `Waiting on ${unmet.length} unfinished task(s).` };
  }

  const candidates = input.devices.filter((device) => {
    // Only a trusted device may execute. A restricted (portable) device can create work
    // and watch it, but running it would put execution on an untrusted host.
    if (device.trust !== "trusted") return false;
    if (!isGranted(device.trust, "task_execute")) return false;
    if (device.presence.reachability !== "online") return false;
    if (input.task.eligibleDevices?.length && !input.task.eligibleDevices.includes(device.identity.deviceId)) {
      return false;
    }
    return input.task.requiredCapabilities.every((capability) =>
      manifestHas(device.capabilities, capability),
    );
  });

  if (candidates.length === 0) {
    const anyCapable = input.devices.some((device) =>
      input.task.requiredCapabilities.every((capability) => manifestHas(device.capabilities, capability)),
    );
    return {
      kind: "queued",
      reason: anyCapable
        ? "The capable device is not online. Holding the task rather than running it somewhere that cannot do it."
        : "No enrolled device reports the capabilities this task needs.",
    };
  }

  const preferred = candidates.find(
    (device) => device.identity.deviceId === input.task.preferredDevice,
  );
  if (preferred) {
    return {
      kind: "assigned",
      deviceId: preferred.identity.deviceId,
      reason: `Preferred device ${preferred.identity.name} is online and capable.`,
    };
  }

  // Idle beats active: heavy work should land where it will not fight the user for the
  // machine they are currently using.
  const rank = (device: DeviceRecord): number => {
    switch (device.presence.activity) {
      case "idle":
        return 0;
      case "background":
        return 1;
      case "unknown":
        return 2;
      default:
        return 3;
    }
  };
  const chosen = [...candidates].sort(
    (a, b) => rank(a) - rank(b) || a.identity.deviceId.localeCompare(b.identity.deviceId),
  )[0];
  return {
    kind: "assigned",
    deviceId: chosen.identity.deviceId,
    reason: `${chosen.identity.name} is online, capable, and ${chosen.presence.activity}.`,
  };
}

/**
 * Emitted by TaskQueue on every state transition so the runtime can surface tasks in
 * events, catchup, and notifications. The queue does not depend on any event bus: it
 * calls a small callback and lets the runtime translate.
 */
export type TaskLifecycleEvent =
  | { kind: "created"; task: VesperTask }
  | { kind: "assigned"; task: VesperTask; deviceId: string }
  | { kind: "blocked"; task: VesperTask; reason: string }
  | { kind: "requeued"; task: VesperTask; reason: string }
  | { kind: "started"; task: VesperTask }
  | { kind: "completed"; task: VesperTask }
  | { kind: "failed"; task: VesperTask; error: string; final: boolean }
  | { kind: "cancelled"; task: VesperTask };

export class TaskQueue {
  private readonly storage: StorageAdapter;
  private readonly now: () => string;
  private tasks = new Map<string, VesperTask>();
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  private onLifecycle: ((event: TaskLifecycleEvent) => void) | undefined;

  constructor(options: { storage: StorageAdapter; now?: () => string; onLifecycle?: (event: TaskLifecycleEvent) => void }) {
    this.storage = options.storage;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onLifecycle = options.onLifecycle;
  }

  /**
   * Install a lifecycle callback after construction. The runtime uses this because the
   * event bus is created *after* the task queue at startup; the queue calls this once
   * the bus exists, and every subsequent transition reaches the bus.
   */
  setOnLifecycle(fn: ((event: TaskLifecycleEvent) => void) | undefined): void {
    this.onLifecycle = fn;
  }

  private emit(event: TaskLifecycleEvent): void {
    // The callback is user code. A throw from it must not corrupt the queue's own state
    // — the transition has already been persisted before we call.
    try {
      this.onLifecycle?.(event);
    } catch {
      // Silently swallow. The runtime's own subscriber logs; test callbacks are
      // trusted enough not to matter here.
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Parse one persisted row into a task, or null if the row is not shaped like one.
   *
   * `requeueInFlight` is true only on the first load of a process: a task caught
   * `running` or `assigned` by a crash is requeued rather than assumed finished. On a
   * mid-session refresh it must be FALSE — coercing a live `running` task back to
   * `queued` on every mutation would undo the state another runtime just committed.
   */
  private parseStoredTask(item: unknown, requeueInFlight = false): VesperTask | null {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const task = item as Partial<VesperTask>;
    if (typeof task.id !== "string" || typeof task.description !== "string") return null;
    const state = (TASK_STATES as readonly string[]).includes(String(task.state))
      ? (task.state as TaskState)
      : "queued";
    return {
      id: task.id,
      description: task.description,
      state: requeueInFlight && (state === "running" || state === "assigned") ? "queued" : state,
      priority: (TASK_PRIORITIES as readonly string[]).includes(String(task.priority))
        ? (task.priority as TaskPriority)
        : "normal",
      createdAt: typeof task.createdAt === "string" ? task.createdAt : this.now(),
      updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : this.now(),
      createdBy: typeof task.createdBy === "string" ? task.createdBy : "unknown",
      requiredCapabilities: Array.isArray(task.requiredCapabilities)
        ? (task.requiredCapabilities.filter((c) => typeof c === "string") as Capability[])
        : [],
      preferredDevice: typeof task.preferredDevice === "string" ? task.preferredDevice : undefined,
      eligibleDevices: Array.isArray(task.eligibleDevices)
        ? task.eligibleDevices.filter((d): d is string => typeof d === "string")
        : undefined,
      dependsOn: Array.isArray(task.dependsOn)
        ? task.dependsOn.filter((d): d is string => typeof d === "string")
        : [],
      assignedTo: typeof task.assignedTo === "string" ? task.assignedTo : null,
      result: typeof task.result === "string" ? task.result : null,
      error: typeof task.error === "string" ? task.error : null,
      retry: {
        maxAttempts:
          typeof task.retry?.maxAttempts === "number" && task.retry.maxAttempts > 0
            ? Math.floor(task.retry.maxAttempts)
            : 3,
        attempts: typeof task.retry?.attempts === "number" ? Math.max(0, Math.floor(task.retry.attempts)) : 0,
      },
      private: task.private !== false,
      kind: typeof task.kind === "string" ? task.kind : undefined,
      args: (task.args && typeof task.args === "object" && !Array.isArray(task.args))
        ? (task.args as import("../types.ts").JsonObject)
        : undefined,
      dueAt: typeof task.dueAt === "string" && task.dueAt.length > 0 ? task.dueAt : undefined,
      claim: typeof task.claim === "string" ? task.claim : undefined,
    };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.storage.get(KEY);
      if (!Array.isArray(raw)) return;
      let recovered = 0;
      for (const item of raw) {
        // requeueInFlight=true: this is process start, so a task caught mid-flight by
        // a crash is requeued rather than assumed finished.
        const parsed = this.parseStoredTask(item, true);
        if (!parsed) continue;
        const storedState = (item as Partial<VesperTask>).state;
        if (storedState !== parsed.state) recovered += 1;
        this.tasks.set(parsed.id, parsed);
      }
      // PERSIST the crash recovery. Holding the requeue only in memory made it
      // invisible to `refreshFromStorage`, which re-reads the raw `running` row and
      // overwrites the recovered `queued` — so the very next mutation undid the
      // recovery and every subsequent start() was refused as "already running".
      // A recovery that is not written down is not a recovery.
      if (recovered > 0) await this.persist();
    } catch {
      // A corrupt queue costs pending work, not the ability to accept new work.
      this.tasks = new Map();
    }
  }

  private async persist(): Promise<void> {
    await this.storage.set(KEY, [...this.tasks.values()] as unknown as JsonValue).catch(() => undefined);
  }

  async create(input: CreateTaskInput): Promise<VesperTask> {
    return this.runExclusive(async () => {
      await this.load();
      const now = this.now();
      const task: VesperTask = {
        id: `task_${randomUUID()}`,
        description: input.description,
        state: "queued",
        priority: input.priority ?? "normal",
        createdAt: now,
        updatedAt: now,
        createdBy: input.createdBy,
        requiredCapabilities: input.requiredCapabilities ?? [],
        preferredDevice: input.preferredDevice,
        eligibleDevices: input.eligibleDevices,
        dependsOn: input.dependsOn ?? [],
        assignedTo: null,
        result: null,
        error: null,
        retry: { maxAttempts: Math.max(1, input.maxAttempts ?? 3), attempts: 0 },
        // Private by default: work is assumed personal unless stated otherwise.
        private: input.private !== false,
        kind: input.kind,
        args: input.args,
        dueAt: input.dueAt,
      };
      this.tasks.set(task.id, task);
      await this.persist();
      const snapshot = { ...task };
      this.emit({ kind: "created", task: snapshot });
      return snapshot;
    });
  }

  async list(): Promise<VesperTask[]> {
    await this.runExclusive(async () => this.load());
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }

  async get(id: string): Promise<VesperTask | undefined> {
    const found = (await this.list()).find((task) => task.id === id);
    return found ? { ...found } : undefined;
  }

  /**
   * Apply a mutation under the exclusive queue, re-reading persisted state first.
   *
   * The re-read is what makes state guards mean anything when two runtimes share one
   * storage adapter. Without it, `load()`'s one-shot `if (this.loaded) return` leaves
   * each instance operating on a snapshot taken at its own first read: a second
   * runtime would see a task as `assigned` long after the first had driven it to
   * `done`, re-run the executor, and overwrite the committed result. The exclusive
   * queue serialises mutations within a process; the refresh is what extends the
   * guarantee across processes sharing a store.
   */
  private async mutate(id: string, apply: (task: VesperTask) => void): Promise<VesperTask | undefined> {
    return this.runExclusive(async () => {
      await this.load();
      await this.refreshFromStorage();
      const task = this.tasks.get(id);
      if (!task) return undefined;
      apply(task);
      task.updatedAt = this.now();
      await this.persist();
      return { ...task };
    });
  }

  /**
   * Re-read the persisted queue into the in-memory map. Called inside the exclusive
   * section of every mutation. Best-effort: a read failure keeps the current
   * in-memory view rather than dropping the queue, matching `load()`'s policy that a
   * corrupt store costs pending work, never availability.
   */
  private async refreshFromStorage(): Promise<void> {
    try {
      const raw = await this.storage.get(KEY);
      if (!Array.isArray(raw)) return;
      const fresh = new Map<string, VesperTask>();
      for (const item of raw) {
        const parsed = this.parseStoredTask(item);
        if (parsed) fresh.set(parsed.id, parsed);
      }
      this.tasks = fresh;
    } catch {
      // Keep the current view. The next mutation retries.
    }
  }

  /** Route every routable task and record the outcome. */
  async schedule(devices: DeviceRecord[]): Promise<{ task: VesperTask; outcome: RoutingOutcome }[]> {
    const all = await this.list();
    const completed = new Set(all.filter((task) => task.state === "done").map((task) => task.id));
    const results: { task: VesperTask; outcome: RoutingOutcome }[] = [];
    for (const task of all) {
      if (task.state !== "queued" && task.state !== "blocked") continue;
      const outcome = routeTask({ task, devices, completedTaskIds: completed });
      const updated = await this.mutate(task.id, (item) => {
        if (outcome.kind === "assigned") {
          item.assignedTo = outcome.deviceId;
          item.state = "assigned";
        } else {
          item.assignedTo = null;
          item.state = outcome.kind === "blocked" ? "blocked" : "queued";
        }
      });
      if (updated) {
        results.push({ task: updated, outcome });
        if (outcome.kind === "assigned") {
          this.emit({ kind: "assigned", task: updated, deviceId: outcome.deviceId });
        } else if (outcome.kind === "blocked") {
          this.emit({ kind: "blocked", task: updated, reason: outcome.reason });
        } else if (outcome.kind === "queued") {
          this.emit({ kind: "requeued", task: updated, reason: outcome.reason });
        }
      }
    }
    return results;
  }

  /**
   * Transition a task to `running`.
   *
   * Refuses unless the task is currently `assigned` or `queued`. Without this guard a
   * stale caller (a second runtime whose in-memory map predates a cancel, or a
   * scheduler holding an old snapshot) could re-drive a task that is already done,
   * failed, cancelled, or running — silently un-cancelling it and double-executing.
   * Returns undefined when the transition is refused, which every caller already
   * treats as "did not start".
   */
  async start(id: string): Promise<VesperTask | undefined> {
    const claim = `claim_${randomUUID()}`;
    let refusedFrom: TaskState | null = null;
    const updated = await this.mutate(id, (task) => {
      if (task.state !== "assigned" && task.state !== "queued") {
        refusedFrom = task.state;
        return;
      }
      // The retry budget is spent. A crash between start() and fail() bumps attempts
      // without ever reaching the cap check in fail(), so a crash loop would restart
      // the task forever. Enforcing the cap here too bounds it from both ends.
      if (task.retry.attempts >= task.retry.maxAttempts) {
        refusedFrom = task.state;
        task.state = "failed";
        task.assignedTo = null;
        task.error = task.error ?? `Retry budget exhausted after ${task.retry.attempts} attempt(s).`;
        return;
      }
      task.state = "running";
      task.retry.attempts += 1;
      task.claim = claim;
    });
    if (refusedFrom) return undefined;
    if (!updated) return undefined;

    // Claim verification. Two runtimes sharing a store can both pass the state guard
    // above (each refreshed before the other persisted), so the write alone does not
    // establish ownership. Re-read and check that OUR claim is the one on disk; the
    // loser backs off without executing.
    await this.runExclusive(async () => this.refreshFromStorage());
    const settled = this.tasks.get(id);
    if (!settled || settled.claim !== claim) {
      return undefined;
    }
    this.emit({ kind: "started", task: updated });
    return updated;
  }

  /**
   * Drop an assignment without terminating the task — used when the assigned device
   * turns out not to be authorized any more, so the router can place the work
   * somewhere it is allowed to run. Refuses on a terminal or running task.
   */
  async releaseAssignment(id: string): Promise<VesperTask | undefined> {
    return this.mutate(id, (task) => {
      if (task.state !== "assigned" && task.state !== "blocked") return;
      task.assignedTo = null;
      task.state = "queued";
    });
  }

  /**
   * Mark a task done. Refuses if the task is already terminal — a stale caller must
   * not overwrite a result that is already committed, and must never un-cancel.
   */
  async complete(id: string, result: string): Promise<VesperTask | undefined> {
    let refused = false;
    const updated = await this.mutate(id, (task) => {
      if (task.state === "done" || task.state === "failed" || task.state === "cancelled") {
        refused = true;
        return;
      }
      task.state = "done";
      task.result = result;
      task.error = null;
    });
    if (refused) return undefined;
    if (updated) this.emit({ kind: "completed", task: updated });
    return updated;
  }

  /**
   * A failure retries until the policy is exhausted, then stops and says why.
   * Refuses if the task is already terminal — the same "no overwriting committed
   * work" rule that guards complete().
   */
  /**
   * Record a failure.
   *
   * `opts.retryable: false` fails the task outright instead of re-queueing it, for the
   * class of failure that will never come out differently. A permission refusal is the
   * motivating case: retrying it three times produces three identical refusals, three
   * audit entries and three journal events, and burns the retry budget that exists for
   * transient problems. "You may not do this" is an answer, not an outage.
   */
  async fail(
    id: string,
    error: string,
    opts: { retryable?: boolean } = {},
  ): Promise<VesperTask | undefined> {
    let refused = false;
    const updated = await this.mutate(id, (task) => {
      if (task.state === "done" || task.state === "failed" || task.state === "cancelled") {
        refused = true;
        return;
      }
      task.error = error;
      task.assignedTo = null;
      const exhausted = task.retry.attempts >= task.retry.maxAttempts;
      task.state = opts.retryable === false || exhausted ? "failed" : "queued";
    });
    if (refused) return undefined;
    if (updated) {
      const final = updated.state === "failed";
      this.emit({ kind: "failed", task: updated, error, final });
    }
    return updated;
  }

  async cancel(id: string): Promise<VesperTask | undefined> {
    const updated = await this.mutate(id, (task) => {
      task.state = "cancelled";
      task.assignedTo = null;
    });
    if (updated) this.emit({ kind: "cancelled", task: updated });
    return updated;
  }
}
