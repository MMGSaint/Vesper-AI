import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyKind, kindPrivacyDefault, mayAutoPromote, provenanceRank } from "./kinds.ts";
import type { MemoryEntry } from "../types.ts";

function entry(partial: Partial<MemoryEntry> & { key: string; value: string }): MemoryEntry {
  return {
    id: "m",
    category: "fact",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    source: "user",
    scope: "user",
    revision: 1,
    ...partial,
  };
}

describe("memory kinds", () => {
  it("maps categories onto kinds without rewriting the store", () => {
    assert.equal(classifyKind(entry({ key: "colour", value: "blue", category: "preference" })), "preference");
    assert.equal(classifyKind(entry({ key: "obs", value: "setup", category: "workflow" })), "procedural");
    assert.equal(classifyKind(entry({ key: "note", value: "x", category: "session" })), "ephemeral");
    assert.equal(classifyKind(entry({ key: "me", value: "wolf", category: "config", tags: ["identity"] })), "core");
    assert.equal(classifyKind(entry({ key: "https://docs", value: "spec", category: "fact" })), "resource");
    assert.equal(classifyKind(entry({ key: "canon", value: "keep", category: "fact", tags: ["vault"] })), "vault");
  });

  it("does not auto-promote ephemeral facts into the vault", () => {
    assert.equal(mayAutoPromote("ephemeral", "vault"), false);
    assert.equal(mayAutoPromote("ephemeral", "semantic"), false);
    assert.equal(mayAutoPromote("semantic", "vault"), false);
    assert.equal(mayAutoPromote("preference", "core"), true);
  });

  it("default privacy keeps identity-level facts on the node", () => {
    assert.equal(kindPrivacyDefault("core"), "private");
    assert.equal(kindPrivacyDefault("preference"), "private");
    assert.equal(kindPrivacyDefault("vault"), "private");
    assert.equal(kindPrivacyDefault("project"), "shared");
  });

  it("ranks stated above inferred", () => {
    assert.ok(provenanceRank("stated") > provenanceRank("observed"));
    assert.ok(provenanceRank("observed") > provenanceRank("inferred"));
  });
});
