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

  it("keeps non-host-owned task/memory tools available to portable Vesper", () => {
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
    assert.equal(registry.get("memory_search")?.spec.name, "memory_search");
  });
});
