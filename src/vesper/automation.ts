/**
 * Schedule vs trigger vs heartbeat.
 *
 * The idle scheduler already ticks. The task queue already runs work through the
 * permission gate with a scheduled origin. This module classifies background work so
 * a periodic observation can stay quiet, a clock can fire, and an event can start
 * work — without a DAG engine or a new privilege.
 *
 * Heartbeats must have a no-op. If nothing meaningful changed, Vesper does not notify.
 * Automations never set `confirmed` and never pick their own origin.
 */

import { createHash } from "node:crypto";
import { createId, nowIso } from "./id.ts";
import type { StorageAdapter } from "./storage.ts";
import type { JsonObject, JsonValue } from "./types.ts";

export const AUTOMATION_KINDS = ["schedule", "trigger", "heartbeat"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

const KEY = "automations.entries";
const MAX_AUTOMATIONS = 64;

export interface Automation {
  id: string;
  kind: AutomationKind;
  name: string;
  description: string;
  enabled: boolean;
  workspaceId?: string;
  sessionId?: string;
  /** Schedule: minimum milliseconds between fires. */
  intervalMs?: number;
  nextAt?: string;
  /** Trigger: event type to match, e.g. `task.failed`. */
  eventType?: string;
  /** Heartbeat: digest of the last meaningful observation. */
  lastDigest?: string;
  lastFiredAt?: string;
  lastOutcome?: "fired" | "quiet" | "skipped";
  createdAt: string;
  updatedAt: string;
}

export type AutomationDecision =
  | { action: "fire"; reason: string }
  | { action: "quiet"; reason: string }
  | { action: "skip"; reason: string };

export class AutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationError";
  }
}

export function digestObservation(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export function evaluateAutomation(
  automation: Automation,
  input: { now?: number; eventType?: string; observation?: unknown },
): AutomationDecision {
  if (!automation.enabled) return { action: "skip", reason: "disabled" };
  const now = input.now ?? Date.now();

  if (automation.kind === "schedule") {
    const interval = Math.max(1_000, automation.intervalMs ?? 60_000);
    const next = automation.nextAt ? Date.parse(automation.nextAt) : 0;
    if (Number.isFinite(next) && now < next) {
      return { action: "skip", reason: "not due yet" };
    }
    const last = automation.lastFiredAt ? Date.parse(automation.lastFiredAt) : 0;
    if (Number.isFinite(last) && now - last < interval) {
      return { action: "skip", reason: "interval not elapsed" };
    }
    return { action: "fire", reason: "schedule due" };
  }

  if (automation.kind === "trigger") {
    if (!input.eventType) return { action: "skip", reason: "no event" };
    if (!automation.eventType || input.eventType !== automation.eventType) {
      return { action: "skip", reason: "event does not match" };
    }
    return { action: "fire", reason: `event ${input.eventType}` };
  }

  // heartbeat
  if (input.observation === undefined) return { action: "skip", reason: "no observation" };
  const digest = digestObservation(input.observation);
  if (automation.lastDigest && automation.lastDigest === digest) {
    return { action: "quiet", reason: "observation unchanged" };
  }
  return { action: "fire", reason: "observation changed" };
}

export class AutomationStore {
  private readonly storage: StorageAdapter;
  private loaded = false;
  private items = new Map<string, Automation>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
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
        const parsed = coerceAutomation(item);
        if (parsed) this.items.set(parsed.id, parsed);
      }
    } catch {
      this.items = new Map();
    }
  }

  private async persist(): Promise<void> {
    await this.storage.set(KEY, [...this.items.values()] as unknown as JsonValue).catch(() => undefined);
  }

  async create(input: {
    kind: AutomationKind;
    name: string;
    description: string;
    workspaceId?: string;
    sessionId?: string;
    intervalMs?: number;
    eventType?: string;
    enabled?: boolean;
  }): Promise<Automation> {
    return this.runExclusive(async () => {
      await this.load();
      if (this.items.size >= MAX_AUTOMATIONS) {
        throw new AutomationError(`Already holding ${MAX_AUTOMATIONS} automations.`);
      }
      const name = input.name.trim();
      if (!name) throw new AutomationError("An automation needs a name.");
      if (input.kind === "trigger" && !input.eventType) {
        throw new AutomationError("A trigger needs an event type.");
      }
      if (input.kind === "schedule" && input.intervalMs !== undefined && input.intervalMs < 1_000) {
        throw new AutomationError("A schedule interval must be at least one second.");
      }
      const now = nowIso();
      const item: Automation = {
        id: createId("auto"),
        kind: input.kind,
        name: name.slice(0, 120),
        description: input.description.trim().slice(0, 500),
        enabled: input.enabled !== false,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        intervalMs: input.kind === "schedule" ? Math.max(1_000, input.intervalMs ?? 86_400_000) : undefined,
        eventType: input.kind === "trigger" ? input.eventType : undefined,
        createdAt: now,
        updatedAt: now,
      };
      this.items.set(item.id, item);
      await this.persist();
      return { ...item };
    });
  }

  async record(id: string, decision: AutomationDecision, options?: { observation?: unknown; now?: number }): Promise<Automation | undefined> {
    return this.runExclusive(async () => {
      await this.load();
      const item = this.items.get(id);
      if (!item) return undefined;
      const now = options?.now ?? Date.now();
      const stamp = new Date(now).toISOString();
      item.lastOutcome = decision.action === "skip" ? "skipped" : decision.action === "fire" ? "fired" : "quiet";
      item.updatedAt = stamp;
      if (decision.action === "fire") {
        item.lastFiredAt = stamp;
        if (item.kind === "schedule") {
          const interval = Math.max(1_000, item.intervalMs ?? 60_000);
          item.nextAt = new Date(now + interval).toISOString();
        }
        if (item.kind === "heartbeat" && options?.observation !== undefined) {
          item.lastDigest = digestObservation(options.observation);
        }
      }
      if (decision.action === "quiet" && options?.observation !== undefined) {
        item.lastDigest = digestObservation(options.observation);
      }
      await this.persist();
      return { ...item };
    });
  }

  async disable(id: string): Promise<Automation> {
    return this.runExclusive(async () => {
      await this.load();
      const item = this.items.get(id);
      if (!item) throw new AutomationError("No such automation.");
      item.enabled = false;
      item.updatedAt = nowIso();
      await this.persist();
      return { ...item };
    });
  }

  async list(): Promise<Automation[]> {
    await this.runExclusive(async () => this.load());
    return [...this.items.values()].map((item) => ({ ...item }));
  }

  async evaluateAll(input: {
    now?: number;
    eventType?: string;
    observationFor?: (automation: Automation) => unknown;
  }): Promise<Array<{ automation: Automation; decision: AutomationDecision }>> {
    const all = await this.list();
    const results: Array<{ automation: Automation; decision: AutomationDecision }> = [];
    for (const automation of all) {
      const observation = input.observationFor?.(automation);
      const decision = evaluateAutomation(automation, {
        now: input.now,
        eventType: input.eventType,
        observation,
      });
      const recorded = await this.record(automation.id, decision, {
        now: input.now,
        observation,
      });
      results.push({ automation: recorded ?? automation, decision });
    }
    return results;
  }
}

export function automationToTaskArgs(automation: Automation): JsonObject {
  return {
    automationId: automation.id,
    kind: automation.kind,
    workspaceId: automation.workspaceId ?? null,
    sessionId: automation.sessionId ?? null,
  };
}

function coerceAutomation(raw: unknown): Automation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Partial<Automation>;
  if (typeof rec.id !== "string" || typeof rec.name !== "string") return null;
  const kind = AUTOMATION_KINDS.includes(rec.kind as AutomationKind) ? (rec.kind as AutomationKind) : null;
  if (!kind) return null;
  return {
    id: rec.id,
    kind,
    name: rec.name,
    description: typeof rec.description === "string" ? rec.description : "",
    enabled: rec.enabled !== false,
    workspaceId: typeof rec.workspaceId === "string" ? rec.workspaceId : undefined,
    sessionId: typeof rec.sessionId === "string" ? rec.sessionId : undefined,
    intervalMs: typeof rec.intervalMs === "number" ? rec.intervalMs : undefined,
    nextAt: typeof rec.nextAt === "string" ? rec.nextAt : undefined,
    eventType: typeof rec.eventType === "string" ? rec.eventType : undefined,
    lastDigest: typeof rec.lastDigest === "string" ? rec.lastDigest : undefined,
    lastFiredAt: typeof rec.lastFiredAt === "string" ? rec.lastFiredAt : undefined,
    lastOutcome:
      rec.lastOutcome === "fired" || rec.lastOutcome === "quiet" || rec.lastOutcome === "skipped"
        ? rec.lastOutcome
        : undefined,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : nowIso(),
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : nowIso(),
  };
}
