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

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.storage.get(KEY);
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        const task = item as Partial<VesperTask>;
        if (typeof task.id !== "string" || typeof task.description !== "string") continue;
        const state = (TASK_STATES as readonly string[]).includes(String(task.state))
          ? (task.state as TaskState)
          : "queued";
        this.tasks.set(task.id, {
          id: task.id,
          description: task.description,
          // A task caught mid-flight by a restart is requeued, not assumed finished.
          state: state === "running" || state === "assigned" ? "queued" : state,
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
        });
      }
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

  private async mutate(id: string, apply: (task: VesperTask) => void): Promise<VesperTask | undefined> {
    return this.runExclusive(async () => {
      await this.load();
      const task = this.tasks.get(id);
      if (!task) return undefined;
      apply(task);
      task.updatedAt = this.now();
      await this.persist();
      return { ...task };
    });
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

  async start(id: string): Promise<VesperTask | undefined> {
    const updated = await this.mutate(id, (task) => {
      task.state = "running";
      task.retry.attempts += 1;
    });
    if (updated) this.emit({ kind: "started", task: updated });
    return updated;
  }

  async complete(id: string, result: string): Promise<VesperTask | undefined> {
    const updated = await this.mutate(id, (task) => {
      task.state = "done";
      task.result = result;
      task.error = null;
    });
    if (updated) this.emit({ kind: "completed", task: updated });
    return updated;
  }

  /** A failure retries until the policy is exhausted, then stops and says why. */
  async fail(id: string, error: string): Promise<VesperTask | undefined> {
    const updated = await this.mutate(id, (task) => {
      task.error = error;
      task.assignedTo = null;
      task.state = task.retry.attempts >= task.retry.maxAttempts ? "failed" : "queued";
    });
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
