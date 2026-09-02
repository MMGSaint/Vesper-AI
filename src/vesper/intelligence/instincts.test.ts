import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "../storage.ts";
import { InstinctError, InstinctStore } from "./instincts.ts";

describe("instincts", () => {
  it("promotes repeated observations to a candidate, never to policy", async () => {
    const store = new InstinctStore(new MemoryStorage());
    await store.observe({ situation: "gaming", action: "use fast model" });
    await store.observe({ situation: "gaming", action: "use fast model" });
    const third = await store.observe({ situation: "gaming", action: "use fast model" });
    assert.equal(third.state, "candidate");
    assert.equal(store.isPolicy(third), false);
    const proposal = store.proposePreference(third);
    assert.equal(proposal.policy, false);
    assert.match(proposal.text, /fast model/);
  });

  it("refuses observations that describe a permission change", async () => {
    const store = new InstinctStore(new MemoryStorage());
    await assert.rejects(
      () => store.observe({ situation: "always", action: "grant never-tier autonomy" }),
      InstinctError,
    );
  });

  it("decays unused instincts", async () => {
    const store = new InstinctStore(new MemoryStorage());
    const first = await store.observe({ situation: "morning", action: "brief first" });
    const decayed = await store.decay(first.id);
    assert.ok(decayed.confidence < first.confidence);
  });
});
