/**
 * Deterministic action previews for confirmation-tier tools.
 *
 * A preview is computed from the already-validated tool name and arguments before the
 * handler runs. It does not execute tools, inspect the filesystem, contact NEXUS, or
 * grant authority. Content-bearing arguments are summarized by length rather than quoted.
 */

import type {
  ActionPreview,
  JsonObject,
  JsonValue,
  PermissionDecision,
  ToolCallRecord,
} from "./types.ts";

const SECRETISH = /password|secret|token|credential|content|body/i;

export function previewAction(input: {
  toolName: string;
  args: JsonObject;
  decision: PermissionDecision;
  dryRun?: { ok: boolean; summary: string };
  dryRunAttempted?: boolean;
}): ActionPreview {
  const specific = specificPreview(input.toolName, input.args);
  const wouldHappen = input.dryRun
    ? input.dryRun.summary
    : input.dryRunAttempted
      ? "dry-run was attempted but produced no summary"
      : undefined;

  return {
    toolName: input.toolName,
    summary: specific.summary,
    affected: specific.affected,
    sideEffects: specific.sideEffects,
    reversibility: specific.reversibility,
    ...(specific.rollbackHint === undefined ? {} : { rollbackHint: specific.rollbackHint }),
    reason: input.decision.reason,
    executed: false,
    ...(wouldHappen === undefined ? {} : { wouldHappen }),
    dryRunAttempted: input.dryRunAttempted === true,
  };
}

export function formatPreview(preview: ActionPreview): string {
  const lines = [
    `intended: ${preview.summary}`,
    preview.affected.length ? `affected: ${preview.affected.join("; ")}` : null,
    preview.sideEffects.length ? `side effects: ${preview.sideEffects.join("; ")}` : null,
    `reversibility: ${preview.rollbackHint ?? preview.reversibility}`,
    preview.wouldHappen ? `would happen: ${preview.wouldHappen}` : null,
    "executed: no — this is a preview, not a receipt",
    `reason: ${preview.reason}`,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

/** A compact view of an action that already happened or was queued. */
export function formatActionAudit(record: ToolCallRecord): string {
  const ran = record.result !== undefined;
  const changed = record.result?.changed === true;
  const queued = Boolean(record.confirmationId) && !ran;
  const side = queued ? "queued" : ran && changed ? "applied" : "none";
  const status = queued ? "waiting for confirmation" : ran ? (record.result?.ok ? "ran" : "failed") : "not run";
  const lines = [
    `tool: ${record.toolName}`,
    `permission: ${record.decision.level}${record.decision.requiresConfirmation ? " (confirm)" : ""}`,
    `allowed: ${record.decision.allowed}`,
    `status: ${status}`,
    `side effect: ${side}`,
    `at: ${record.at}`,
  ];
  if (record.result?.summary) lines.push(`result: ${record.result.summary}`);
  if (record.confirmationId) lines.push(`confirmation: ${record.confirmationId}`);
  return lines.join("\n");
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
        summary: "Write a text file inside an approved root",
        affected: [path],
        sideEffects: [`create or overwrite that file (${chars} character(s) of content, not shown here)`],
        reversibility: "reversible",
        rollbackHint: "a filesystem checkpoint may make this reversible when rollback conditions hold",
      };
    }
    case "memory_forget": {
      const key = stringArg(args, "key") || "(no key)";
      return {
        summary: "Forget a stored memory",
        affected: [`memory key '${key}'`],
        sideEffects: ["remove that memory from persistent store"],
        reversibility: "not_reversible",
        rollbackHint: "forgetting is not checkpointed; approve only when you are ready to lose it",
      };
    }
    case "app_close": {
      const name = stringArg(args, "name") || "(no name)";
      return {
        summary: "Close a running approved application",
        affected: [name],
        sideEffects: ["ask the host adapter to stop that process"],
        reversibility: "not_reversible",
        rollbackHint: "Vesper will not reopen the application automatically",
      };
    }
    case "optimizer_request": {
      const action = stringArg(args, "action") || "optimize";
      const profile = stringArg(args, "profile");
      return {
        summary: `Request '${action}' through the optimizer adapter`,
        affected: profile ? [`profile '${profile}'`] : ["optimizer adapter"],
        sideEffects: [
          "the configured adapter decides what work occurs; mock adapters do not change live hardware",
          "a live NEXUS adapter may change reversible system settings within its own safety policy",
        ],
        reversibility: "unknown",
        rollbackHint: "optimizer rollback belongs to NEXUS, not Vesper's filesystem checkpoint",
      };
    }
    case "knowledge_register":
    case "knowledge_remove":
      return {
        summary: toolName === "knowledge_register" ? "Register a knowledge source" : "Remove a knowledge source",
        affected: namedArgs(args, ["id", "name", "path", "roots"]),
        sideEffects: ["change which local files Vesper is allowed to index"],
        reversibility: "reversible",
        rollbackHint: "review the resulting source configuration before relying on it",
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
  return typeof args[key] === "string" ? String(args[key]) : "";
}

function namedArgs(args: JsonObject, prefer?: string[]): string[] {
  const keys = prefer?.filter((key) => key in args) ?? Object.keys(args);
  const selected = keys.length ? keys : Object.keys(args);
  return selected.map((key) => describeArg(key, args[key]));
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
