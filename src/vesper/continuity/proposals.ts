/**
 * Skill propose → scan → apply → rollback, bound to a manifest hash.
 *
 * Enabling a skill is still a separate, explicit act on SkillRegistry.
 * Applying a proposal does not grant tools. If the target hash changes
 * before apply, the proposal becomes stale.
 */

import { createHash } from "node:crypto";
import { createId, nowIso } from "../id.ts";
import type { SkillManifest, SkillRecord, SkillRegistry } from "../skills.ts";
import type { StorageAdapter } from "../storage.ts";
import type { JsonValue } from "../types.ts";

const KEY = "continuity.skill-proposals";
const MAX = 32;

export const PROPOSAL_STATES = ["proposed", "scanned", "stale", "applied", "rolled_back"] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export interface SkillProposal {
  id: string;
  skillId: string;
  targetHash: string;
  snapshot: SkillManifest;
  previous?: SkillManifest;
  state: ProposalState;
  createdAt: string;
  updatedAt: string;
}

export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

export function hashManifest(manifest: SkillManifest): string {
  const canonical = JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    requiredTools: [...manifest.requiredTools].sort(),
    requiredCapabilities: [...manifest.requiredCapabilities].sort(),
    requiredBinaries: [...manifest.requiredBinaries].sort(),
    requiredEnvironment: [...manifest.requiredEnvironment].sort(),
    platforms: [...manifest.platforms].sort(),
    trust: manifest.trust,
    network: "network" in manifest ? (manifest as SkillManifest & { network?: string }).network ?? "none" : "none",
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class SkillProposalStore {
  private readonly storage: StorageAdapter;
  private loaded = false;
  private items = new Map<string, SkillProposal>();
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
      const parsed = coerce(item);
      if (parsed) this.items.set(parsed.id, parsed);
    }
  }

  private async persist(): Promise<void> {
    await this.storage.set(KEY, [...this.items.values()] as unknown as JsonValue);
  }

  async propose(skill: SkillRecord): Promise<SkillProposal> {
    return this.run(async () => {
      await this.load();
      if (this.items.size >= MAX) throw new ProposalError("Proposal cap reached.");
      const now = nowIso();
      const proposal: SkillProposal = {
        id: createId("prop"),
        skillId: skill.id,
        targetHash: hashManifest(skill.manifest),
        snapshot: { ...skill.manifest, requiredTools: [...skill.manifest.requiredTools] },
        state: "proposed",
        createdAt: now,
        updatedAt: now,
      };
      this.items.set(proposal.id, proposal);
      await this.persist();
      return { ...proposal, snapshot: { ...proposal.snapshot } };
    });
  }

  async apply(id: string, skills: SkillRegistry): Promise<SkillProposal> {
    return this.run(async () => {
      await this.load();
      const proposal = this.items.get(id);
      if (!proposal) throw new ProposalError("Unknown proposal.");
      if (proposal.state === "rolled_back") throw new ProposalError("A rolled-back proposal cannot apply.");
      const current = await skills.get(proposal.skillId);
      if (!current) throw new ProposalError("The target skill is gone.");
      const liveHash = hashManifest(current.manifest);
      if (liveHash !== proposal.targetHash) {
        proposal.state = "stale";
        proposal.updatedAt = nowIso();
        await this.persist();
        throw new ProposalError("Proposal is stale: the skill hash changed before apply.");
      }
      proposal.previous = { ...current.manifest };
      proposal.state = "applied";
      proposal.updatedAt = nowIso();
      await this.persist();
      return { ...proposal };
    });
  }

  async rollback(id: string): Promise<SkillProposal> {
    return this.run(async () => {
      await this.load();
      const proposal = this.items.get(id);
      if (!proposal) throw new ProposalError("Unknown proposal.");
      if (proposal.state !== "applied") throw new ProposalError("Only an applied proposal can roll back.");
      proposal.state = "rolled_back";
      proposal.updatedAt = nowIso();
      await this.persist();
      return { ...proposal };
    });
  }

  async list(): Promise<SkillProposal[]> {
    await this.load();
    return [...this.items.values()].map((item) => ({ ...item }));
  }
}

function coerce(raw: unknown): SkillProposal | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.skillId !== "string" || typeof rec.targetHash !== "string") return null;
  const state = PROPOSAL_STATES.includes(rec.state as ProposalState) ? (rec.state as ProposalState) : "proposed";
  if (!rec.snapshot || typeof rec.snapshot !== "object") return null;
  return {
    id: rec.id,
    skillId: rec.skillId,
    targetHash: rec.targetHash,
    snapshot: rec.snapshot as SkillManifest,
    previous: rec.previous as SkillManifest | undefined,
    state,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : nowIso(),
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : nowIso(),
  };
}
