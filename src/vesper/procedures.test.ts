import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "./storage.ts";
import { ProcedureStore, type ProcedureCatalog } from "./procedures.ts";
import type { PermissionLevel } from "./types.ts";

const catalog: ProcedureCatalog = {
  permissionOf(name: string): PermissionLevel | undefined {
    const map: Record<string, PermissionLevel> = {
      memory_search: "read",
      memory_remember: "safe",
      fs_write: "confirm",
      disk_wipe: "never",
    };
    return map[name];
  },
};

function store() {
  return new ProcedureStore(new MemoryStorage(), catalog);
}

describe("procedural memory", () => {
  it("starts as a candidate, not as something reusable", async () => {
    const procedures = store();
    const created = await procedures.propose({
      name: "Friday stream start",
      purpose: "Get OBS and Discord ready to stream",
      steps: [
        { instruction: "Check that OBS is running", toolName: "memory_search", permission: "read" },
        { instruction: "Ask before writing the stream notes", toolName: "fs_write", permission: "confirm" },
      ],
      provenance: { source: "agent", origin: "model" },
    });
    assert.equal(created.state, "candidate");
    assert.equal(created.permissionCeiling, "confirm");
    const hits = await procedures.search("Friday stream");
    assert.equal(hits.length, 0, "candidates must not be surfaced as reusable workflows");
  });

  it("becomes searchable only after review and activate", async () => {
    const procedures = store();
    const created = await procedures.propose({
      name: "Friday stream start",
      purpose: "Get OBS and Discord ready to stream",
      steps: [{ instruction: "Open the streaming notes", toolName: "memory_search", permission: "read" }],
      provenance: { source: "user", origin: "console" },
    });
    await assert.rejects(() => procedures.activate(created.id), /not reviewed/);
    await procedures.review(created.id);
    const active = await procedures.activate(created.id);
    assert.equal(active.state, "active");
    const hits = await procedures.search("stream start");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].procedure.id, created.id);
  });

  it("refuses to claim a confirm tool is safe, or to hold a never-tier tool", async () => {
    const procedures = store();
    await assert.rejects(
      () =>
        procedures.propose({
          name: "sneak write",
          purpose: "write a file as if it were safe",
          steps: [{ instruction: "write", toolName: "fs_write", permission: "safe" }],
          provenance: { source: "agent", origin: "model" },
        }),
      /claims 'safe' but 'fs_write' is 'confirm'/,
    );
    await assert.rejects(
      () =>
        procedures.propose({
          name: "wipe",
          purpose: "wipe disks",
          steps: [{ instruction: "wipe", toolName: "disk_wipe", permission: "never" }],
          provenance: { source: "agent", origin: "model" },
        }),
      /never-tier/,
    );
    await assert.rejects(
      () =>
        procedures.propose({
          name: "ghost",
          purpose: "call a tool that does not exist",
          steps: [{ instruction: "go", toolName: "not_a_tool", permission: "read" }],
          provenance: { source: "agent", origin: "model" },
        }),
      /unknown tool/,
    );
  });

  it("does not grant tool rights — an active procedure is still just text", async () => {
    const procedures = store();
    const created = await procedures.propose({
      name: "remember snack",
      purpose: "store a snack preference",
      steps: [{ instruction: "remember pretzels", toolName: "memory_remember", permission: "safe" }],
      provenance: { source: "user", origin: "console" },
    });
    await procedures.review(created.id);
    await procedures.activate(created.id);
    const active = await procedures.get(created.id);
    assert.equal(active?.state, "active");
    assert.ok(active?.requiredTools.includes("memory_remember"));
    // The store has no invoke(). Existence of an active procedure is not a call.
    assert.equal("invoke" in procedures, false);
  });
});
