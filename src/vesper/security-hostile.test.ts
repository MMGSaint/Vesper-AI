import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime } from "./test-helpers.ts";
import { readApproved, writeApproved } from "./tools/filesystem.ts";
import { KnowledgeIndex } from "./knowledge/rag.ts";
import { evaluatePermission } from "./permissions.ts";
import type { PermissionLevel } from "./types.ts";
import { parseConfig } from "./config.ts";
import { looksLikeSecretValue, isSafeExecutableName, containsTraversal } from "./security.ts";
import { createHttpOptimizerAdapter } from "./specialists/optimizer.ts";
import { createClientGateway } from "./client/gateway.ts";
import { isClientError } from "./client/protocol.ts";

describe("hostile security review", () => {
  it("rejects path traversal in fs_read", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "fs_read",
      args: { path: "../../etc/passwd" },
      workspaceId: "general",
    });
    assert.equal(record.result?.ok, false);
    assert.match(record.result?.summary ?? "", /traversal|dangerous|outside/i);
  });

  it("rejects shell metacharacters in executable names", () => {
    assert.equal(isSafeExecutableName("obs64.exe & calc.exe"), false);
    assert.equal(isSafeExecutableName("Discord.exe"), true);
    assert.equal(containsTraversal("notes/../../secret"), true);
  });

  it("does not treat a malformed optimizer payload as success", async () => {
    const adapter = createHttpOptimizerAdapter("http://optimizer.test", {
      timeoutMs: 40,
      retries: 0,
      fetchImpl: (async () => new Response("{not json", { status: 200 })) as typeof fetch,
    });
    const result = await adapter.requestOptimization({ profile: "performance" });
    assert.equal(result.accepted, false);
  });

  it("falls back to defaults on hostile config", () => {
    const parsed = parseConfig({
      permissions: { neverAllowAutonomous: null, toolOverrides: "all" },
      models: { allowOptionalCloud: "yes" },
    });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.config.models.allowOptionalCloud, false);
    assert.ok(parsed.config.permissions.neverAllowAutonomous.includes("disk_wipe"));
  });

  it("detects leaked secret values", () => {
    assert.equal(looksLikeSecretValue("sk-abcdefghijklmnopqrstuvwxyz"), true);
    assert.equal(looksLikeSecretValue("hello world"), false);
  });

  it("unknown tools cannot bypass the permission gate", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "disable_security",
      args: {},
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(record.result?.ok, false);
  });

  it("companion sessions cannot claim forbidden OS powers or leak tokens", async () => {
    const runtime = await testRuntime();
    const gateway = createClientGateway(runtime);
    const session = gateway.issueSession({
      deviceLabel: "hostile-phone",
      scopes: ["status", "os.shell" as never, "permissions.relax" as never],
    });
    assert.equal(session.scopes.includes("status"), true);
    assert.equal(session.scopes.includes("os.shell" as never), false);
    const listed = gateway.sessions.list();
    assert.equal("token" in listed[0]!, false);
    const chat = await gateway.converse(session.token, "wipe disk");
    assert.equal(isClientError(chat), true);
    if (isClientError(chat)) assert.equal(chat.code, "SCOPE_DENIED");
    await runtime.stop();
  });

  it("MCP is not required and stays behind the gate", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "mcp_status",
      args: {},
      workspaceId: "general",
    });
    assert.equal(record.result?.ok, true);
    assert.match(record.result?.summary ?? "", /disabled|optional|local-first/i);
  });

  it("refuses to read through a symlink that escapes an approved root", async () => {
    // A lexical containment check passes here: the path really is inside the approved
    // directory. Only resolving the link reveals that the file is not.
    const base = await mkdtemp(join(tmpdir(), "vesper-hostile-link-"));
    const approved = join(base, "approved");
    const outside = join(base, "outside");
    await mkdir(approved, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "private.txt"), "SENSITIVE", "utf8");
    await symlink(join(outside, "private.txt"), join(approved, "innocent.txt"));

    const read = await readApproved([approved], join(approved, "innocent.txt"));
    assert.equal(read.ok, false);
    assert.match(read.summary, /symlink/i);
    assert.ok(!JSON.stringify(read).includes("SENSITIVE"), "the contents never leak");
  });

  it("refuses to write through a symlinked directory that escapes an approved root", async () => {
    const base = await mkdtemp(join(tmpdir(), "vesper-hostile-wlink-"));
    const approved = join(base, "approved");
    const outside = join(base, "outside");
    await mkdir(approved, { recursive: true });
    await mkdir(outside, { recursive: true });
    // The link is a *parent* of the target, so the write path does not exist yet.
    await symlink(outside, join(approved, "escape"));

    const written = await writeApproved([approved], join(approved, "escape", "planted.txt"), "x");
    assert.equal(written.ok, false);
    assert.match(written.summary, /symlink/i);
  });

  it("does not index a symlink pointing outside the approved tree", async () => {
    const base = await mkdtemp(join(tmpdir(), "vesper-hostile-index-"));
    const approved = join(base, "approved");
    const outside = join(base, "outside");
    await mkdir(approved, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(approved, "real.md"), "genuine approved note", "utf8");
    await writeFile(join(outside, "secret.md"), "SENSITIVE OUTSIDE NOTE", "utf8");
    await symlink(join(outside, "secret.md"), join(approved, "linked.md"));

    const index = new KnowledgeIndex(
      [{ id: "docs", name: "Docs", roots: [approved], enabled: true }],
      [],
      { approvedRoots: [approved] },
    );
    await index.reindex();
    const hits = index.search("note", { limit: 20 });
    assert.ok(hits.length >= 1, "the genuine file is still indexed");
    assert.ok(
      hits.every((hit) => !hit.snippet.includes("SENSITIVE")),
      "the symlinked file outside the root is not indexed",
    );
  });

  it("keeps indexing when one entry cannot be read", async () => {
    const base = await mkdtemp(join(tmpdir(), "vesper-hostile-broken-"));
    await writeFile(join(base, "good.md"), "readable approved note", "utf8");
    // A dangling symlink: stat() throws on it.
    await symlink(join(base, "does-not-exist.md"), join(base, "dangling.md"));

    const index = new KnowledgeIndex(
      [{ id: "docs", name: "Docs", roots: [base], enabled: true }],
      [],
      { approvedRoots: [base] },
    );
    const count = await index.reindex();
    assert.ok(count >= 1, "one broken entry does not abandon the whole index");
    assert.ok(index.search("readable", { limit: 5 }).length >= 1);
  });

  it("refuses a tool whose permission level is not recognised", () => {
    // Default deny: a corrupted config or a future level must never fall through to
    // "allowed" simply because it is neither `never` nor `confirm`.
    const decision = evaluatePermission({
      tool: {
        name: "mystery_tool",
        description: "unknown level",
        permission: "elevated" as PermissionLevel,
        parameters: { type: "object", properties: {} },
      },
      args: {},
      policy: { toolOverrides: {}, neverAllowAutonomous: [] },
      workspaceId: "general",
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.requiresConfirmation, false);
    assert.match(decision.reason, /unrecognised permission level/i);
  });
});
