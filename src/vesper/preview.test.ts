import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coercePreview, formatActionAudit, formatPreview, previewAction } from "./preview.ts";
import type { PermissionDecision, ToolCallRecord } from "./types.ts";

function confirm(toolName: string): PermissionDecision {
  return {
    allowed: false,
    level: "confirm",
    requiresConfirmation: true,
    toolName,
    reason: `Tool '${toolName}' requires explicit confirmation.`,
  };
}

describe("action preview", () => {
  it("describes an fs_write without quoting the file body", () => {
    const preview = previewAction({
      toolName: "fs_write",
      args: { path: "notes/todo.md", content: "SECRET_BODY" },
      decision: confirm("fs_write"),
    });
    assert.equal(preview.reversibility, "reversible");
    assert.deepEqual(preview.affected, ["notes/todo.md"]);
    assert.equal(preview.summary.includes("SECRET_BODY"), false);
    assert.equal(formatPreview(preview).includes("SECRET_BODY"), false);
    assert.match(formatPreview(preview), /11 character/);
    assert.match(formatPreview(preview), /checkpoint/);
    assert.match(formatPreview(preview), /requires explicit confirmation/);
    assert.equal(preview.executed, false);
    assert.match(formatPreview(preview), /executed: no — this is a preview, not a receipt/);
  });

  it("says forgetting a memory cannot be undone", () => {
    const preview = previewAction({
      toolName: "memory_forget",
      args: { key: "streaming schedule" },
      decision: confirm("memory_forget"),
    });
    assert.equal(preview.reversibility, "not_reversible");
    assert.match(preview.affected.join(" "), /streaming schedule/);
    assert.match(formatPreview(preview), /not checkpointed/);
  });

  it("does not pretend a mock optimizer change is live hardware", () => {
    const preview = previewAction({
      toolName: "optimizer_request",
      args: { action: "optimize", profile: "gaming" },
      decision: confirm("optimizer_request"),
    });
    assert.equal(preview.reversibility, "unknown");
    assert.match(formatPreview(preview), /mock does not change live hardware/);
  });

  it("is a preview, not evidence the action ran", () => {
    const preview = previewAction({
      toolName: "app_close",
      args: { name: "obs64.exe" },
      decision: confirm("app_close"),
    });
    assert.equal(/closed obs|has closed|did close/i.test(formatPreview(preview)), false);
    assert.match(formatPreview(preview), /ask the host adapter/);
  });

  it("drops a malformed restored preview rather than inventing one", () => {
    assert.equal(coercePreview(null), undefined);
    assert.equal(coercePreview({ toolName: "fs_write" }), undefined);
    const ok = coercePreview({
      toolName: "fs_write",
      summary: "Write a file",
      affected: ["notes/a.md"],
      sideEffects: ["overwrite"],
      reversibility: "reversible",
      reason: "needs confirmation",
      executed: true,
    });
    assert.equal(ok?.toolName, "fs_write");
    assert.equal(ok?.executed, false, "a restored preview must not claim the action ran");
  });

  it("attaches a dry-run summary as would-happen, never as a receipt", () => {
    const preview = previewAction({
      toolName: "fs_write",
      args: { path: "notes/todo.md", content: "hi" },
      decision: confirm("fs_write"),
      dryRunAttempted: true,
      dryRun: { ok: true, summary: "Would create notes/todo.md (2 character(s); not written)." },
    });
    assert.equal(preview.executed, false);
    assert.equal(preview.dryRunAttempted, true);
    assert.match(preview.wouldHappen ?? "", /Would create/);
    assert.match(formatPreview(preview), /would happen: Would create/);
    assert.match(formatPreview(preview), /executed: no/);
    assert.equal(/has written|did write|wrote the file/i.test(formatPreview(preview)), false);
  });
});

describe("action audit", () => {
  it("projects a queued confirmation as queued, not applied", () => {
    const record: ToolCallRecord = {
      id: "tool_1",
      toolName: "fs_write",
      args: { path: "notes/a.md" },
      decision: confirm("fs_write"),
      at: "2026-09-01T00:00:00.000Z",
      confirmationId: "confirm_1",
    };
    const text = formatActionAudit(record);
    assert.match(text, /waiting for confirmation/);
    assert.match(text, /side effect: queued/);
    assert.equal(/applied/.test(text), false);
  });

  it("marks a successful mutating result as applied", () => {
    const record: ToolCallRecord = {
      id: "tool_2",
      toolName: "memory_remember",
      args: { key: "pc", value: "9950X" },
      decision: {
        allowed: true,
        level: "safe",
        requiresConfirmation: false,
        toolName: "memory_remember",
        reason: "Allowed at permission level 'safe'.",
      },
      result: {
        ok: true,
        summary: "Remembered pc.",
        epistemic: "changed",
        changed: true,
      },
      at: "2026-09-01T00:00:00.000Z",
    };
    assert.match(formatActionAudit(record), /side effect: applied/);
    assert.match(formatActionAudit(record), /status: ran/);
  });
});
