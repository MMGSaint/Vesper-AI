import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";
import { parseConfig } from "./config.ts";
import { looksLikeSecretValue, isSafeExecutableName, containsTraversal } from "./security.ts";
import { createHttpOptimizerAdapter } from "./specialists/optimizer.ts";

describe("hostile security review", () => {
  it("rejects path traversal in fs_read", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "fs_read",
      args: { path: "../../etc/passwd" },
      workspaceId: "general",
    });
    assert.equal(record.result?.ok, false);
    assert.match(record.result?.summary ?? "", /traversal|dangerous|outside/i);
  });

  it("rejects shell metacharacters in executable names", () => {
    assert.equal(isSafeExecutableName("obs64.exe & calc.exe"), false);
    assert.equal(isSafeExecutableName("Discord.exe"), true);
    assert.equal(containsTraversal("notes/../../secret"), true);
  });

  it("does not treat a malformed optimizer payload as success", async () => {
    const adapter = createHttpOptimizerAdapter("http://optimizer.test", {
      timeoutMs: 40,
      retries: 0,
      fetchImpl: (async () => new Response("{not json", { status: 200 })) as typeof fetch,
    });
    const result = await adapter.requestOptimization({ profile: "performance" });
    assert.equal(result.accepted, false);
  });

  it("falls back to defaults on hostile config", () => {
    const parsed = parseConfig({
      permissions: { neverAllowAutonomous: null, toolOverrides: "all" },
      models: { allowOptionalCloud: "yes" },
    });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.config.models.allowOptionalCloud, false);
    assert.ok(parsed.config.permissions.neverAllowAutonomous.includes("disk_wipe"));
  });

  it("detects leaked secret values", () => {
    assert.equal(looksLikeSecretValue("sk-abcdefghijklmnopqrstuvwxyz"), true);
    assert.equal(looksLikeSecretValue("hello world"), false);
  });

  it("unknown tools cannot bypass the permission gate", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "disable_security",
      args: {},
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(record.result?.ok, false);
  });

  it("MCP is not required and stays behind the gate", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "mcp_status",
      args: {},
      workspaceId: "general",
    });
    assert.equal(record.result?.ok, true);
    assert.match(record.result?.summary ?? "", /disabled|optional|local-first/i);
  });
});
