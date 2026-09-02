/**
 * Procedural memory: a repeatable method, not a permission.
 *
 * OpenHuman's useful idea is that some memories are *how to do a thing*, with steps,
 * not just facts. Vesper already has categories (`workflow`, `routine`). This is the
 * structured object those categories were missing: ordered steps, a lifecycle, and a
 * rule that being trusted does not let a procedure skip the tool gate.
 *
 * Lifecycle: CANDIDATE → REVIEWED → ACTIVE → SUPERSEDED | DISABLED
 *
 * A model may propose a candidate. It becomes reusable only after validation and an
 * explicit review. Execution of any step still goes through ToolRegistry.invoke.
 */

import { createId, nowIso } from "./id.ts";
import { prepareQuery, tokenize } from "./memory/retrieval.ts";
import type { StorageAdapter } from "./storage.ts";
import type { JsonValue, MemoryScopeLevel, PermissionLevel } from "./types.ts";

export const PROCEDURE_STATES = [
  "candidate",
  "reviewed",
  "active",
  "superseded",
  "disabled",
] as const;
export type ProcedureState = (typeof PROCEDURE_STATES)[number];

const KEY = "procedures.entries";
const MAX_PROCEDURES = 100;
const MAX_STEPS = 16;
const MAX_NAME = 120;
const MAX_TEXT = 2000;

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  read: 0,
  safe: 1,
  confirm: 2,
  never: 3,
};

export interface ProcedureStep {
  order: number;
  instruction: string;
  toolName?: string;
  permission: PermissionLevel;
}

export interface Procedure {
  id: string;
  name: string;
  purpose: string;
  steps: ProcedureStep[];
  requiredTools: string[];
  workspaceId?: string;
  scope: MemoryScopeLevel;
  permissionCeiling: PermissionLevel;
  successCriteria: string;
  provenance: { source: "user" | "agent"; origin: string };
  confidence: number;
  state: ProcedureState;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProcedureCatalog {
  permissionOf(toolName: string): PermissionLevel | undefined;
}

export interface ProposeProcedureInput {
  name: string;
  purpose: string;
  steps: Array<{ instruction: string; toolName?: string; permission?: PermissionLevel }>;
  workspaceId?: string;
  scope?: MemoryScopeLevel;
  successCriteria?: string;
  provenance: { source: "user" | "agent"; origin: string };
  confidence?: number;
}

export class ProcedureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcedureValidationError";
  }
}

export class ProcedureStore {
  private readonly storage: StorageAdapter;
  private readonly catalog: ProcedureCatalog;
  private loaded = false;
  private items = new Map<string, Procedure>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(storage: StorageAdapter, catalog: ProcedureCatalog) {
    this.storage = storage;
    this.catalog = catalog;
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
        const parsed = coerceProcedure(item);
        if (parsed) this.items.set(parsed.id, parsed);
      }
    } catch {
      this.items = new Map();
    }
  }

  private async persist(): Promise<void> {
    await this.storage.set(KEY, [...this.items.values()] as unknown as JsonValue).catch(() => undefined);
  }

  async propose(input: ProposeProcedureInput): Promise<Procedure> {
    return this.runExclusive(async () => {
      await this.load();
      if (this.items.size >= MAX_PROCEDURES) {
        throw new ProcedureValidationError(`Already holding ${MAX_PROCEDURES} procedures.`);
      }
      const built = buildProcedure(input, this.catalog);
      this.items.set(built.id, built);
      await this.persist();
      return { ...built, steps: built.steps.map((step) => ({ ...step })) };
    });
  }

  async review(id: string): Promise<Procedure> {
    return this.transition(id, "candidate", "reviewed");
  }

  async activate(id: string): Promise<Procedure> {
    return this.transition(id, "reviewed", "active");
  }

  async disable(id: string): Promise<Procedure> {
    return this.runExclusive(async () => {
      await this.load();
      const item = this.items.get(id);
      if (!item) throw new ProcedureValidationError("No such procedure.");
      if (item.state === "superseded") {
        throw new ProcedureValidationError("A superseded procedure stays superseded.");
      }
      item.state = "disabled";
      item.updatedAt = nowIso();
      await this.persist();
      return { ...item, steps: item.steps.map((step) => ({ ...step })) };
    });
  }

  async supersede(id: string, replacementId: string): Promise<Procedure> {
    return this.runExclusive(async () => {
      await this.load();
      const item = this.items.get(id);
      const replacement = this.items.get(replacementId);
      if (!item || !replacement) throw new ProcedureValidationError("No such procedure.");
      if (replacement.state !== "active") {
        throw new ProcedureValidationError("The replacement must already be active.");
      }
      item.state = "superseded";
      item.updatedAt = nowIso();
      await this.persist();
      return { ...item, steps: item.steps.map((step) => ({ ...step })) };
    });
  }

  async get(id: string): Promise<Procedure | undefined> {
    await this.runExclusive(async () => this.load());
    const item = this.items.get(id);
    return item ? { ...item, steps: item.steps.map((step) => ({ ...step })) } : undefined;
  }

  async list(filter?: { state?: ProcedureState; workspaceId?: string }): Promise<Procedure[]> {
    await this.runExclusive(async () => this.load());
    return [...this.items.values()]
      .filter((item) => (filter?.state ? item.state === filter.state : true))
      .filter((item) =>
        filter?.workspaceId
          ? item.workspaceId === filter.workspaceId || !item.workspaceId
          : true,
      )
      .map((item) => ({ ...item, steps: item.steps.map((step) => ({ ...step })) }));
  }

  /**
   * Deterministic ranking over ACTIVE procedures. Candidates are not reusable, so they
   * are not surfaced when the user asks to repeat a workflow.
   */
  async search(
    query: string,
    options?: { workspaceId?: string; limit?: number },
  ): Promise<Array<{ procedure: Procedure; score: number }>> {
    const prepared = prepareQuery(query, { workspaceId: options?.workspaceId });
    const active = await this.list({ state: "active", workspaceId: options?.workspaceId });
    if (!prepared) return active.slice(0, options?.limit ?? 4).map((procedure) => ({ procedure, score: 0 }));
    const ranked = active
      .map((procedure) => ({ procedure, score: scoreProcedure(procedure, prepared.tokens, prepared.raw) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.procedure.name.localeCompare(b.procedure.name));
    return ranked.slice(0, options?.limit ?? 4);
  }

  private async transition(id: string, from: ProcedureState, to: ProcedureState): Promise<Procedure> {
    return this.runExclusive(async () => {
      await this.load();
      const item = this.items.get(id);
      if (!item) throw new ProcedureValidationError("No such procedure.");
      if (item.state !== from) {
        throw new ProcedureValidationError(`Procedure is ${item.state}, not ${from}.`);
      }
      // Re-validate at promotion so a catalog change cannot leave an active
      // procedure pointing at a never-tier tool that did not exist at propose time.
      assertCatalogSafe(item, this.catalog);
      item.state = to;
      item.updatedAt = nowIso();
      await this.persist();
      return { ...item, steps: item.steps.map((step) => ({ ...step })) };
    });
  }
}

export function buildProcedure(input: ProposeProcedureInput, catalog: ProcedureCatalog): Procedure {
  const name = input.name.trim().slice(0, MAX_NAME);
  const purpose = input.purpose.trim().slice(0, MAX_TEXT);
  if (!name) throw new ProcedureValidationError("A procedure needs a name.");
  if (!purpose) throw new ProcedureValidationError("A procedure needs a purpose.");
  if (!input.steps.length) throw new ProcedureValidationError("A procedure needs at least one step.");
  if (input.steps.length > MAX_STEPS) {
    throw new ProcedureValidationError(`A procedure may have at most ${MAX_STEPS} steps.`);
  }

  const steps: ProcedureStep[] = input.steps.map((step, index) => {
    const instruction = step.instruction.trim().slice(0, MAX_TEXT);
    if (!instruction) throw new ProcedureValidationError(`Step ${index + 1} has no instruction.`);
    const toolName = step.toolName?.trim() || undefined;
    const declared = step.permission ?? "confirm";
    if (toolName) {
      const actual = catalog.permissionOf(toolName);
      if (!actual) {
        throw new ProcedureValidationError(`Step ${index + 1} names unknown tool '${toolName}'.`);
      }
      if (actual === "never") {
        throw new ProcedureValidationError(`Step ${index + 1} names a never-tier tool; procedures cannot hold those.`);
      }
      if (PERMISSION_RANK[declared] < PERMISSION_RANK[actual]) {
        throw new ProcedureValidationError(
          `Step ${index + 1} claims '${declared}' but '${toolName}' is '${actual}'.`,
        );
      }
    }
    return { order: index + 1, instruction, toolName, permission: declared };
  });

  const requiredTools = [...new Set(steps.map((step) => step.toolName).filter((name): name is string => Boolean(name)))];
  let ceiling: PermissionLevel = "read";
  for (const step of steps) {
    const actual = step.toolName ? catalog.permissionOf(step.toolName) ?? step.permission : step.permission;
    if (PERMISSION_RANK[actual] > PERMISSION_RANK[ceiling]) ceiling = actual;
  }

  const now = nowIso();
  const confidence = clamp01(input.confidence ?? (input.provenance.source === "user" ? 0.8 : 0.4));
  return {
    id: createId("proc"),
    name,
    purpose,
    steps,
    requiredTools,
    workspaceId: input.workspaceId,
    scope: input.scope ?? (input.workspaceId ? "workspace" : "user"),
    permissionCeiling: ceiling,
    successCriteria: (input.successCriteria ?? "").trim().slice(0, MAX_TEXT),
    provenance: input.provenance,
    confidence,
    state: "candidate",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function formatProcedure(procedure: Procedure): string {
  const steps = procedure.steps
    .map((step) => {
      const tool = step.toolName ? ` [${step.toolName}/${step.permission}]` : "";
      return `  ${step.order}. ${step.instruction}${tool}`;
    })
    .join("\n");
  return [
    `${procedure.name} (${procedure.state}, ceiling ${procedure.permissionCeiling})`,
    procedure.purpose,
    steps,
    procedure.successCriteria ? `success: ${procedure.successCriteria}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function assertCatalogSafe(procedure: Procedure, catalog: ProcedureCatalog): void {
  for (const step of procedure.steps) {
    if (!step.toolName) continue;
    const actual = catalog.permissionOf(step.toolName);
    if (!actual) throw new ProcedureValidationError(`Tool '${step.toolName}' is no longer registered.`);
    if (actual === "never") throw new ProcedureValidationError(`Tool '${step.toolName}' is never-tier.`);
    if (PERMISSION_RANK[step.permission] < PERMISSION_RANK[actual]) {
      throw new ProcedureValidationError(`Tool '${step.toolName}' is now '${actual}', stricter than the procedure claims.`);
    }
  }
}

function scoreProcedure(procedure: Procedure, tokens: string[], raw: string): number {
  const hay = `${procedure.name} ${procedure.purpose} ${procedure.steps.map((s) => s.instruction).join(" ")}`.toLowerCase();
  let score = 0;
  if (procedure.name.toLowerCase() === raw) score += 100;
  else if (procedure.name.toLowerCase().includes(raw)) score += 40;
  if (hay.includes(raw)) score += 20;
  const hayTokens = new Set(tokenize(hay));
  for (const token of tokens) {
    if (hayTokens.has(token)) score += 4;
  }
  score += procedure.confidence;
  return score;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function coerceProcedure(raw: unknown): Procedure | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Partial<Procedure>;
  if (typeof rec.id !== "string" || typeof rec.name !== "string" || typeof rec.purpose !== "string") return null;
  if (!Array.isArray(rec.steps) || rec.steps.length === 0) return null;
  const state = PROCEDURE_STATES.includes(rec.state as ProcedureState) ? (rec.state as ProcedureState) : "candidate";
  const steps: ProcedureStep[] = [];
  rec.steps.forEach((step, index) => {
    if (!step || typeof step !== "object") return;
    const instruction = typeof step.instruction === "string" ? step.instruction : "";
    if (!instruction) return;
    const permission: PermissionLevel =
      step.permission === "read" || step.permission === "safe" || step.permission === "confirm" || step.permission === "never"
        ? step.permission
        : "confirm";
    const built: ProcedureStep = {
      order: typeof step.order === "number" ? step.order : index + 1,
      instruction,
      permission,
    };
    if (typeof step.toolName === "string") built.toolName = step.toolName;
    steps.push(built);
  });
  if (!steps.length) return null;
  return {
    id: rec.id,
    name: rec.name,
    purpose: rec.purpose,
    steps,
    requiredTools: Array.isArray(rec.requiredTools)
      ? rec.requiredTools.filter((name): name is string => typeof name === "string")
      : [],
    workspaceId: typeof rec.workspaceId === "string" ? rec.workspaceId : undefined,
    scope: (["session", "device", "workspace", "user", "global"] as const).includes(rec.scope as MemoryScopeLevel)
      ? (rec.scope as MemoryScopeLevel)
      : "user",
    permissionCeiling:
      rec.permissionCeiling === "read" ||
      rec.permissionCeiling === "safe" ||
      rec.permissionCeiling === "confirm" ||
      rec.permissionCeiling === "never"
        ? rec.permissionCeiling
        : "confirm",
    successCriteria: typeof rec.successCriteria === "string" ? rec.successCriteria : "",
    provenance: {
      source: rec.provenance?.source === "user" ? "user" : "agent",
      origin: typeof rec.provenance?.origin === "string" ? rec.provenance.origin : "unknown",
    },
    confidence: typeof rec.confidence === "number" ? clamp01(rec.confidence) : 0.4,
    state,
    version: typeof rec.version === "number" ? rec.version : 1,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : nowIso(),
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : nowIso(),
  };
}
