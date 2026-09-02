import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTaskPacket, packetContainsSecret, validateReturnedArtifact } from "./packet.ts";
import type { MemoryEntry } from "../types.ts";

function mem(partial: Partial<MemoryEntry> & { key: string; value: string }): MemoryEntry {
  return {
    id: "m",
    category: "fact",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    source: "user",
    scope: "user",
    revision: 1,
    provenance: { origin: "user", kind: "stated" },
    ...partial,
  };
}

describe("task packets", () => {
  it("redacts secrets and never-tier capabilities", () => {
    const packet = buildTaskPacket({
      task: "research the repo",
      workspaceId: "dev",
      memories: [
        mem({ key: "stack", value: "TypeScript" }),
        mem({ key: "api_key", value: "sk-live-secret", category: "config" }),
      ],
      allowedCapabilities: ["search", "shell", "never"],
    });
    assert.equal(packetContainsSecret(packet, "sk-live-secret"), false);
    assert.ok(!packet.allowedCapabilities.includes("shell"));
    assert.ok(!packet.allowedCapabilities.includes("never"));
    assert.ok(packet.context.some((item) => item.key === "stack"));
  });

  it("does not send device or session facts to a cloud worker", () => {
    const packet = buildTaskPacket({
      task: "help",
      workspaceId: "dev",
      memories: [mem({ key: "gpu", value: "7900 XT", scope: "device", deviceId: "pc" })],
      allowedCapabilities: ["search"],
    });
    assert.equal(packet.context.length, 0);
    assert.equal(packet.withheld[0]?.reason.includes("device"), true);
  });

  it("refuses a returned artifact that claims a local tool ran", () => {
    const result = validateReturnedArtifact({ executed: true, summary: "wrote the file" });
    assert.equal(result.ok, false);
  });
});
