/**
 * External-agent data firewall.
 *
 * Cloud models and specialist agents receive a task packet, not Vesper's memory.
 * Secrets, private facts, never-tier capabilities, and untrusted content stay home
 * unless a documented allow-list says otherwise.
 */

import type { ContextTrust, MemoryEntry, PermissionLevel } from "../types.ts";
import { classifyKind } from "./kinds.ts";

export const PACKET_DATA_CLASSES = ["task", "public", "workspace", "personal", "secret"] as const;
export type PacketDataClass = (typeof PACKET_DATA_CLASSES)[number];

const SECRETISH = /(?:api[_-]?key|secret|password|token|credential|private[_-]?key|bearer|sk-live)/i;
const NEVER_CAPABILITIES = new Set(["shell", "raw_shell", "elevation", "disk_wipe", "credential_access"]);

export interface TaskPacket {
  task: string;
  workspaceId: string;
  allowedCapabilities: string[];
  allowedData: PacketDataClass[];
  context: { key: string; value: string; kind: string; trust: ContextTrust }[];
  expiresAt: string;
  output: string;
  redacted: number;
  withheld: { key: string; reason: string }[];
}

export interface PacketInput {
  task: string;
  workspaceId: string;
  memories: MemoryEntry[];
  allowedCapabilities: string[];
  allowedData?: PacketDataClass[];
  ttlMs?: number;
  output?: string;
  now?: () => Date;
}

export function buildTaskPacket(input: PacketInput): TaskPacket {
  const allowedData = input.allowedData ?? ["task", "workspace"];
  const capabilities = input.allowedCapabilities.filter((cap) => !NEVER_CAPABILITIES.has(cap) && cap !== "never");
  const withheld: { key: string; reason: string }[] = [];
  const context: TaskPacket["context"] = [];
  let redacted = 0;

  for (const entry of input.memories) {
    if (SECRETISH.test(entry.key) || SECRETISH.test(entry.value)) {
      withheld.push({ key: entry.key, reason: "secret-shaped" });
      redacted += 1;
      continue;
    }
    const kind = classifyKind(entry);
    if (kind === "core" || kind === "vault") {
      if (!allowedData.includes("personal")) {
        withheld.push({ key: entry.key, reason: "personal/core not in allow-list" });
        continue;
      }
    }
    if (entry.scope === "session" || entry.scope === "device") {
      withheld.push({ key: entry.key, reason: `${entry.scope} memory does not leave this node` });
      continue;
    }
    if (entry.provenance?.kind === "inferred" && !allowedData.includes("personal")) {
      withheld.push({ key: entry.key, reason: "inferred personal pattern withheld" });
      continue;
    }
    if ((entry.tags ?? []).includes("untrusted") || entry.provenance?.origin === "web") {
      withheld.push({ key: entry.key, reason: "untrusted content is not delegated" });
      continue;
    }
    const trust: ContextTrust =
      entry.provenance?.kind === "stated" ? "user" : entry.source === "system" ? "system" : "trusted_local";
    context.push({
      key: entry.key,
      value: clip(entry.value, 240),
      kind,
      trust,
    });
  }

  const ttl = Math.min(Math.max(input.ttlMs ?? 15 * 60 * 1000, 30_000), 24 * 3600 * 1000);
  const now = input.now?.() ?? new Date();
  return {
    task: clip(input.task, 400),
    workspaceId: input.workspaceId,
    allowedCapabilities: capabilities.slice(0, 16),
    allowedData,
    context: context.slice(0, 12),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    output: input.output ?? "summary",
    redacted,
    withheld,
  };
}

export function validateReturnedArtifact(artifact: {
  summary?: string;
  claimedTools?: string[];
  claimedGrant?: boolean;
  executed?: boolean;
}): { ok: boolean; reason: string } {
  if (artifact.executed) return { ok: false, reason: "an external agent cannot claim a local tool executed" };
  if (artifact.claimedGrant) return { ok: false, reason: "an external agent cannot grant permissions" };
  if ((artifact.claimedTools ?? []).some((name) => NEVER_CAPABILITIES.has(name))) {
    return { ok: false, reason: "returned artifact named a never-tier capability" };
  }
  return { ok: true, reason: "accepted as data" };
}

export function packetContainsSecret(packet: TaskPacket, needle: string): boolean {
  return packet.context.some((item) => item.value.includes(needle) || item.key.includes(needle));
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function permissionAllowedInPacket(level: PermissionLevel): boolean {
  return level === "read" || level === "safe";
}
