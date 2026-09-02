/**
 * Deterministic-first routing.
 *
 * Known procedure → enabled skill → registered tool → model fallback.
 * This module plans. It never invokes a tool, never grants a permission, and
 * never treats an instinct as a procedure.
 */

import type { PermissionLevel } from "../types.ts";
import type { Procedure } from "../procedures.ts";
import type { SkillRecord } from "../skills.ts";

export const ROUTE_STEPS = ["procedure", "skill", "tool", "model"] as const;
export type RouteStep = (typeof ROUTE_STEPS)[number];

export interface RoutePlan {
  step: RouteStep;
  name: string;
  reason: string;
  permissionCeiling: PermissionLevel;
  executed: false;
  fallback?: RoutePlan;
}

export interface RouteCatalog {
  procedures: Procedure[];
  skills: SkillRecord[];
  tools: { name: string; permission: PermissionLevel }[];
}

export function planExecution(input: { intent: string; catalog: RouteCatalog }): RoutePlan {
  const query = input.intent.toLowerCase();
  const procedure = input.catalog.procedures.find(
    (item) => item.state === "active" && matches(query, item.name, item.purpose),
  );
  if (procedure) {
    return {
      step: "procedure",
      name: procedure.name,
      reason: "An active reviewed procedure already covers this work.",
      permissionCeiling: procedure.permissionCeiling,
      executed: false,
      fallback: modelFallback(),
    };
  }

  const skill = input.catalog.skills.find(
    (item) => item.state === "enabled" && matches(query, item.manifest.name, item.manifest.description),
  );
  if (skill) {
    return {
      step: "skill",
      name: skill.manifest.name,
      reason: "An enabled skill matches. The permission gate still applies to every tool it names.",
      permissionCeiling: "confirm",
      executed: false,
      fallback: modelFallback(),
    };
  }

  const tool = input.catalog.tools.find(
    (item) => item.permission !== "never" && query.includes(item.name.replaceAll("_", " ")),
  );
  if (tool) {
    return {
      step: "tool",
      name: tool.name,
      reason: "A registered tool matches. Invocation still goes through the gate.",
      permissionCeiling: tool.permission,
      executed: false,
      fallback: modelFallback(),
    };
  }

  return modelFallback();
}

function modelFallback(): RoutePlan {
  return {
    step: "model",
    name: "everyday",
    reason: "No deterministic path; a model may reason, then tools still go through the gate.",
    permissionCeiling: "confirm",
    executed: false,
  };
}

function matches(query: string, name: string, extra: string): boolean {
  const hay = `${name} ${extra}`.toLowerCase();
  const tokens = query.split(/\s+/).filter((token) => token.length > 3);
  if (tokens.length === 0) return hay.includes(query.trim());
  return tokens.some((token) => hay.includes(token));
}
