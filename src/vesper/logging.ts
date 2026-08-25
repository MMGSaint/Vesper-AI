import type { AuditEntry, JsonObject, JsonValue } from "./types.ts";
import { looksLikeSecretValue } from "./security.ts";

const SECRET_KEY =
  /(pass(word)?|secret|token|api[_-]?key|authorization|credential|cookie)/i;

function redactValue(key: string, value: JsonValue): JsonValue {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string" && looksLikeSecretValue(value)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item));
  if (value && typeof value === "object") {
    return redactObject(value as JsonObject) ?? {};
  }
  return value;
}

export function redactObject(input: JsonObject | undefined): JsonObject | undefined {
  if (!input) return undefined;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = redactValue(key, value);
  }
  return out;
}

export function createLogger(options?: { sink?: (entry: AuditEntry) => void; now?: () => Date }) {
  const entries: AuditEntry[] = [];
  const now = options?.now ?? (() => new Date());

  function log(
    category: AuditEntry["category"],
    level: AuditEntry["level"],
    message: string,
    data?: JsonObject,
  ): AuditEntry {
    const safeMessage = looksLikeSecretValue(message)
      ? message.replace(
          /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._\-]+)\b/gi,
          "[redacted]",
        )
      : message;
    const entry: AuditEntry = {
      id: `log_${entries.length + 1}_${now().getTime()}`,
      at: now().toISOString(),
      category,
      level,
      message: safeMessage,
      data: redactObject(data),
    };
    entries.push(entry);
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
    clear: () => {
      entries.length = 0;
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
