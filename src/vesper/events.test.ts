import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";

describe("events and notifications", () => {
  it("emits workspace events and de-dupes notifications", async () => {
    const runtime = await testRuntime();
    await runtime.chat("switch to gaming");
    const events = runtime.events.recent({ type: "workspace.switch" });
    assert.ok(events.length >= 1);

    const first = runtime.notifications.push({
      kind: "info",
      title: "Squad",
      body: "finished updating",
      cooldownKey: "squad-update",
    });
    const second = runtime.notifications.push({
      kind: "info",
      title: "Squad",
      body: "finished updating again",
      cooldownKey: "squad-update",
    });
    assert.ok(first);
    assert.equal(second, null);
  });
});
