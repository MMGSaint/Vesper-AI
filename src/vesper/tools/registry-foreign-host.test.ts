import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "./registry.ts";
import { createLogger } from "../logging.ts";

describe("foreign host tool ceiling", () => {
  it("refuses host inspection/control before the permission gate", async () => {
    const registry = new ToolRegistry({} as never, createLogger(), new Map(), undefined, "foreign");
    registry.register(
      {
        name: "fs_read",
        description: "read",
        permission: "read",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      } as never,
      async () => ({
        ok: true,
        summary: "should never execute",
        epistemic: "checked",
      }),
    );

    const result = await registry.invoke({
      name: "fs_read",
      args: {},
      workspaceId: "general",
    });

    assert.equal(result.result?.ok, false);
    assert.match(result.result?.summary ?? "", /foreign host/);
  });

  it("blocks private memory and owner-history access on a foreign host", () => {
    const registry = new ToolRegistry({} as never, createLogger(), new Map(), undefined, "foreign");
    registry.register(
      {
        name: "memory_search",
        description: "memory",
        permission: "read",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      } as never,
      async () => ({
        ok: true,
        summary: "should never execute",
        epistemic: "checked",
      }),
    );
    const result = registry.invoke({
      name: "memory_search",
      args: {},
      workspaceId: "general",
    });
    return result.then((record) => {
      assert.equal(record.result?.ok, false);
      assert.match(record.result?.summary ?? "", /foreign host/);
    });
  });

  it("keeps non-host-owned task creation and knowledge access available to portable Vesper", () => {
    const registry = new ToolRegistry({} as never, createLogger(), new Map(), undefined, "foreign");
    registry.register(
      {
        name: "memory_search",
        description: "memory",
        permission: "read",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      } as never,
      async () => ({
        ok: true,
        summary: "memory ok",
        epistemic: "checked",
      }),
    );
    assert.equal(registry.get("task_create")?.spec.name, "task_create");
  });
});
