/**
 * Validate model-supplied tool arguments against the schema the tool advertises.
 *
 * The registry advertises `required` and `enum` to the model and previously ignored
 * both, so a hallucinated or missing argument reached the handler unchecked. Validating
 * at the registry boundary keeps every tool honest without each handler re-implementing
 * the same defensive parsing.
 *
 * Local models are imprecise in predictable ways, so narrow coercion is applied: a
 * numeric string becomes a number, "true"/"false" become booleans. Anything else that
 * does not match the declared type is an error the model is told to fix.
 */

import type { JsonObject, JsonValue, ToolParameterSchema } from "../types.ts";

export interface ArgValidation {
  ok: boolean;
  /** Arguments to pass on: coerced, with unknown keys removed. */
  args: JsonObject;
  errors: string[];
  /** Keys the tool never declared. Dropped rather than forwarded to the handler. */
  dropped: string[];
}

type DeclaredType = "string" | "number" | "boolean" | "array" | "object";

function coerce(value: JsonValue, type: DeclaredType): { ok: boolean; value?: JsonValue } {
  switch (type) {
    case "string":
      return typeof value === "string" ? { ok: true, value } : { ok: false };
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
      // Small local models routinely quote numbers.
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return { ok: true, value: parsed };
      }
      return { ok: false };
    }
    case "boolean": {
      if (typeof value === "boolean") return { ok: true, value };
      if (value === "true") return { ok: true, value: true };
      if (value === "false") return { ok: true, value: false };
      return { ok: false };
    }
    case "array":
      return Array.isArray(value) ? { ok: true, value } : { ok: false };
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? { ok: true, value }
        : { ok: false };
    default:
      return { ok: false };
  }
}

function describe(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function validateToolArgs(schema: ToolParameterSchema, args: JsonObject): ArgValidation {
  const errors: string[] = [];
  const dropped: string[] = [];
  const out: JsonObject = {};
  const properties = schema.properties ?? {};

  for (const [key, value] of Object.entries(args ?? {})) {
    // Never forward a prototype key into a handler's argument object.
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      dropped.push(key);
      continue;
    }
    const declared = properties[key];
    if (!declared) {
      dropped.push(key);
      continue;
    }
    // An explicit null for an optional argument means "not supplied".
    if (value === null && !(schema.required ?? []).includes(key)) continue;

    const coerced = coerce(value, declared.type);
    if (!coerced.ok) {
      errors.push(`'${key}' must be a ${declared.type} (received ${describe(value)}).`);
      continue;
    }
    if (declared.enum && declared.enum.length) {
      const asString = String(coerced.value);
      if (!declared.enum.includes(asString)) {
        errors.push(`'${key}' must be one of: ${declared.enum.join(", ")} (received '${asString}').`);
        continue;
      }
    }
    out[key] = coerced.value as JsonValue;
  }

  for (const key of schema.required ?? []) {
    if (!(key in out)) errors.push(`'${key}' is required.`);
  }

  return { ok: errors.length === 0, args: out, errors, dropped };
}
