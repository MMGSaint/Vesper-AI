/**
 * Personalization evaluation harness.
 *
 * Deterministic fixtures. Measures whether Vesper is correct *for this user*,
 * not whether a generic model is fluent.
 */

import { MemoryStorage } from "../storage.ts";
import { assembleContext } from "./assembly.ts";
import { KnowledgeGraph } from "./graph.ts";
import { InstinctStore } from "./instincts.ts";
import { JobStore } from "./jobs.ts";
import { classifyKind } from "./kinds.ts";
import { buildTaskPacket, packetContainsSecret, validateReturnedArtifact } from "./packet.ts";
import { planExecution } from "./route.ts";
import { reviseMemory } from "./revision.ts";
import type { MemoryEntry } from "../types.ts";

export interface EvalCase {
  id: string;
  area: "memory" | "context" | "firewall" | "instinct" | "workflow" | "safety";
  ok: boolean;
  detail: string;
}

export interface EvalReport {
  passed: number;
  failed: number;
  cases: EvalCase[];
}

function memory(partial: Partial<MemoryEntry> & { key: string; value: string }): MemoryEntry {
  return {
    id: partial.id ?? `mem_${partial.key}`,
    category: partial.category ?? "fact",
    key: partial.key,
    value: partial.value,
    createdAt: partial.createdAt ?? "2026-09-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-09-01T00:00:00.000Z",
    source: partial.source ?? "user",
    provenance: partial.provenance ?? { origin: "user", kind: "stated" },
    scope: partial.scope ?? "user",
    revision: partial.revision ?? 1,
    tags: partial.tags,
    workspaceId: partial.workspaceId,
    deviceId: partial.deviceId,
    originDevice: partial.originDevice,
  };
}

export async function runIntelligenceEval(): Promise<EvalReport> {
  const cases: EvalCase[] = [];

  const colour = memory({ key: "favourite-colour", value: "blue", category: "preference" });
  cases.push({
    id: "kind-preference",
    area: "memory",
    ok: classifyKind(colour) === "preference",
    detail: "preference category maps to preference kind",
  });

  const revision = reviseMemory(
    memory({ key: "editor", value: "vim", provenance: { origin: "user", kind: "stated" }, updatedAt: "2026-09-01T12:00:00.000Z" }),
    memory({ key: "editor", value: "emacs", provenance: { origin: "agent", kind: "inferred" }, updatedAt: "2026-09-02T12:00:00.000Z" }),
  );
  cases.push({
    id: "stated-outranks-inferred",
    area: "memory",
    ok: revision.action === "reject",
    detail: revision.reason,
  });

  const assembled = assembleContext({
    query: "favourite colour",
    memories: [
      colour,
      memory({ key: "api_key", value: "sk-live-not-this", category: "config" }),
      memory({ key: "scratch", value: "tmp", category: "session", scope: "session" }),
    ],
  });
  cases.push({
    id: "assembly-redacts-secrets",
    area: "context",
    ok: assembled.facts.some((f) => f.key === "favourite-colour") && assembled.facts.every((f) => f.key !== "api_key"),
    detail: "smallest context keeps the preference and drops the secret",
  });

  const packet = buildTaskPacket({
    task: "summarise the project",
    workspaceId: "dev",
    memories: [colour, memory({ key: "api_key", value: "sk-live-secret", category: "config" })],
    allowedCapabilities: ["search", "never", "shell"],
  });
  cases.push({
    id: "firewall-redacts",
    area: "firewall",
    ok: !packetContainsSecret(packet, "sk-live-secret") && !packet.allowedCapabilities.includes("never") && !packet.allowedCapabilities.includes("shell"),
    detail: "packet withholds secrets and never-tier capabilities",
  });

  const returned = validateReturnedArtifact({ executed: true, claimedTools: ["fs_write"] });
  cases.push({
    id: "firewall-return",
    area: "firewall",
    ok: returned.ok === false,
    detail: returned.reason,
  });

  const storage = new MemoryStorage();
  const instincts = new InstinctStore(storage);
  let instinct = await instincts.observe({ situation: "gaming workspace", action: "use the fast model" });
  instinct = await instincts.observe({ situation: "gaming workspace", action: "use the fast model" });
  instinct = await instincts.observe({ situation: "gaming workspace", action: "use the fast model" });
  const proposal = instincts.proposePreference(instinct);
  cases.push({
    id: "instinct-not-policy",
    area: "instinct",
    ok: instincts.isPolicy(instinct) === false && proposal.policy === false,
    detail: "a strengthened instinct is still a proposal, not a grant",
  });

  const plan = planExecution({
    intent: "stream setup",
    catalog: {
      procedures: [
        {
          id: "p1",
          name: "stream setup",
          purpose: "Prepare OBS for a stream",
          steps: [{ order: 1, instruction: "check OBS", permission: "read" }],
          requiredTools: ["obs_status"],
          scope: "workspace",
          permissionCeiling: "read",
          successCriteria: "OBS observed",
          provenance: { source: "user", origin: "test" },
          confidence: 0.9,
          state: "active",
          version: 1,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      skills: [],
      tools: [{ name: "obs_status", permission: "read" }],
    },
  });
  cases.push({
    id: "deterministic-first",
    area: "workflow",
    ok: plan.step === "procedure" && plan.executed === false,
    detail: plan.reason,
  });

  const jobs = new JobStore(storage);
  const job = await jobs.create({ title: "pack the build", workspaceId: "dev", ownerDeviceId: "dev_pc" });
  await jobs.checkpoint(job.id, { step: "compile" }, 0.4);
  const done = await jobs.complete(job.id, "packed");
  cases.push({
    id: "job-survives",
    area: "workflow",
    ok: done.state === "done" && done.progress === 1,
    detail: "durable job completes after a checkpoint",
  });

  const graph = new KnowledgeGraph(storage);
  const user = await graph.upsertNode({ type: "person", label: "user" });
  const vim = await graph.upsertNode({ type: "preference", label: "vim" });
  await graph.relate({ type: "prefers", from: user.id, to: vim.id });
  let threw = false;
  try {
    await graph.upsertNode({ type: "resource", label: "api_key sk-live" });
  } catch {
    threw = true;
  }
  cases.push({
    id: "graph-no-secrets",
    area: "safety",
    ok: threw,
    detail: "graph refuses secret-shaped labels",
  });

  const passed = cases.filter((item) => item.ok).length;
  return { passed, failed: cases.length - passed, cases };
}
