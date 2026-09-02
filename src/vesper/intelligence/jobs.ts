/**
 * Durable jobs.
 *
 * A job is a restart-safe record of work Vesper was asked to finish. It is not a
 * tool call. Progress, checkpoints, cancellation, and a completion summary live
 * here. Actual world-change still goes through the permission gate.
 */

import { createId, nowIso } from "../id.ts";
import type { JsonObject, JsonValue } from "../types.ts";
import type { StorageAdapter } from "../storage.ts";

export const JOB_STATES = [
  "queued",
  "running",
  "checkpointed",
  "waiting_confirm",
  "done",
  "failed",
  "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];

const KEY = "intelligence.jobs";
const MAX_JOBS = 50;
const SECRETISH = /(?:api[_-]?key|secret|password|token|credential|private[_-]?key)/i;

export interface DurableJob {
  id: string;
  title: string;
  workspaceId: string;
  ownerDeviceId: string;
  state: JobState;
  progress: number;
  checkpoint?: JsonObject;
  summary?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobError";
  }
}

export class JobStore {
  private readonly storage: StorageAdapter;
  private loaded = false;
  private items = new Map<string, DurableJob>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
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
    const raw = await this.storage.get(KEY);
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      const job = coerceJob(item);
      if (job) this.items.set(job.id, job);
    }
  }

  private async persist(): Promise<void> {
    await this.storage.set(KEY, [...this.items.values()] as unknown as JsonValue);
  }

  async create(input: { title: string; workspaceId: string; ownerDeviceId: string }): Promise<DurableJob> {
    return this.run(async () => {
      await this.load();
      if (SECRETISH.test(input.title)) throw new JobError("Job titles cannot carry secret-shaped values.");
      if (this.items.size >= MAX_JOBS) throw new JobError("Job cap reached.");
      const now = nowIso();
      const job: DurableJob = {
        id: createId("job"),
        title: input.title.trim().slice(0, 160),
        workspaceId: input.workspaceId,
        ownerDeviceId: input.ownerDeviceId,
        state: "queued",
        progress: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.items.set(job.id, job);
      await this.persist();
      return job;
    });
  }

  async checkpoint(id: string, checkpoint: JsonObject, progress: number): Promise<DurableJob> {
    return this.transition(id, (job) => {
      if (job.state === "cancelled" || job.state === "done" || job.state === "failed") {
        throw new JobError(`A ${job.state} job cannot checkpoint.`);
      }
      if (looksSecret(checkpoint)) throw new JobError("A checkpoint cannot store secret-shaped values.");
      return {
        ...job,
        state: "checkpointed",
        checkpoint,
        progress: clamp(progress),
        updatedAt: nowIso(),
      };
    });
  }

  async cancel(id: string): Promise<DurableJob> {
    return this.transition(id, (job) => {
      if (job.state === "done") throw new JobError("A finished job cannot be cancelled.");
      return { ...job, state: "cancelled", updatedAt: nowIso() };
    });
  }

  async complete(id: string, summary: string): Promise<DurableJob> {
    return this.transition(id, (job) => {
      if (job.state === "cancelled") throw new JobError("A cancelled job cannot complete.");
      return { ...job, state: "done", progress: 1, summary: summary.slice(0, 400), updatedAt: nowIso() };
    });
  }

  async fail(id: string, error: string): Promise<DurableJob> {
    return this.transition(id, (job) => ({
      ...job,
      state: "failed",
      error: error.slice(0, 400),
      updatedAt: nowIso(),
    }));
  }

  async list(): Promise<DurableJob[]> {
    await this.load();
    return [...this.items.values()];
  }

  private transition(id: string, fn: (job: DurableJob) => DurableJob): Promise<DurableJob> {
    return this.run(async () => {
      await this.load();
      const job = this.items.get(id);
      if (!job) throw new JobError("Unknown job.");
      const next = fn(job);
      this.items.set(id, next);
      await this.persist();
      return next;
    });
  }
}

function clamp(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(1, Math.max(0, progress));
}

function looksSecret(value: JsonValue): boolean {
  if (typeof value === "string") return SECRETISH.test(value);
  if (Array.isArray(value)) return value.some(looksSecret);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, inner]) => SECRETISH.test(key) || looksSecret(inner));
  }
  return false;
}

function coerceJob(item: unknown): DurableJob | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.title !== "string") return null;
  if (SECRETISH.test(rec.title)) return null;
  const state = JOB_STATES.includes(rec.state as JobState) ? (rec.state as JobState) : "queued";
  return {
    id: rec.id,
    title: rec.title.slice(0, 160),
    workspaceId: typeof rec.workspaceId === "string" ? rec.workspaceId : "general",
    ownerDeviceId: typeof rec.ownerDeviceId === "string" ? rec.ownerDeviceId : "unknown",
    state,
    progress: typeof rec.progress === "number" ? clamp(rec.progress) : 0,
    checkpoint: rec.checkpoint && typeof rec.checkpoint === "object" && !Array.isArray(rec.checkpoint) ? (rec.checkpoint as JsonObject) : undefined,
    summary: typeof rec.summary === "string" ? rec.summary : undefined,
    error: typeof rec.error === "string" ? rec.error : undefined,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : nowIso(),
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : nowIso(),
  };
}
