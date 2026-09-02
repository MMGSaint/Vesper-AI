import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMemoryWiki } from "./wiki.ts";
import type { MemoryEntry } from "../types.ts";

function entry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, "category" | "key" | "value">): MemoryEntry {
  return {
    id: partial.id ?? `mem-${partial.key}`,
    category: partial.category,
    key: partial.key,
    value: partial.value,
    createdAt: partial.createdAt ?? "2026-09-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-09-01T00:00:00.000Z",
    source: partial.source ?? "user",
    scope: partial.scope ?? "user",
    provenance: partial.provenance ?? { origin: "user", kind: "stated" },
    workspaceId: partial.workspaceId,
    tags: partial.tags,
    deviceId: partial.deviceId,
    revision: partial.revision ?? 1,
    originDevice: partial.originDevice,
  };
}

describe("memory wiki", () => {
  it("groups persistent entries by category and does not invent empty sections", () => {
    const wiki = formatMemoryWiki([
      entry({ category: "fact", key: "main-game", value: "Squad" }),
      entry({ category: "preference", key: "tone", value: "direct" }),
      entry({
        category: "fact",
        key: "gpu",
        value: "7900 XT",
        scope: "device",
        deviceId: "desktop",
      }),
    ]);
    assert.match(wiki, /^# Vesper memory/m);
    assert.match(wiki, /## Preferences/);
    assert.match(wiki, /## Facts/);
    assert.doesNotMatch(wiki, /## Tasks/);
    assert.match(wiki, /\*\*tone\*\* \(stated\): direct/);
    assert.match(wiki, /\*\*main-game\*\* \(stated\): Squad/);
    assert.match(wiki, /### device/);
    assert.match(wiki, /authoritative copy/);
  });

  it("redacts secret-looking keys by length instead of quoting them", () => {
    const wiki = formatMemoryWiki([
      entry({ category: "config", key: "api_token", value: "super-secret-value" }),
    ]);
    assert.doesNotMatch(wiki, /super-secret-value/);
    assert.match(wiki, /\[redacted 18 characters\]/);
  });

  it("labels inferred memories so they cannot be read as something the user said", () => {
    const wiki = formatMemoryWiki([
      entry({
        category: "fact",
        key: "guess",
        value: "probably likes tea",
        source: "agent",
        provenance: { origin: "agent", kind: "inferred" },
      }),
    ]);
    assert.match(wiki, /\(inferred\): probably likes tea/);
  });

  it("says so when there is nothing to project", () => {
    const wiki = formatMemoryWiki([]);
    assert.match(wiki, /No persistent memories/);
    assert.equal(wiki.includes("## Facts"), false);
  });
});
