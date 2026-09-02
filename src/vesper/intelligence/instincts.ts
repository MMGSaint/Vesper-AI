/**
 * Instincts — inferred patterns, never policy.
 *
 * Lifecycle: observation → pattern → candidate instinct → (optional) preference proposal.
 * Explicit user preferences always outrank instincts. An instinct cannot name a
 * permission, a tool grant, or an autonomy level.
 */

import { createId, nowIso } from "../id.ts";
import type { JsonValue } from "../types.ts";
import type { StorageAdapter } from "../storage.ts";

export const INSTINCT_STATES = ["observing", "candidate", "strengthened", "decayed", "proposed"] as const;
export type InstinctState = (typeof INSTINCT_STATES)[number];

const KEY = "intelligence.instincts";
const MAX_INSTINCTS = 80;
const MAX_EVIDENCE = 12;
const FORBIDDEN = /(?:permission|never-tier|autonomy|grant|elevat|bypass|tool\s+allow)/i;
const THRESHOLD = 3;

export interface InstinctEvidence {
  at: string;
  situation: string;
  action: string;
  workspaceId?: string;
}

export interface Instinct {
  id: string;
  situation: string;
  action: string;
  workspaceId?: string;
  confidence: number;
  evidence: InstinctEvidence[];
  state: InstinctState;
  createdAt: string;
  updatedAt: string;
}

export class InstinctError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstinctError";
  }
}

export class InstinctStore {
  private readonly storage: StorageAdapter;
  private loaded = false;
  private items = new Map<string, Instinct>();
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
      const instinct = coerceInstinct(item);
      if (instinct) this.items.set(instinct.id, instinct);
    }
  }

  private async persist(): Promise<void> {
    await this.storage.set(KEY, [...this.items.values()] as unknown as JsonValue);
  }

  async observe(input: { situation: string; action: string; workspaceId?: string; at?: string }): Promise<Instinct> {
    return this.run(async () => {
      await this.load();
      const situation = clip(input.situation, 160);
      const action = clip(input.action, 160);
      if (!situation || !action) throw new InstinctError("An observation needs a situation and an action.");
      if (FORBIDDEN.test(situation) || FORBIDDEN.test(action)) {
        throw new InstinctError("An instinct cannot describe a permission, grant, or autonomy change.");
      }
      const key = fingerprint(situation, action, input.workspaceId);
      let instinct = [...this.items.values()].find((item) => fingerprint(item.situation, item.action, item.workspaceId) === key);
      const evidence: InstinctEvidence = {
        at: input.at ?? nowIso(),
        situation,
        action,
        workspaceId: input.workspaceId,
      };
      if (!instinct) {
        if (this.items.size >= MAX_INSTINCTS) throw new InstinctError("Instinct cap reached.");
        instinct = {
          id: createId("inst"),
          situation,
          action,
          workspaceId: input.workspaceId,
          confidence: 0.15,
          evidence: [evidence],
          state: "observing",
          createdAt: evidence.at,
          updatedAt: evidence.at,
        };
      } else {
        instinct = {
          ...instinct,
          evidence: [...instinct.evidence, evidence].slice(-MAX_EVIDENCE),
          updatedAt: evidence.at,
        };
        instinct.confidence = Math.min(0.85, 0.15 + instinct.evidence.length * 0.12);
        if (instinct.evidence.length >= THRESHOLD && instinct.state === "observing") {
          instinct.state = "candidate";
        } else if (instinct.evidence.length >= THRESHOLD + 2) {
          instinct.state = "strengthened";
        }
      }
      this.items.set(instinct.id, instinct);
      await this.persist();
      return instinct;
    });
  }

  async decay(id: string): Promise<Instinct> {
    return this.run(async () => {
      await this.load();
      const instinct = this.items.get(id);
      if (!instinct) throw new InstinctError("Unknown instinct.");
      const next: Instinct = {
        ...instinct,
        confidence: Math.max(0, instinct.confidence - 0.2),
        state: instinct.confidence - 0.2 <= 0.2 ? "decayed" : instinct.state,
        updatedAt: nowIso(),
      };
      this.items.set(id, next);
      await this.persist();
      return next;
    });
  }

  /**
   * A proposal the person can accept as a preference. This function never writes
   * the preference itself and never changes a permission.
   */
  proposePreference(instinct: Instinct): { kind: "preference-proposal"; text: string; policy: false } {
    if (instinct.state === "observing" || instinct.confidence < 0.4) {
      throw new InstinctError("Not enough evidence to propose a preference.");
    }
    return {
      kind: "preference-proposal",
      text: `When ${instinct.situation}, prefer ${instinct.action}.`,
      policy: false,
    };
  }

  isPolicy(_instinct: Instinct): false {
    return false;
  }

  async list(): Promise<Instinct[]> {
    await this.load();
    return [...this.items.values()];
  }
}

function fingerprint(situation: string, action: string, workspaceId?: string): string {
  return `${(workspaceId ?? "").toLowerCase()}|${situation.toLowerCase()}|${action.toLowerCase()}`;
}

function clip(text: string, max: number): string {
  return text.trim().slice(0, max);
}

function coerceInstinct(item: unknown): Instinct | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.situation !== "string" || typeof rec.action !== "string") return null;
  if (FORBIDDEN.test(rec.situation) || FORBIDDEN.test(rec.action)) return null;
  const state = INSTINCT_STATES.includes(rec.state as InstinctState) ? (rec.state as InstinctState) : "observing";
  const evidence = Array.isArray(rec.evidence)
    ? rec.evidence
        .filter((row): row is InstinctEvidence => {
          if (!row || typeof row !== "object") return false;
          const e = row as Record<string, unknown>;
          return typeof e.at === "string" && typeof e.situation === "string" && typeof e.action === "string";
        })
        .slice(-MAX_EVIDENCE)
    : [];
  return {
    id: rec.id,
    situation: rec.situation.slice(0, 160),
    action: rec.action.slice(0, 160),
    workspaceId: typeof rec.workspaceId === "string" ? rec.workspaceId : undefined,
    confidence: typeof rec.confidence === "number" ? Math.min(0.85, Math.max(0, rec.confidence)) : 0.15,
    evidence,
    state,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : nowIso(),
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : nowIso(),
  };
}
