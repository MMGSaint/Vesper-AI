import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bumpContinuity,
  createContinuity,
  formatHandoff,
  resolveContinuity,
} from "./conversation.ts";

describe("conversation continuity", () => {
  it("hands off goal and open threads without the transcript", () => {
    const onPc = createContinuity({
      title: "Vesper sync",
      summary: "Designing encrypted multi-node continuity.",
      currentGoal: "Finish the outbox contract",
      decisions: ["Cloud stores ciphertext only"],
      openQuestions: ["Where do pairing codes live?"],
      pendingActions: ["Write the laptop merge test"],
      deviceId: "dev_pc",
      workspaceId: "development",
      recentWindow: [{ role: "user", text: "We're working on Vesper sync.", at: "2026-09-02T00:00:00.000Z" }],
    });
    const handoff = formatHandoff(onPc);
    assert.match(handoff, /Current goal: Finish the outbox contract/);
    assert.match(handoff, /We're working on Vesper sync/);
    assert.equal(handoff.includes("full transcript"), false);
  });

  it("a newer remote version wins; an older reconnect does not overwrite", () => {
    const a = createContinuity({
      conversationId: "convo_1",
      title: "Sync",
      summary: "v1",
      deviceId: "dev_pc",
      workspaceId: "general",
    });
    const b = bumpContinuity(a, { summary: "v2 on laptop" }, "dev_laptop");
    const stale = resolveContinuity(b, a);
    assert.equal(stale.decision, "local");
    const forward = resolveContinuity(a, b);
    assert.equal(forward.decision, "remote");
    assert.equal(forward.winner?.summary, "v2 on laptop");
  });

  it("independent edits of the same version conflict", () => {
    const base = createContinuity({
      conversationId: "convo_1",
      title: "Sync",
      summary: "base",
      currentGoal: "A",
      deviceId: "dev_pc",
      workspaceId: "general",
    });
    const onPc = bumpContinuity(base, { currentGoal: "PC goal" }, "dev_pc");
    const onLaptop = bumpContinuity(base, { currentGoal: "Laptop goal" }, "dev_laptop");
    // Force same version to model simultaneous edits.
    onLaptop.version = onPc.version;
    const result = resolveContinuity(onPc, onLaptop);
    assert.equal(result.decision, "conflict");
    assert.match(result.conflict?.reason ?? "", /Neither handoff is discarded/);
  });

  it("missing transcript plus present continuity is enough to continue", () => {
    const continuity = createContinuity({
      title: "Interrupted",
      summary: "Stopped mid-plan.",
      currentGoal: "Resume the merge",
      deviceId: "dev_usb",
      workspaceId: "general",
      recentWindow: [],
    });
    const text = formatHandoff(continuity);
    assert.match(text, /Resume the merge/);
    assert.equal(continuity.recentWindow.length, 0);
  });
});
