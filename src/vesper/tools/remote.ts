/**
 * What a turn driven by another device may reach on this one.
 *
 * A remote device talks to Vesper by having a conversation, and a conversation can call
 * tools. So "a phone may converse" quietly means "a phone may call whatever the agent
 * decides to call" unless something narrows it here. That is the gap this module
 * closes: the capability layer already declares that OS authority never crosses the
 * wire, but nothing was asking it at the point tools actually run.
 *
 * This can only ever narrow. It runs after the permission gate has already decided,
 * and it can turn an allow into a deny — never the reverse. A remote device, the model,
 * and the UI are all incapable of widening what the gate permits; only configuration
 * can do that.
 */

import {
  decideRemoteRequest,
  type Capability,
  type CapabilityManifest,
} from "../distributed/capabilities.ts";
import type { TrustState } from "../distributed/identity.ts";
import type { ClientScope } from "../client/protocol.ts";

/** Who is driving this turn. Absent means the person at this machine. */
export interface RequestOrigin {
  kind: "local" | "remote";
  deviceId?: string;
  trust?: TrustState;
  manifest?: CapabilityManifest | null;
  /**
   * The scopes the driving session actually holds.
   *
   * Absent on a remote origin means "no scopes established", not "all of them": a
   * request whose authority cannot be established gets none.
   */
  scopes?: readonly ClientScope[];
}

/**
 * Tools that administer Vesper's own trust and authority.
 *
 * These are host-only for a reason distinct from OS authority: a remote device that can
 * change trust states can promote itself or another device, which turns a single stolen
 * phone into permanent access. Trust is granted at the machine, by the person.
 */
export const HOST_ONLY_TOOLS: readonly string[] = [
  "device_trust",
  // Registering, removing, or reindexing a knowledge source decides which directories
  // Vesper will read from disk. That is filesystem policy, and policy is set at the
  // machine — a remote device that could widen it would have found the long way round
  // to the filesystem authority it is never granted directly.
  "knowledge_register",
  "knowledge_remove",
  "knowledge_reindex",
];

/**
 * Tools that exercise a client scope.
 *
 * The gateway checks scopes on its own methods, but a conversation is a tool-calling
 * loop and tools are not gateway methods — so a device holding only `conversation`
 * reached exactly the data its missing scopes describe: private memory without
 * memory.read, indexed file contents without knowledge.read, and memory writes without
 * memory.write. Two authorization models with no single owner drift the moment one of
 * them is not consulted. This is where they meet.
 */
const TOOL_SCOPE: Readonly<Record<string, ClientScope>> = {
  memory_search: "memory.read",
  memory_remember: "memory.write",
  memory_forget: "memory.write",
  knowledge_search: "knowledge.read",
  notify: "notifications",
};

export function scopeForTool(toolName: string): ClientScope | null {
  return TOOL_SCOPE[toolName] ?? null;
}

/**
 * Which capability a tool exercises. Tools with no entry are not capability-bearing —
 * memory, knowledge and status are governed by client scopes instead, and adding them
 * here would double-govern them inconsistently.
 */
const TOOL_CAPABILITY: Readonly<Record<string, Capability>> = {
  fs_read: "filesystem",
  fs_write: "filesystem",
  fs_list: "filesystem",
  process_list: "process_inspect",
  app_launch: "app_launch",
  app_close: "app_launch",
  app_detect: "app_launch",
  optimizer_status: "nexus",
  optimizer_analyze: "nexus",
  optimizer_report: "nexus",
  optimizer_request: "nexus",
  obs_status: "obs",
  set_scenario: "vrchat",
  benchmark_run: "task_execute",
};

export function capabilityForTool(toolName: string): Capability | null {
  return TOOL_CAPABILITY[toolName] ?? null;
}

export interface RemoteToolDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Decide whether a tool may run on behalf of a remote device.
 *
 * Order matters, and mirrors `decideRemoteRequest`: the absolute denials are checked
 * before trust is consulted, so no trust class — including `trusted`, because a trusted
 * *device* is still a different machine — can reach them.
 */
export function decideRemoteToolRequest(input: {
  toolName: string;
  origin: RequestOrigin;
}): RemoteToolDecision {
  if (input.origin.kind !== "remote") {
    return { allowed: true, reason: "Local request." };
  }

  if (HOST_ONLY_TOOLS.includes(input.toolName)) {
    return {
      allowed: false,
      reason: `'${input.toolName}' administers device trust and can only be run at the machine itself.`,
    };
  }

  // A trust floor that applies to every tool, capability-bearing or not.
  //
  // Without this, a tool with no capability mapping skipped the trust check entirely and
  // a revoked device's request was still honoured — the session layer happened to be the
  // only thing refusing it, and a held confirmation outlives the session that queued it.
  // Revocation has to mean the same thing at every layer that can act on a request.
  const trust = input.origin.trust ?? "unknown";
  if (trust !== "trusted" && trust !== "restricted") {
    return {
      allowed: false,
      reason: `A '${trust}' device may not have '${input.toolName}' run on its behalf.`,
    };
  }

  // Scope-governed tools answer to the session's scopes wherever they are reached from,
  // not only through the gateway method that happens to share their name.
  const scope = scopeForTool(input.toolName);
  if (scope) {
    const held = input.origin.scopes ?? [];
    if (!held.includes(scope)) {
      return {
        allowed: false,
        reason: `'${input.toolName}' needs the '${scope}' scope, which this session does not hold.`,
      };
    }
  }

  const capability = capabilityForTool(input.toolName);
  if (!capability) {
    return { allowed: true, reason: "Not a capability-bearing tool." };
  }

  const decision = decideRemoteRequest({
    trust: input.origin.trust ?? "unknown",
    capability,
    manifest: input.origin.manifest ?? null,
  });
  return { allowed: decision.allowed, reason: decision.reason };
}
