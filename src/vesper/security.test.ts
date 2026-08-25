import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertWithinRoot,
  containsTraversal,
  isDangerousRoot,
  isSafeExecutableName,
  parseTasklistCsv,
} from "./security.ts";
import { testRuntime } from "./test-helpers.ts";
import { KnowledgeIndex } from "./knowledge/rag.ts";

describe("security", () => {
  it("rejects path traversal and dangerous roots", () => {
    assert.equal(containsTraversal("../etc/passwd"), true);
    assert.equal(isDangerousRoot("/"), true);
    assert.equal(isDangerousRoot("C:\\"), true);
    assert.equal(isDangerousRoot("docs"), false);
    assert.throws(() => assertWithinRoot("docs", "../secret"));
  });

  it("rejects unsafe executables", () => {
    assert.equal(isSafeExecutableName("Discord.exe"), true);
    assert.equal(isSafeExecutableName("discord & calc"), false);
    assert.equal(isSafeExecutableName("C:\\Windows\\System32\\cmd.exe"), false);
  });

  it("parses tasklist CSV without taking user command lines", () => {
    const rows = parseTasklistCsv('"Discord.exe","220","Console","1","420,000 K"\n');
    assert.equal(rows[0]?.name, "Discord.exe");
    assert.equal(rows[0]?.pid, 220);
  });

  it("does not log secrets from a remember turn", async () => {
    const runtime = await testRuntime();
    await runtime.chat("remember that api_key is sk-secret-value-123456789012");
    const dump = JSON.stringify(runtime.log.recent(40));
    assert.equal(dump.includes("sk-secret-value-123456789012"), false);
  });

  it("denies command-like unapproved app names", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "app_launch",
      args: { name: "discord; whoami" },
      workspaceId: "general",
    });
    assert.equal(record.result?.ok, false);
  });

  it("refuses to register a traversing knowledge root", () => {
    const index = new KnowledgeIndex([], [], { approvedRoots: ["docs"] });
    const result = index.registerSource({
      id: "evil",
      name: "evil",
      roots: ["../"],
      enabled: true,
    });
    assert.equal(result.ok, false);
  });

  it("never allows a high-risk tool even with confirmation", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "credential_extract",
      args: {},
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(record.decision.level, "never");
    assert.equal(record.result?.ok, false);
  });
});
