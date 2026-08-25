import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluatePermission } from "./permissions.ts";
import type { ToolSpec } from "./types.ts";

const tool = (name: string, permission: ToolSpec["permission"], workspaces?: string[]): ToolSpec => ({
  name,
  description: name,
  permission,
  workspaces,
  parameters: { type: "object", properties: {} },
});

describe("permissions", () => {
  it("allows read tools", () => {
    const decision = evaluatePermission({
      tool: tool("system_info", "read"),
      args: {},
      policy: { toolOverrides: {}, neverAllowAutonomous: [] },
      workspaceId: "general",
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.requiresConfirmation, false);
  });

  it("queues confirmation-required tools", () => {
    const decision = evaluatePermission({
      tool: tool("app_close", "confirm"),
      args: {},
      policy: { toolOverrides: {}, neverAllowAutonomous: [] },
      workspaceId: "general",
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.requiresConfirmation, true);
  });

  it("never allows high-risk tools even if declared safe", () => {
    const decision = evaluatePermission({
      tool: tool("disk_wipe", "safe"),
      args: {},
      policy: { toolOverrides: {}, neverAllowAutonomous: ["disk_wipe"] },
      workspaceId: "general",
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.level, "never");
    assert.equal(decision.requiresConfirmation, false);
  });

  it("blocks credential extraction by name pattern", () => {
    const decision = evaluatePermission({
      tool: tool("credential_extract", "read"),
      args: {},
      policy: { toolOverrides: {}, neverAllowAutonomous: [] },
      workspaceId: "general",
    });
    assert.equal(decision.level, "never");
    assert.equal(decision.allowed, false);
  });

  it("cannot be relaxed by a weaker override", () => {
    const decision = evaluatePermission({
      tool: tool("disk_wipe", "never"),
      args: {},
      policy: { toolOverrides: { disk_wipe: "read" }, neverAllowAutonomous: [] },
      workspaceId: "general",
    });
    assert.equal(decision.level, "never");
    assert.equal(decision.allowed, false);
  });

  it("can only restrict further via override", () => {
    const decision = evaluatePermission({
      tool: tool("notify", "safe"),
      args: {},
      policy: { toolOverrides: { notify: "confirm" }, neverAllowAutonomous: [] },
      workspaceId: "general",
    });
    assert.equal(decision.requiresConfirmation, true);
  });
});
