import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { previewAction, formatPreview } from "./preview.ts";
import type { PermissionDecision } from "./types.ts";
import { testRuntime } from "./test-helpers.ts";

const decision: PermissionDecision = {
  allowed: false,
  level: "confirm",
  reason: "This action needs confirmation.",
  requiresConfirmation: true,
  toolName: "fs_write",
};

describe("action previews", () => {
  it("describes filesystem writes without leaking file content", () => {
    const preview = previewAction({
      toolName: "fs_write",
      args: {
        path: "notes/example.txt",
        content: "super-secret body that must not appear in the preview",
      },
      decision,
    });
    assert.equal(preview.executed, false);
    assert.equal(preview.reversibility, "reversible");
    assert.equal(preview.affected[0], "notes/example.txt");
    assert.match(preview.sideEffects[0] ?? "", /character\\(s\\) of content/);
    assert.doesNotMatch(formatPreview(preview), /super-secret/);
  });

  it("marks destructive confirmation actions honestly", () => {
    const forgetDecision = { ...decision, toolName: "memory_forget" };
    const preview = previewAction({
      toolName: "memory_forget",
      args: { key: "old-setting" },
      decision: forgetDecision,
    });
    assert.equal(preview.reversibility, "not_reversible");
    assert.match(preview.summary, /Forget/);
    assert.match(formatPreview(preview), /executed: no/);
  });

  it("attaches the preview to a queued confirmation", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "app_close",
      args: { name: "discord" },
      workspaceId: "general",
    });
    assert.equal(record.confirmationId !== undefined, true);
    assert.equal(record.preview?.executed, false);
    assert.equal(record.preview?.toolName, "app_close");

    const pending = record.confirmationId
      ? runtime.confirmations.get(record.confirmationId)
      : undefined;
    assert.equal(pending?.preview?.toolName, "app_close");
    assert.match(formatPreview(pending!.preview!), /Close a running approved application/);
  });

  it("keeps AMD Adrenalin driver settings outside the optimizer boundary", () => {
    const optimizerDecision = { ...decision, toolName: "optimizer_request" };
    const preview = previewAction({
      toolName: "optimizer_request",
      args: { action: "optimize", profile: "gaming" },
      decision: optimizerDecision,
    });
    assert.match(formatPreview(preview), /does not modify AMD Adrenalin/);
    assert.match(formatPreview(preview), /driver-level tuning/);
  });

  it("never turns a preview into an authorization", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "app_close",
      args: { name: "discord" },
      workspaceId: "general",
    });
    assert.equal(record.result, undefined);

    const confirmed = await runtime.tools.invoke({
      name: "app_close",
      args: { name: "discord" },
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(confirmed.result?.ok, true);
  });
});
