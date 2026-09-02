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

/**
 * Who is driving this turn. Absent means the person at this machine.
 *
 * `scheduled` is the runtime driving itself: a queued task that came due while nobody
 * was watching. It is deliberately its OWN kind rather than a flavour of `local`,
 * because "the person at this machine asked for this" and "a timer fired" are different
 * claims and only one of them can answer a confirmation prompt.
 */
export interface RequestOrigin {
  kind: "local" | "remote" | "scheduled";
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
  // `notify` writes into the owner's notification hub, and the only scope that named it
  // — `notifications` — is a *read* scope whose own gateway method returns recent items
  // and which every default companion holds. Mapping a write to a read scope made a
  // phishing primitive out of a default grant: a companion could plant a `system`-kind
  // notification in the owner's hub, in Vesper's voice, saying whatever it liked. There
  // is no notifications.write scope to map it to, and inventing one would hand the same
  // capability out under a new name.
  "notify",
];

/**
 * Tools that change state belonging to the person at the machine.
 *
 * `workspace_switch` moves the *owner's* active workspace: their next local turn runs in
 * whatever workspace a remote device chose, which decides the tool list, the scoping of
 * memory and knowledge retrieval, and the default model role. A restricted device — the
 * portable class, running on a host whose surroundings cannot be vouched for — was able
 * to do that silently, because a tool with no capability mapping fell through to
 * "allowed". Pausing and resuming the host's background runtime is the same shape.
 *
 * A trusted device may still do these: switching workspace from your own phone is the
 * feature. What must not happen is a restricted one doing it.
 */
const TRUSTED_ONLY_TOOLS: readonly string[] = [
  "workspace_switch",
  "runtime_pause",
  "runtime_resume",
  // The task queue is the owner's private work list. Descriptions are free text the
  // owner wrote — "wipe the drive holding the tax records; passphrase is in the safe" is
  // the shape of a real entry — and `task_list` returns every one of them with no scope
  // mapping at all, so it fell through to "allowed" for a device holding nothing but
  // `conversation`. A trusted phone reading its owner's task list is the feature; a
  // restricted one, on a host Vesper cannot vouch for, is disclosure.
  "task_list",
  "task_create",
  // A rollback reverses a change Vesper made to the owner's own state — a workspace
  // switch, a memory write. `workspace_switch` is trusted-only above, so reaching the
  // same effect through `rollback_apply` must not be an easier path: a restricted
  // device that could reverse a workspace switch has moved the owner's state without
  // ever holding the authority to move it forward. `rollback_list` is here for the
  // same reason `task_list` is — the target names and pre-image summaries it returns
  // describe the owner's private activity.
  "rollback_apply",
  "rollback_list",
  // The decision journal is the owner's private audit of what Vesper authorised.
  // A trusted phone asking "why did you do that" is the feature; a restricted one
  // reading it is disclosure of the same activity `task_list` already hides.
  "governor_decisions",
  "job_list",
  "job_create",
  "job_cancel",
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
  // A correction names the workspace context an expectation was formed in and quotes
  // what a specialist observed. A tool with no entry here is remote-reachable by
  // default for any trusted or restricted device, so this is stated rather than left
  // to the fall-through.
  corrections_list: "memory.read",
  context_now: "memory.read",
  instinct_list: "memory.read",
  instinct_observe: "memory.write",
  graph_relate: "memory.write",
  vesper_route: "memory.read",
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
 * Decide whether a tool may run for a task the scheduler is driving.
 *
 * The governing rule is the mission's: **a task being queued or scheduled is not
 * authorization.** Whoever queued the task had some authority at that moment; the task
 * record is not a bearer token for it, and the scheduler must not be a way to launder
 * "I asked for this once" into "run it unattended later".
 *
 * So a scheduled request may reach strictly less than a person at the keyboard:
 *
 *   - Nothing that administers Vesper's own trust. A timer must never promote a device.
 *   - Nothing on the trusted-only list. Those change state belonging to the machine's
 *     owner, and the owner is not here.
 *
 * The other half of the rule — that a confirm-tier tool cannot run unattended — is
 * enforced in `ToolRegistry.invoke`, because only the registry has the gate's decision
 * and therefore knows the tool's effective level after any user override. Splitting it
 * that way keeps this function a pure function of the tool NAME, which is what makes it
 * exhaustively testable.
 */
export function decideScheduledToolRequest(toolName: string): RemoteToolDecision {
  if (HOST_ONLY_TOOLS.includes(toolName)) {
    return {
      allowed: false,
      reason: `'${toolName}' administers device trust and is never run by a scheduled task.`,
    };
  }
  if (TRUSTED_ONLY_TOOLS.includes(toolName)) {
    return {
      allowed: false,
      reason: `'${toolName}' changes state belonging to the machine's owner, so a scheduled task may not run it.`,
    };
  }
  return { allowed: true, reason: "Scheduled request within the unattended tool set." };
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
  // Deny by default on the kind itself. The previous shape was
  // `if (kind !== "remote") return allowed` — which reads as "local is fine" but
  // actually means "anything that is not remote is fully authorized", so adding any new
  // origin kind silently granted it the authority of the person at the keyboard. Each
  // kind now has to say what it is allowed to do, and an unrecognised one is refused.
  if (input.origin.kind === "local") {
    return { allowed: true, reason: "Local request." };
  }
  if (input.origin.kind === "scheduled") {
    return decideScheduledToolRequest(input.toolName);
  }
  if (input.origin.kind !== "remote") {
    return {
      allowed: false,
      reason: `Unrecognised request origin; refusing '${input.toolName}'.`,
    };
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

  if (TRUSTED_ONLY_TOOLS.includes(input.toolName) && trust !== "trusted") {
    return {
      allowed: false,
      reason: `'${input.toolName}' changes state belonging to the machine's owner, so a '${trust}' device may not run it.`,
    };
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
