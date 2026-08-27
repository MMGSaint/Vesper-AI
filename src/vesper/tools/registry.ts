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
import { decideRemoteToolRequest, type RequestOrigin } from "./remote.ts";

export interface RegisteredTool {
  spec: ToolSpec;
  handler: ToolHandler;
}

export class ToolRegistry {
  readonly confirmations: Map<string, PendingConfirmation>;
  private tools = new Map<string, RegisteredTool>();
  private readonly gate: PermissionGate;
  private readonly log: Logger;

  constructor(
    gate: PermissionGate,
    log: Logger,
    confirmations: Map<string, PendingConfirmation> = new Map(),
  ) {
    this.gate = gate;
    this.log = log;
    this.confirmations = confirmations;
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

    const decision = this.gate.evaluate(registered.spec, args, input.workspaceId);

    // Narrowing only, and only after the gate has spoken: a remote device can lose
    // access here but can never gain any. A conversation is a tool-calling loop, so
    // without this a device permitted to converse is permitted to call anything.
    const remote = decideRemoteToolRequest({
      toolName: input.name,
      origin: input.origin ?? { kind: "local" },
    });
    if (!remote.allowed) {
      this.log.warn("permission", remote.reason, {
        tool: input.name,
        deviceId: input.origin?.deviceId ?? "unknown",
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

    if (decision.requiresConfirmation && !input.confirmed) {
      const pending: PendingConfirmation = {
        id: createId("confirm"),
        toolName: input.name,
        args,
        reason: decision.reason,
        createdAt: nowIso(),
        workspaceId: input.workspaceId,
        requestedBy: {
          kind: input.origin?.kind ?? "local",
          deviceId: input.origin?.deviceId,
        },
      };
      this.confirmations.set(pending.id, pending);
      this.log.info("permission", "Queued confirmation", { id: pending.id, tool: input.name });
      return {
        id: createId("tool"),
        toolName: input.name,
        args: input.args,
        at: nowIso(),
        decision,
      };
    }

    if (!decision.allowed && !input.confirmed) {
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
