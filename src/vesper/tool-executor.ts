/**
 * The executor that lets a scheduled task run a tool.
 *
 * This is the piece that closes the loop the phase-2 architecture described but never
 * exercised: a task came due, and the only registered executor was `noop`. Everything
 * about the chain was already documented — the question was whether a scheduled task
 * would go through it or around it.
 *
 * It goes through it. The path is exactly the interactive one:
 *
 *   task → executor → ToolRegistry.invoke → validateToolArgs → permission gate
 *        → autonomy governor → origin narrowing → handler → result → task transition
 *
 * with one difference, and the difference is a narrowing: the origin says `scheduled`,
 * which reaches strictly less than a person at the keyboard.
 *
 * ## What this module is careful about
 *
 * The mission's rule is that **a task being queued is not authorization**. Whoever
 * queued the task had some authority at that moment; the persisted task record is not a
 * bearer token for it. Three specific ways that could go wrong, and what stops each:
 *
 * 1. **Calling the handler directly.** `ToolRegistry.get(name).handler` is public and
 *    runs with no validation, no gate, no governor, no origin check. Nothing in the
 *    codebase does this and this executor must not be the first — so it holds a
 *    `ToolRegistry` and calls `invoke`, which is the only authorized entry point.
 *
 * 2. **Choosing its own origin.** `invoke` treats an absent origin as the person at the
 *    machine. The origin here is built by this module from a constant, never read from
 *    `task.args` — a task record is attacker-influenceable persisted state, and letting
 *    it name its own origin would let a queued task claim to be a human.
 *
 * 3. **Answering its own confirmation.** `invoke` trusts `confirmed: true` verbatim.
 *    This executor never sets it. The registry additionally refuses confirm-tier tools
 *    outright for a scheduled origin, so both halves have to fail for an unattended
 *    confirm to happen.
 *
 * `task.args` is untrusted. It is persisted, it crosses devices, and unlike tool
 * arguments nothing validates it on the way in. So this module checks only enough to
 * find a tool name and an argument bag, and hands the bag to `invoke` — which validates
 * it against the tool's advertised schema *before* the gate, as it does for the model.
 */

import type { ToolRegistry } from "./tools/registry.ts";
import type { RequestOrigin } from "./tools/remote.ts";
import type { TaskExecutor, TaskExecutionResult } from "./task-scheduler.ts";
import type { JsonObject } from "./types.ts";
import type { VesperTask } from "./distributed/tasks.ts";

/** The registered kind. Shared so a typo cannot silently produce an unrunnable task. */
export const TOOL_CALL_TASK_KIND = "tool_call";

/**
 * The origin every scheduled tool call carries.
 *
 * A frozen module constant, not a value the caller supplies and not something read off
 * the task. There is deliberately no way to ask this module for a different one.
 */
const SCHEDULED_ORIGIN: RequestOrigin = Object.freeze({ kind: "scheduled" as const });

export interface ToolCallExecutorDeps {
  tools: ToolRegistry;
  /**
   * The workspace a scheduled call runs in.
   *
   * A function rather than a value because the workspace changes over the life of a
   * runtime and an executor registered at startup would otherwise pin the one that
   * happened to be current then.
   */
  workspaceId: () => string;
}

/** What a `tool_call` task carries. Validated at execution time, never trusted. */
interface ToolCallArgs {
  tool: string;
  args: JsonObject;
}

function readToolCallArgs(task: VesperTask): ToolCallArgs | { error: string } {
  const raw = task.args;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "a tool_call task needs args naming the tool to run" };
  }
  const tool = (raw as Record<string, unknown>).tool;
  if (typeof tool !== "string" || tool.length === 0) {
    return { error: "a tool_call task needs args.tool to be a non-empty tool name" };
  }
  const inner = (raw as Record<string, unknown>).args;
  if (inner !== undefined && (typeof inner !== "object" || inner === null || Array.isArray(inner))) {
    return { error: "a tool_call task's args.args must be an object when present" };
  }
  return { tool, args: (inner as JsonObject | undefined) ?? {} };
}

/**
 * Build the executor. Dependencies are captured in a closure rather than passed through
 * `TaskExecutorContext`, so the executor has no way to be handed a different registry or
 * a different origin than the runtime wired it with.
 */
export function createToolCallExecutor(deps: ToolCallExecutorDeps): TaskExecutor {
  return async function toolCallExecutor(task, ctx): Promise<TaskExecutionResult> {
    const parsed = readToolCallArgs(task);
    if ("error" in parsed) {
      // A malformed task will be malformed again on the next attempt.
      return { ok: false, summary: parsed.error, retryable: false };
    }

    if (ctx.signal.aborted) {
      // Stopping is transient — the task should be picked up again next time.
      return { ok: false, summary: "The runtime is shutting down; the task was not started." };
    }

    const workspaceId =
      typeof task.workspaceId === "string" && task.workspaceId
        ? task.workspaceId
        : deps.workspaceId();

    const call = await deps.tools.invoke({
      name: parsed.tool,
      args: parsed.args,
      workspaceId,
      origin: SCHEDULED_ORIGIN,
      // `confirmed` is deliberately absent. It means "a person approved this", and the
      // whole point of a scheduled task is that no person is here.
    });

    if (call.confirmationId) {
      // Not reachable while the registry refuses confirm-tier tools for a scheduled
      // origin, but handled rather than assumed: a queued prompt nobody asked for is
      // not a completed task, and reporting ok would claim work that did not happen.
      return {
        ok: false,
        summary: `'${parsed.tool}' is waiting for confirmation and a scheduled task cannot give it.`,
        retryable: false,
        data: { tool: parsed.tool, confirmationId: call.confirmationId },
      };
    }

    const result = call.result;
    if (!result) {
      return {
        ok: false,
        summary: `'${parsed.tool}' returned no result.`,
        retryable: false,
        data: { tool: parsed.tool },
      };
    }

    if (!result.ok) {
      // Distinguish "you may not" from "it did not work". A refusal is a settled answer
      // and retrying it produces the same refusal three times over; a tool that merely
      // failed may well succeed on the next attempt.
      const refused = call.decision.allowed === false || call.decision.level === "never";
      return {
        ok: false,
        summary: result.summary,
        retryable: !refused,
        data: {
          tool: parsed.tool,
          refused,
          level: call.decision.level,
          epistemic: result.epistemic,
        },
      };
    }

    return {
      ok: true,
      summary: result.summary,
      data: {
        tool: parsed.tool,
        level: call.decision.level,
        epistemic: result.epistemic,
      },
    };
  };
}
