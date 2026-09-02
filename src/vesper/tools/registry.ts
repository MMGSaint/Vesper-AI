import type { Logger } from "../logging.ts";
import type { PermissionGate } from "../permissions.ts";
import { PermissionDeniedError } from "../permissions.ts";
import { createId, nowIso } from "../id.ts";
import { validateToolArgs } from "./validate.ts";
import type {
  JsonObject,
  PendingConfirmation,
  ToolCallRecord,
  ToolHandler,
  ToolSpec,
} from "../types.ts";
import type { AutonomyGovernor } from "../autonomy.ts";
import { decideRemoteToolRequest, type RequestOrigin } from "./remote.ts";
import { capScopesForTrust } from "../client/protocol.ts";
import type { TrustState } from "../distributed/identity.ts";
import { previewAction } from "../preview.ts";

export interface RegisteredTool {
  spec: ToolSpec;
  handler: ToolHandler;
}

/**
 * How many confirmations may wait at once.
 *
 * A confirmation is a question put to a person, and a person can only ever answer a
 * handful. The queue had no cap, no expiry and no quota, and the model decides both how
 * many tool calls a round contains and what arguments they carry — so one steered turn
 * queued 4,000 entries, a few turns reached a V8 heap OOM, and the whole queue was
 * re-serialised to disk after every turn.
 *
 * The cap refuses rather than evicts. Evicting the oldest would let an attacker push a
 * genuine pending request out of the queue, which turns a denial-of-service into a
 * silent authorization change.
 */
export const MAX_PENDING_CONFIRMATIONS = 32;

/**
 * How long an unanswered confirmation stays askable.
 *
 * Not a security boundary on its own — the cap is — but a confirmation nobody answered
 * within the hour is stale, and answering it later would approve an action whose context
 * is long gone.
 */
export const CONFIRMATION_TTL_MS = 60 * 60 * 1000;

/**
 * The most argument text one queued confirmation may carry.
 *
 * The queue is persisted after every turn and `validateToolArgs` checks a declared JSON
 * type but never a length, so one string argument could be any size at all — and with
 * the count capped at 32, per-entry size is the remaining way to make the queue large.
 *
 * Deliberately generous: a confirmation that holds a document the user is about to write
 * is the normal case, and this must refuse an attack, not a long note. Oversized
 * arguments are refused rather than clipped, because a clipped argument that is later
 * approved would execute something other than what was asked for.
 */
const MAX_CONFIRMATION_ARGS_BYTES = 256 * 1024;

export class ToolRegistry {
  readonly confirmations: Map<string, PendingConfirmation>;
  private tools = new Map<string, RegisteredTool>();
  private readonly gate: PermissionGate;
  private readonly log: Logger;
  /**
   * Reads a device's trust *now*.
   *
   * Placed here rather than in the agent because this is the chokepoint every caller
   * passes through: a RequestOrigin is a snapshot taken when a request was accepted, and
   * anything holding one can outlive the trust it records. Re-reading in the agent left
   * every direct `tools.invoke` — and every future caller — deciding on stale authority.
   */
  private readonly trustOf?: (deviceId: string) => Promise<TrustState>;
  private governor: AutonomyGovernor | undefined;

  constructor(
    gate: PermissionGate,
    log: Logger,
    confirmations: Map<string, PendingConfirmation> = new Map(),
    trustOf?: (deviceId: string) => Promise<TrustState>,
  ) {
    this.gate = gate;
    this.log = log;
    this.confirmations = confirmations;
    this.trustOf = trustOf;
  }

  /**
   * Attach an autonomy governor. The governor is consulted after the gate and can
   * ONLY tighten decisions. Optional — a registry without a governor behaves exactly
   * as before, keeping every existing test valid.
   */
  setAutonomyGovernor(governor: AutonomyGovernor | undefined): void {
    this.governor = governor;
  }

  /**
   * Drop confirmations nobody answered in time.
   *
   * Run before the cap is checked so an old flood cannot permanently wedge the queue
   * against a legitimate request, and on read so a stale entry is never presented as
   * still askable.
   */
  sweepExpiredConfirmations(now = Date.now()): number {
    let removed = 0;
    for (const [id, pending] of this.confirmations) {
      const created = Date.parse(pending.createdAt);
      // An unparseable timestamp is treated as expired: a confirmation Vesper cannot
      // date is one it cannot vouch for the age of.
      if (!Number.isFinite(created) || now - created > CONFIRMATION_TTL_MS) {
        this.confirmations.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) this.log.info("permission", "Expired stale confirmations", { removed });
    return removed;
  }

  /** A remote origin, re-read against live trust and re-capped to that class's ceiling. */
  private async liveOrigin(origin: RequestOrigin | undefined): Promise<RequestOrigin> {
    if (!origin) return { kind: "local" };
    if (origin.kind !== "remote" || !origin.deviceId || !this.trustOf) return origin;
    const trust = await this.trustOf(origin.deviceId);
    return { ...origin, trust, scopes: capScopesForTrust(origin.scopes ?? [], trust) };
  }

  register(spec: ToolSpec, handler: ToolHandler) {
    if (this.tools.has(spec.name)) {
      throw new Error(`Tool already registered: ${spec.name}`);
    }
    this.tools.set(spec.name, { spec, handler });
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(workspaceId?: string): ToolSpec[] {
    const specs = [...this.tools.values()].map((tool) => tool.spec);
    if (!workspaceId) return specs;
    return specs.filter(
      (spec) => !spec.workspaces || spec.workspaces.includes(workspaceId),
    );
  }

  async invoke(input: {
    name: string;
    args: JsonObject;
    workspaceId: string;
    confirmed?: boolean;
    dryRun?: boolean;
    /** Who is driving this call. Absent means the person at this machine. */
    origin?: RequestOrigin;
  }): Promise<ToolCallRecord> {
    const registered = this.tools.get(input.name);
    if (!registered) {
      const record: ToolCallRecord = {
        id: createId("tool"),
        toolName: input.name,
        args: input.args,
        at: nowIso(),
        decision: {
          allowed: false,
          level: "never",
          requiresConfirmation: false,
          toolName: input.name,
          reason: `Unknown tool '${input.name}'.`,
        },
        result: {
          ok: false,
          summary: `Unknown tool '${input.name}'.`,
          epistemic: "could_not_access",
        },
      };
      this.log.warn("tool", record.decision.reason, { tool: input.name });
      return record;
    }

    // Validate before anything acts on the arguments. The schema is advertised to the
    // model, so enforcing it here is what makes `required` and `enum` mean anything.
    const validation = validateToolArgs(registered.spec.parameters, input.args);
    if (!validation.ok) {
      const reason = `Invalid arguments for '${input.name}': ${validation.errors.join(" ")}`;
      this.log.warn("tool", "Rejected malformed tool arguments", {
        tool: input.name,
        errors: validation.errors.join("; "),
      });
      return {
        id: createId("tool"),
        toolName: input.name,
        args: input.args,
        at: nowIso(),
        decision: {
          allowed: false,
          level: registered.spec.permission,
          requiresConfirmation: false,
          toolName: input.name,
          reason,
        },
        result: { ok: false, summary: reason, epistemic: "could_not_access" },
      };
    }
    if (validation.dropped.length) {
      this.log.info("tool", "Dropped undeclared tool arguments", {
        tool: input.name,
        dropped: validation.dropped.join(", "),
      });
    }
    // From here on the validated arguments are the ones that count.
    const args = validation.args;

    const origin = await this.liveOrigin(input.origin);
    let decision = this.gate.evaluate(registered.spec, args, input.workspaceId);

    // The autonomy governor is an ADDITIONAL layer that can only tighten. It runs
    // after the gate so it always sees the gate's answer, never around it. If the
    // governor refuses or elevates to confirm, the tightened decision replaces the
    // gate's one downstream — but the underlying gate.evaluate() has already logged
    // its own reason, so both records are in the audit trail.
    if (this.governor) {
      const gov = this.governor.evaluate({
        tool: registered.spec,
        args,
        origin,
        workspaceId: input.workspaceId,
        gateDecision: decision,
      });
      decision = gov.decision;
    }

    // Narrowing only, and only after the gate has spoken: a remote device can lose
    // access here but can never gain any. A conversation is a tool-calling loop, so
    // without this a device permitted to converse is permitted to call anything.
    const remote = decideRemoteToolRequest({
      // The *resolved* name, not the one the caller sent. Both layers must agree on
      // which tool this is: today the lookup is an exact-match Map so they cannot
      // disagree, but an alias or a namespace added later would open a differential
      // where authorization inspects one name and execution runs another.
      toolName: registered.spec.name,
      origin,
    });
    if (!remote.allowed) {
      this.log.warn("permission", remote.reason, {
        tool: input.name,
        deviceId: origin.deviceId ?? "unknown",
      });
      return {
        id: createId("tool"),
        toolName: input.name,
        args: input.args,
        at: nowIso(),
        decision: { ...decision, allowed: false, requiresConfirmation: false, reason: remote.reason },
        result: {
          ok: false,
          summary: remote.reason,
          epistemic: "could_not_access",
        },
      };
    }

    if (decision.level === "never") {
      this.log.warn("permission", decision.reason, { tool: input.name });
      return {
        id: createId("tool"),
        toolName: input.name,
        args: input.args,
        at: nowIso(),
        decision,
        result: {
          ok: false,
          summary: decision.reason,
          epistemic: "could_not_access",
        },
      };
    }

    // A scheduled task cannot answer a confirmation prompt, and must never be allowed to
    // answer one on the user's behalf. Two things follow, and both are refusals rather
    // than deferrals:
    //
    //   - `confirmed: true` from a scheduled origin is a contradiction. The flag means
    //     "a person approved this"; a timer is not a person. It is refused outright
    //     rather than honoured, because `invoke` otherwise trusts the flag verbatim.
    //   - Queueing the confirmation instead would look kinder and be worse: a task that
    //     comes due every tick would fill the 32-slot queue with prompts the user never
    //     asked for, and the queue refuses rather than evicts, so genuine requests would
    //     start being turned away.
    if (origin.kind === "scheduled" && decision.requiresConfirmation) {
      const reason =
        `'${input.name}' needs your confirmation, and a scheduled task cannot give it. ` +
        `Run it yourself when you want it to happen.`;
      this.log.warn("permission", "Refused a confirm-tier tool for a scheduled task", {
        tool: input.name,
      });
      return {
        id: createId("tool"),
        toolName: input.name,
        args: input.args,
        at: nowIso(),
        decision,
        result: { ok: false, summary: reason, epistemic: "could_not_access" },
      };
    }

    if (decision.requiresConfirmation && !input.confirmed) {
      this.sweepExpiredConfirmations();
      if (this.confirmations.size >= MAX_PENDING_CONFIRMATIONS) {
        // Refused, not evicted: dropping the oldest to make room would let a flood push
        // a genuine pending request out of the queue, and a request that silently
        // disappears is worse than one that is visibly refused.
        const reason =
          `There are already ${this.confirmations.size} actions waiting for your confirmation, ` +
          `which is the most I will hold. Answer or clear some before asking for more.`;
        this.log.warn("permission", "Refused to queue a confirmation: the queue is full", {
          tool: input.name,
          queued: this.confirmations.size,
        });
        return {
          id: createId("tool"),
          toolName: input.name,
          args: input.args,
          at: nowIso(),
          decision,
          result: { ok: false, summary: reason, epistemic: "could_not_access" },
        };
      }
      const argsBytes = JSON.stringify(args).length;
      if (argsBytes > MAX_CONFIRMATION_ARGS_BYTES) {
        const reason =
          `That request carries ${argsBytes} characters of arguments, more than I will hold ` +
          `for a confirmation. Ask for something smaller.`;
        this.log.warn("permission", "Refused to queue a confirmation: arguments too large", {
          tool: input.name,
          bytes: argsBytes,
        });
        return {
          id: createId("tool"),
          toolName: input.name,
          args: input.args,
          at: nowIso(),
          decision,
          result: { ok: false, summary: reason, epistemic: "could_not_access" },
        };
      }
      let dryRunAttempted = false;
      let dryRunResult: { ok: boolean; summary: string } | undefined;
      // Only tools that advertise they honour `context.dryRun` are invoked here.
      // Calling any other handler would turn a preview into a real side effect.
      if (registered.spec.supportsDryRun === true) {
        dryRunAttempted = true;
        try {
          const previewed = await registered.handler(args, {
            workspaceId: input.workspaceId,
            dryRun: true,
            origin: { kind: origin.kind, deviceId: origin.deviceId },
          });
          dryRunResult = { ok: previewed.ok, summary: previewed.summary };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          dryRunResult = { ok: false, summary: `dry-run failed: ${message}` };
        }
      }
      const pending: PendingConfirmation = {
        id: createId("confirm"),
        toolName: input.name,
        args,
        reason: decision.reason,
        createdAt: nowIso(),
        workspaceId: input.workspaceId,
        // Unreachable for a scheduled origin — the branch above refuses those before
        // anything is queued — but narrowed rather than cast, so that a future change
        // which lets one through fails to compile instead of persisting a kind the
        // approval path has no rule for.
        requestedBy: {
          kind: origin.kind === "remote" ? "remote" : "local",
          deviceId: origin.deviceId,
        },
        preview: previewAction({
          toolName: input.name,
          args,
          decision,
          dryRun: dryRunResult,
          dryRunAttempted: Boolean(dryRunResult) || dryRunAttempted,
        }),
      };
      this.confirmations.set(pending.id, pending);
      this.log.info("permission", "Queued confirmation", { id: pending.id, tool: input.name });
      return {
        id: createId("tool"),
        toolName: input.name,
        args: input.args,
        at: nowIso(),
        decision,
        confirmationId: pending.id,
      };
    }

    // `confirmed` answers a confirmation request. It is not a master key.
    //
    // Testing `!input.confirmed` alone let a confirmed call run a decision that had been
    // refused for some entirely different reason — an unrecognised permission level, for
    // instance, where the gate says in as many words "refusing rather than assuming it
    // is safe" and the handler ran anyway. The gate's verdict is authoritative; the only
    // thing confirmation settles is the confirmation.
    const authorized =
      decision.allowed || (decision.requiresConfirmation && input.confirmed === true);
    if (!authorized) {
      this.log.warn("permission", decision.reason, { tool: input.name });
      return {
        id: createId("tool"),
        toolName: input.name,
        args: input.args,
        at: nowIso(),
        decision,
        result: {
          ok: false,
          summary: decision.reason,
          epistemic: "could_not_access",
        },
      };
    }

    try {
      const result = await registered.handler(args, {
        workspaceId: input.workspaceId,
        dryRun: input.dryRun,
        origin: { kind: origin.kind, deviceId: origin.deviceId },
      });
      this.log.info("tool", `Executed ${input.name}`, {
        tool: input.name,
        ok: result.ok,
        epistemic: result.epistemic,
      });
      return {
        id: createId("tool"),
        toolName: input.name,
        args: input.args,
        at: nowIso(),
        decision,
        result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("tool", `Tool failed: ${input.name}`, { tool: input.name, error: message });
      if (error instanceof PermissionDeniedError) {
        return {
          id: createId("tool"),
          toolName: input.name,
          args: input.args,
          at: nowIso(),
          decision: error.decision,
          result: {
            ok: false,
            summary: error.decision.reason,
            epistemic: "could_not_access",
          },
        };
      }
      return {
        id: createId("tool"),
        toolName: input.name,
        args: input.args,
        at: nowIso(),
        decision,
        result: {
          ok: false,
          summary: `Tool '${input.name}' failed: ${message}`,
          epistemic: "could_not_access",
        },
      };
    }
  }
}
