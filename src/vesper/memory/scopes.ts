/**
 * Memory scope rules.
 *
 * Visibility and syncability live here rather than in the store so the sync engine and
 * the store cannot drift apart. A disagreement between them would be a data-integrity
 * bug: one side deciding a device fact is user-global is how "my desktop has a 7900 XT"
 * becomes something Vesper believes about the laptop.
 */

import type { MemoryCategory, MemoryEntry, MemoryScopeLevel } from "../types.ts";

export interface ScopeContext {
  /** The device asking. Device-scoped facts about other devices stay attributed. */
  deviceId?: string;
  workspaceId?: string;
}

/** Session memory never reaches disk, so it can never reach another device either. */
export function isPersistable(scope: MemoryScopeLevel): boolean {
  return scope !== "session";
}

export function isSyncable(scope: MemoryScopeLevel): boolean {
  return scope !== "session";
}

/**
 * Derive a scope when a caller did not state one.
 *
 * `category: "session"` predates scopes and already meant "in memory only", so it keeps
 * that meaning. Everything else defaults to `user`: a plain "remember that I stream on
 * Fridays" is about the person, not the machine they happened to say it on.
 */
export function defaultScopeFor(input: {
  category: MemoryCategory;
  workspaceId?: string;
  deviceId?: string;
}): MemoryScopeLevel {
  if (input.category === "session") return "session";
  if (input.category === "config" && input.deviceId) return "device";
  if (input.workspaceId) return "workspace";
  return "user";
}

/**
 * Can this entry be seen from the asking context?
 *
 * A device-scoped entry belonging to another device is *not* hidden - Vesper may need to
 * say "your desktop has a 7900 XT" from the laptop - but callers get it labelled by
 * `deviceId` so it can never be read as a fact about the current machine.
 */
export function isVisibleFrom(entry: MemoryEntry, context: ScopeContext): boolean {
  switch (entry.scope) {
    case "session":
      return true;
    case "device":
      return true;
    case "workspace":
      // Workspace facts stay inside their workspace unless no workspace was asked for.
      if (!context.workspaceId) return true;
      return !entry.workspaceId || entry.workspaceId === context.workspaceId;
    case "user":
    case "global":
      return true;
    default:
      // An unknown scope is treated as the most restrictive thing it could be.
      return false;
  }
}

/** True when the entry describes a machine other than the one asking. */
export function describesAnotherDevice(entry: MemoryEntry, context: ScopeContext): boolean {
  return (
    entry.scope === "device" &&
    Boolean(entry.deviceId) &&
    Boolean(context.deviceId) &&
    entry.deviceId !== context.deviceId
  );
}

/**
 * How a fact should be phrased back. Device facts about another machine must name it,
 * otherwise Vesper states another device's hardware as though it were this one's.
 */
export function attribute(entry: MemoryEntry, context: ScopeContext): string {
  const parts: string[] = [];
  if (describesAnotherDevice(entry, context)) parts.push(`on ${entry.deviceId}`);
  // A fact the assistant inferred is not a fact the user stated, and the difference has
  // to survive into the prompt or recording it is bookkeeping nobody reads. Without this
  // an invented memory came back on every later turn indistinguishable from something
  // the user really said — which is how an invention becomes a remembered fact.
  if (entry.provenance?.kind === "inferred") parts.push("inferred by the assistant, not stated");
  return parts.length > 0 ? `${entry.value} (${parts.join("; ")})` : entry.value;
}
