import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertWithinRoot,
  containsTraversal,
  isDangerousRoot,
  isSafeExecutableName,
  looksLikeSecretValue,
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
    // The log never carries user text, so asserting the secret's absence there passed
    // whatever redaction did. Log something that genuinely contains it — the shape any
    // handler takes when it reports what it was asked to do — and check redaction on the
    // path that actually exists.
    const runtime = await testRuntime();
    const secret = "sk-secret-value-123456789012";
    await runtime.chat(`remember that api_key is ${secret}`);
    runtime.log.info("tool", "memory_remember called", { key: "api_key", value: secret });
    runtime.log.warn("tool", "retry after failure", { authorization: `Bearer ${secret}` });

    const dump = JSON.stringify(runtime.log.recent(40));
    assert.ok(dump.includes("memory_remember called"), "the entries under test were recorded");
    assert.equal(dump.includes(secret), false, "a credential reached the log");
    assert.ok(dump.includes("[redacted]"), "redaction did not run on the entry that carried it");
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

  it("refuses system directories at any depth, on either platform", () => {
    for (const root of [
      "/",
      ".",
      "C:\\",
      "C:",
      "/etc",
      "/etc/ssh",
      "/proc/self",
      "/root",
      "C:\\Windows",
      "C:\\Windows\\System32",
      "C:\\Program Files",
      "C:\\Program Files (x86)\\app",
      "C:\\ProgramData",
    ]) {
      assert.equal(isDangerousRoot(root), true, `${root} must be refused`);
    }
  });

  it("refuses a whole user profile but allows directories inside one", () => {
    // Regression: every path under C:\Users was treated as dangerous, so on Windows no
    // approved filesystem root and no knowledge source could live where a user's notes
    // and projects actually are.
    for (const container of [
      "/home",
      "/home/sam",
      "/Users",
      "/Users/sam",
      "C:\\Users",
      "C:\\Users\\sam",
      "C:/Users/sam/",
    ]) {
      assert.equal(isDangerousRoot(container), true, `${container} is too broad to approve`);
    }
    for (const usable of [
      "/home/sam/notes",
      "C:\\Users\\sam\\Documents\\notes",
      "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\vesper-fs-1",
      "docs",
      "/tmp/vesper",
      "D:\\projects\\vesper",
    ]) {
      assert.equal(isDangerousRoot(usable), false, `${usable} must remain approvable`);
    }
  });

  it("still refuses traversal inside an otherwise allowed path", () => {
    assert.equal(isDangerousRoot("C:\\Users\\sam\\..\\other"), true);
    assert.equal(isDangerousRoot("../secret"), true);
  });
});

describe("credential detection recognises real key shapes", () => {
  it("catches the issuer prefixes that actually appear in the wild", () => {
    // The previous pattern required an unbroken alphanumeric body, so `sk-[A-Za-z0-9]{16,}`
    // could not match `sk-live-...` or `sk-proj-...` — the hyphen ends the run right after
    // the prefix, and nearly every modern key has one. It matched a shape almost no real
    // key takes, while deciding what is withheld from sync and redacted from logs.
    const credentials = [
      "sk-live-0123456789abcdefghijklmnop",
      "sk-proj-abc123def456ghi789jkl",
      "sk-ant-api03-aaaaaaaaaaaaaaaaaaaa",
      "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "github_pat_11ABCDEFG0aaaaaaaaaaaa",
      "glpat-aaaaaaaaaaaaaaaaaaaa",
      "xoxb-123456789012-abcdefghijkl",
      "AIzaSyA0000000000000000000000000000000",
      "AKIAIOSFODNN7EXAMPLE",
      "sk_live_aaaaaaaaaaaaaaaaaaaa",
      "Bearer abcdefghijklmnopqrstuvwxyz",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      "api_key = 0123456789abcdefghij",
      "password: correcthorsebattery",
    ];
    for (const value of credentials) {
      assert.equal(looksLikeSecretValue(value), true, `missed a credential: ${value}`);
    }
  });

  it("leaves ordinary notes alone, because this decides what the user keeps", () => {
    // A heuristic that swallowed real memories would cost the user their own data, so
    // the counter-test matters as much as the detection.
    const notes = [
      "I stream on Fridays",
      "my desktop has a 7900 XT",
      "oat flat white, no sugar",
      "Mortis is a separate project. Do not absorb canon.",
      "remember to email the landlord about the boiler inspection",
      "the api is documented at docs/api.md",
      "my password manager is fine",
      "sk-1",
    ];
    for (const value of notes) {
      assert.equal(looksLikeSecretValue(value), false, `flagged an ordinary note: ${value}`);
    }
  });
});
