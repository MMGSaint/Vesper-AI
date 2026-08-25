import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";

describe("workspaces", () => {
  it("lists configured workspaces and switches by name", async () => {
    const runtime = await testRuntime();
    const ids = runtime.workspaces.list().map((ws) => ws.id);
    assert.deepEqual(
      ids.sort(),
      ["development", "gaming", "general", "mortis", "streaming", "vrchat"].sort(),
    );
    assert.equal(runtime.workspaces.switchTo("Mortis")?.id, "mortis");
    assert.equal(runtime.workspaces.current().id, "mortis");
    assert.equal(runtime.workspaces.switchTo("does-not-exist"), undefined);
  });
});
