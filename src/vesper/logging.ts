import type { AuditEntry, JsonObject, JsonValue } from "./types.ts";
import { looksLikeSecretValue } from "./security.ts";

const SECRET_KEY =
  /(pass(word)?|secret|token|api[_-]?key|authorization|credential|cookie)/i;

/**
 * How deep redaction will walk before it stops describing a value and starts refusing it.
 *
 * Without a cap the walk is bounded only by the shape of its input: a deeply nested tool
 * argument blows the stack, and a cyclic object - which nothing in the type system
 * prevents at runtime - never terminates. Either one takes the process down from inside
 * the logger, which is the last component that should be able to do that.
 *
 * Past the cap the value is replaced, not passed through: an unwalked value may contain
 * secrets, so the safe answer is to drop it.
 */
const MAX_REDACT_DEPTH = 8;
const TOO_DEEP = "[too-deep]";

/** Entries kept in memory for `recent()`. Vesper runs for days; the file sink is the archive. */
const DEFAULT_MAX_ENTRIES = 1_000;

const SECRET_IN_TEXT =
  /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._\-]+)\b/gi;

function redactValue(key: string, value: JsonValue, depth: number): JsonValue {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string" && looksLikeSecretValue(value)) return "[redacted]";
  if (depth >= MAX_REDACT_DEPTH) {
    // Scalars are already fully inspected above, so only containers are refused here.
    return value !== null && typeof value === "object" ? TOO_DEEP : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item, depth + 1));
  if (value && typeof value === "object") {
    return redactAt(value as JsonObject, depth + 1);
  }
  return value;
}

function redactAt(input: JsonObject, depth: number): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = redactValue(key, value, depth);
  }
  return out;
}

export function redactObject(input: JsonObject | undefined): JsonObject | undefined {
  if (!input) return undefined;
  return redactAt(input, 0);
}

export function redactText(message: string): string {
  return looksLikeSecretValue(message) ? message.replace(SECRET_IN_TEXT, "[redacted]") : message;
}

export function createLogger(options?: {
  sink?: (entry: AuditEntry) => void;
  now?: () => Date;
  /** In-memory retention. Oldest entries are discarded first. */
  maxEntries?: number;
}) {
  const entries: AuditEntry[] = [];
  const now = options?.now ?? (() => new Date());
  const maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
  // Ids must stay unique after the buffer starts discarding, so they count events, not
  // the current buffer length.
  let sequence = 0;
  let discarded = 0;

  function log(
    category: AuditEntry["category"],
    level: AuditEntry["level"],
    message: string,
    data?: JsonObject,
  ): AuditEntry {
    sequence += 1;
    const entry: AuditEntry = {
      id: `log_${sequence}_${now().getTime()}`,
      at: now().toISOString(),
      category,
      level,
      message: redactText(message),
      data: redactObject(data),
    };
    entries.push(entry);
    if (entries.length > maxEntries) {
      discarded += entries.length - maxEntries;
      entries.splice(0, entries.length - maxEntries);
    }
    options?.sink?.(entry);
    return entry;
  }

  return {
    log,
    debug: (category: AuditEntry["category"], message: string, data?: JsonObject) =>
      log(category, "debug", message, data),
    info: (category: AuditEntry["category"], message: string, data?: JsonObject) =>
      log(category, "info", message, data),
    warn: (category: AuditEntry["category"], message: string, data?: JsonObject) =>
      log(category, "warn", message, data),
    error: (category: AuditEntry["category"], message: string, data?: JsonObject) =>
      log(category, "error", message, data),
    entries: () => entries.slice(),
    recent: (limit = 50) => entries.slice(-limit),
    /** Retention counters, so "where did my early entries go?" has an answer. */
    stats: () => ({ retained: entries.length, logged: sequence, discarded, maxEntries }),
    clear: () => {
      entries.length = 0;
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
