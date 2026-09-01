/**
 * Deterministic action previews for CONFIRM-tier tools.
 *
 * Friday's useful idea is not a fifth permission class. It is that a person about to
 * sign something sees: what will run, what it touches, what that does, and whether
 * Vesper can undo it. The preview is built from the tool name and arguments *before*
 * the handler runs. It never executes, never reads the disk, never talks to NEXUS.
 *
 * Content-bearing arguments (file bodies, secrets) are summarised by length, not
 * quoted. The confirmation still holds the raw args for the approval path.
 */

import type {
  ActionPreview,
  JsonObject,
  JsonValue,
  PermissionDecision,
  Reversibility,
  ToolCallRecord,
} from "./types.ts";

const SECRETISH = /password|secret|token|credential|content|body/i;

export function previewAction(input: {
  toolName: string;
  args: JsonObject;
  decision: PermissionDecision;
}): ActionPreview {
  const specific = specificPreview(input.toolName, input.args);
  return {
    toolName: input.toolName,
    summary: specific.summary,
    affected: specific.affected,
    sideEffects: specific.sideEffects,
    reversibility: specific.reversibility,
    rollbackHint: specific.rollbackHint,
    reason: input.decision.reason,
  };
}

export function formatPreview(preview: ActionPreview): string {
  const lines = [
    `intended: ${preview.summary}`,
    preview.affected.length ? `affected: ${preview.affected.join("; ")}` : null,
    preview.sideEffects.length ? `side effects: ${preview.sideEffects.join("; ")}` : null,
    `reversibility: ${reversibilityLine(preview)}`,
    `reason: ${preview.reason}`,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

/**
 * A one-screen audit of a tool call that already happened (or was queued).
 * Projects the existing record. Does not invent a hash chain or a new store.
 */
export function formatActionAudit(record: ToolCallRecord): string {
  const ran = record.result !== undefined;
  const changed = record.result?.changed === true;
  const queued = Boolean(record.confirmationId) && !ran;
  const side =
    queued ? "queued" : !ran ? "none" : changed ? "applied" : record.result?.ok ? "none" : "none";
  const lines = [
    `tool: ${record.toolName}`,
    `permission: ${record.decision.level}${record.decision.requiresConfirmation ? " (confirm)" : ""}`,
    `allowed: ${record.decision.allowed}`,
    `status: ${queued ? "waiting for confirmation" : ran ? (record.result?.ok ? "ran" : "failed") : "not run"}`,
    `side effect: ${side}`,
    `at: ${record.at}`,
  ];
  if (record.result?.summary) lines.push(`result: ${record.result.summary}`);
  if (record.confirmationId) lines.push(`confirmation: ${record.confirmationId}`);
  return lines.join("\n");
}

export function coercePreview(raw: unknown): ActionPreview | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.toolName !== "string" || typeof rec.summary !== "string" || typeof rec.reason !== "string") {
    return undefined;
  }
  const reversibility = REVERSE.has(rec.reversibility as Reversibility)
    ? (rec.reversibility as Reversibility)
    : "unknown";
  return {
    toolName: rec.toolName,
    summary: rec.summary,
    affected: stringList(rec.affected),
    sideEffects: stringList(rec.sideEffects),
    reversibility,
    rollbackHint: typeof rec.rollbackHint === "string" ? rec.rollbackHint : undefined,
    reason: rec.reason,
  };
}

const REVERSE = new Set<Reversibility>(["reversible", "not_reversible", "unknown"]);

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function reversibilityLine(preview: ActionPreview): string {
  if (preview.reversibility === "reversible") {
    return preview.rollbackHint ?? "reversible";
  }
  if (preview.reversibility === "not_reversible") {
    return preview.rollbackHint ?? "not reversible";
  }
  return preview.rollbackHint ?? "unknown";
}

function specificPreview(
  toolName: string,
  args: JsonObject,
): Pick<ActionPreview, "summary" | "affected" | "sideEffects" | "reversibility" | "rollbackHint"> {
  switch (toolName) {
    case "fs_write": {
      const path = stringArg(args, "path") || "(no path)";
      const chars = stringArg(args, "content").length;
      return {
        summary: `Write a text file inside an approved root`,
        affected: [path],
        sideEffects: [`create or overwrite that file (${chars} character(s) of content, not shown here)`],
        reversibility: "reversible",
        rollbackHint:
          "a checkpoint is taken on write for files up to 64KB; rollback_apply can reverse it if the file has not changed since",
      };
    }
    case "memory_forget": {
      const key = stringArg(args, "key") || "(no key)";
      return {
        summary: `Forget a stored memory`,
        affected: [`memory key '${key}'`],
        sideEffects: ["remove that memory from persistent store"],
        reversibility: "not_reversible",
        rollbackHint: "forgetting is not checkpointed; the value is gone once you approve",
      };
    }
    case "app_close": {
      const name = stringArg(args, "name") || "(no name)";
      return {
        summary: `Close a running approved application`,
        affected: [name],
        sideEffects: ["ask the host adapter to stop that process"],
        reversibility: "not_reversible",
        rollbackHint: "closing an app is not undone by Vesper; you would reopen it yourself",
      };
    }
    case "optimizer_request": {
      const action = stringArg(args, "action") || "optimize";
      const profile = stringArg(args, "profile");
      return {
        summary: `Request '${action}' through the optimizer adapter`,
        affected: profile ? [`profile '${profile}'`] : ["optimizer adapter"],
        sideEffects: [
          "the adapter is mock by default; a mock does not change live hardware",
          "a live adapter would apply whatever that unpublished API actually does",
        ],
        reversibility: "unknown",
        rollbackHint: "optimizer rollback is the adapter's, not Vesper's filesystem checkpoint",
      };
    }
    case "knowledge_register":
    case "knowledge_remove":
      return {
        summary: toolName === "knowledge_register" ? "Register a knowledge source" : "Remove a knowledge source",
        affected: namedArgs(args, ["id", "name", "path", "roots"]),
        sideEffects: ["change which local files Vesper is allowed to index"],
        reversibility: "not_reversible",
      };
    case "runtime_pause":
    case "runtime_resume":
      return {
        summary: toolName === "runtime_pause" ? "Pause the background runtime" : "Resume the background runtime",
        affected: ["Vesper background runtime"],
        sideEffects: [toolName === "runtime_pause" ? "idle work stops" : "idle work may resume"],
        reversibility: "reversible",
        rollbackHint: toolName === "runtime_pause" ? "runtime_resume starts it again" : "runtime_pause stops it again",
      };
    default:
      return {
        summary: `Run '${toolName}'`,
        affected: namedArgs(args),
        sideEffects: ["whatever this confirm-tier tool does, after you approve"],
        reversibility: "unknown",
      };
  }
}

function stringArg(args: JsonObject, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function namedArgs(args: JsonObject, prefer?: string[]): string[] {
  const keys = prefer?.filter((key) => key in args) ?? Object.keys(args);
  const out: string[] = [];
  for (const key of keys.length ? keys : Object.keys(args)) {
    const value = args[key];
    out.push(describeArg(key, value));
  }
  return out;
}

function describeArg(key: string, value: JsonValue): string {
  if (SECRETISH.test(key)) {
    if (typeof value === "string") return `${key}: ${value.length} character(s) (not shown)`;
    return `${key}: (redacted)`;
  }
  if (typeof value === "string") return `${key}: ${value.slice(0, 120)}`;
  if (typeof value === "number" || typeof value === "boolean") return `${key}: ${value}`;
  return key;
}
