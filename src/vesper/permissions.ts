import { stricterPermission } from "./config.ts";
import type { Logger } from "./logging.ts";
import type {
  JsonObject,
  PermissionDecision,
  PermissionLevel,
  ToolSpec,
} from "./types.ts";

const NEVER_PATTERNS = [
  /wipe/i,
  /format[_-]?disk/i,
  /credential/i,
  /password[_-]?dump/i,
  /disable[_-]?(defender|firewall|uac|security)/i,
  /kernel/i,
  /raw[_-]?msr/i,
  /flash[_-]?bios/i,
];

export class PermissionDeniedError extends Error {
  readonly decision: PermissionDecision;
  constructor(decision: PermissionDecision) {
    super(decision.reason);
    this.name = "PermissionDeniedError";
    this.decision = decision;
  }
}

export interface PermissionPolicy {
  toolOverrides: Record<string, PermissionLevel>;
  neverAllowAutonomous: string[];
}

export function evaluatePermission(input: {
  tool: ToolSpec;
  args: JsonObject;
  policy: PermissionPolicy;
  workspaceId: string;
}): PermissionDecision {
  const override = input.policy.toolOverrides[input.tool.name];
  let level = stricterPermission(input.tool.permission, override);

  if (input.tool.workspaces && !input.tool.workspaces.includes(input.workspaceId)) {
    return {
      allowed: false,
      level,
      requiresConfirmation: false,
      toolName: input.tool.name,
      reason: `Tool '${input.tool.name}' is not enabled in workspace '${input.workspaceId}'.`,
    };
  }

  if (
    input.policy.neverAllowAutonomous.includes(input.tool.name) ||
    NEVER_PATTERNS.some((pattern) => pattern.test(input.tool.name))
  ) {
    level = "never";
  }

  if (level === "never") {
    return {
      allowed: false,
      level,
      requiresConfirmation: false,
      toolName: input.tool.name,
      reason: `Tool '${input.tool.name}' is classified high-risk and is never autonomous.`,
    };
  }

  if (level === "confirm") {
    return {
      allowed: false,
      level,
      requiresConfirmation: true,
      toolName: input.tool.name,
      reason: `Tool '${input.tool.name}' requires explicit confirmation.`,
    };
  }

  return {
    allowed: true,
    level,
    requiresConfirmation: false,
    toolName: input.tool.name,
    reason: `Allowed at permission level '${level}'.`,
  };
}

export function createPermissionGate(policy: PermissionPolicy, log: Logger) {
  return {
    policy,
    evaluate(tool: ToolSpec, args: JsonObject, workspaceId: string): PermissionDecision {
      const decision = evaluatePermission({ tool, args, policy, workspaceId });
      log.info("permission", decision.reason, {
        tool: tool.name,
        level: decision.level,
        allowed: decision.allowed,
        confirm: decision.requiresConfirmation,
        workspaceId,
      });
      return decision;
    },
  };
}

export type PermissionGate = ReturnType<typeof createPermissionGate>;
