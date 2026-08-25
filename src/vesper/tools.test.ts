import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";

describe("tools", () => {
  it("registers builtin tools", async () => {
    const runtime = await testRuntime();
    const names = runtime.tools.list().map((tool) => tool.name);
    for (const required of [
      "system_info",
      "process_list",
      "app_launch",
      "app_close",
      "memory_remember",
      "optimizer_status",
      "disk_wipe",
    ]) {
      assert.ok(names.includes(required), `missing ${required}`);
    }
  });

  it("allows safe app launch and denies unknown apps", async () => {
    const runtime = await testRuntime();
    const ok = await runtime.tools.invoke({
      name: "app_launch",
      args: { name: "discord" },
      workspaceId: "general",
    });
    assert.equal(ok.result?.ok, true);
    const denied = await runtime.tools.invoke({
      name: "app_launch",
      args: { name: "not-a-real-app" },
      workspaceId: "general",
    });
    assert.equal(denied.result?.ok, false);
  });

  it("never executes disk_wipe", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "disk_wipe",
      args: {},
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(record.decision.level, "never");
    assert.equal(record.decision.allowed, false);
    assert.equal(record.result?.ok, false);
  });

  it("handles malformed tool responses without crashing", async () => {
    const runtime = await testRuntime();
    runtime.tools.register(
      {
        name: "broken",
        description: "throws",
        permission: "read",
        parameters: { type: "object", properties: {} },
      },
      async () => {
        throw new Error("boom");
      },
    );
    const record = await runtime.tools.invoke({
      name: "broken",
      args: {},
      workspaceId: "general",
    });
    assert.equal(record.result?.ok, false);
    assert.match(record.result?.summary ?? "", /boom/);
  });

  it("rejects unknown tools", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "not_registered",
      args: {},
      workspaceId: "general",
    });
    assert.equal(record.result?.ok, false);
  });
});
