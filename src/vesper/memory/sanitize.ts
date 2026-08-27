import { createId, nowIso } from "../id.ts";
import {
  MEMORY_CATEGORIES,
  MEMORY_SCOPES,
  type MemoryCategory,
  type MemoryEntry,
  type MemoryScopeLevel,
} from "../types.ts";
import { defaultScopeFor } from "./scopes.ts";

export type CoercionResult =
  | { ok: true; entry: MemoryEntry; repaired: string[] }
  | { ok: false; reason: string };

/**
 * Persisted memory is user-editable JSON on disk. Every field is therefore treated as
 * hostile input: anything repairable is repaired, and only an entry with no usable
 * key/value pair is rejected, so one bad record cannot take the store down with it.
 */
export function coerceMemoryEntry(item: unknown, defaultOrigin: string): CoercionResult {
  if (item === null || typeof item !== "object") {
    return { ok: false, reason: `expected an object, got ${item === null ? "null" : typeof item}` };
  }
  if (Array.isArray(item)) return { ok: false, reason: "expected an object, got an array" };
  const rec = item as Record<string, unknown>;
  if (typeof rec.key !== "string" || rec.key.trim().length === 0) {
    return { ok: false, reason: "missing a usable string 'key'" };
  }
  if (typeof rec.value !== "string") return { ok: false, reason: "missing a string 'value'" };

  const repaired: string[] = [];
  let category: MemoryCategory = "fact";
  if (MEMORY_CATEGORIES.includes(rec.category as MemoryCategory)) {
    category = rec.category as MemoryCategory;
  } else {
    repaired.push("category");
  }

  let source: MemoryEntry["source"] = "user";
  if (rec.source === "agent" || rec.source === "seed" || rec.source === "system" || rec.source === "user") {
    source = rec.source;
  } else if (rec.source !== undefined) {
    repaired.push("source");
  }

  const createdAt = isIsoLike(rec.createdAt) ? rec.createdAt : null;
  const updatedAt = isIsoLike(rec.updatedAt) ? rec.updatedAt : null;
  if (!createdAt || !updatedAt) repaired.push("timestamps");

  let id = typeof rec.id === "string" && rec.id.length > 0 ? rec.id : null;
  if (!id) {
    id = createId("mem");
    repaired.push("id");
  }

  let tags: string[] | undefined;
  if (Array.isArray(rec.tags)) {
    tags = rec.tags.filter((tag): tag is string => typeof tag === "string");
    if (tags.length !== rec.tags.length) repaired.push("tags");
    if (tags.length === 0) tags = undefined;
  } else if (rec.tags !== undefined) {
    repaired.push("tags");
  }

  let provenance: MemoryEntry["provenance"] = { origin: defaultOrigin, kind: "stated" };
  if (rec.provenance && typeof rec.provenance === "object" && !Array.isArray(rec.provenance)) {
    const raw = rec.provenance as { origin?: unknown; kind?: unknown };
    const kind = raw.kind === "stated" || raw.kind === "observed" || raw.kind === "inferred" ? raw.kind : "stated";
    provenance = { origin: typeof raw.origin === "string" ? raw.origin : defaultOrigin, kind };
    if (kind !== raw.kind || typeof raw.origin !== "string") repaired.push("provenance");
  } else if (rec.provenance !== undefined) {
    repaired.push("provenance");
  }

  const deviceId = typeof rec.deviceId === "string" && rec.deviceId ? rec.deviceId : undefined;
  let scope: MemoryScopeLevel;
  if (MEMORY_SCOPES.includes(rec.scope as MemoryScopeLevel)) {
    scope = rec.scope as MemoryScopeLevel;
  } else {
    // An entry written before scopes existed, or a corrupted one. Derive rather than
    // discard: guessing conservatively keeps the fact, and never promotes a device fact.
    scope = defaultScopeFor({
      category,
      workspaceId: typeof rec.workspaceId === "string" ? rec.workspaceId : undefined,
      deviceId,
    });
    if (rec.scope !== undefined) repaired.push("scope");
  }

  let revision = 1;
  if (typeof rec.revision === "number" && Number.isFinite(rec.revision) && rec.revision >= 1) {
    revision = Math.floor(rec.revision);
  } else if (rec.revision !== undefined) {
    repaired.push("revision");
  }

  const now = nowIso();
  return {
    ok: true,
    repaired,
    entry: {
      id,
      category,
      key: rec.key,
      value: rec.value,
      workspaceId: typeof rec.workspaceId === "string" ? rec.workspaceId : undefined,
      createdAt: createdAt ?? updatedAt ?? now,
      updatedAt: updatedAt ?? createdAt ?? now,
      source,
      tags,
      provenance,
      scope,
      // Only a device-scoped entry keeps a deviceId; anything else carrying one was
      // either corrupted or an attempt to smuggle attribution onto a user fact.
      deviceId: scope === "device" ? deviceId : undefined,
      revision,
      originDevice: typeof rec.originDevice === "string" ? rec.originDevice : undefined,
    },
  };
}

function isIsoLike(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
