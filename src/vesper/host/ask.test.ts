import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `--ask` driven as the real binary, in a child process, because the things worth
 * asserting here are the things a unit test cannot see: the process exit code, the split
 * between stdout and stderr, and whether a queued action actually ran.
 *
 * Each run gets its own working directory. In development `resolveVesperDirs` returns the
 * *relative* path `data/vesper`, so a temp cwd gives every case a private store, a private
 * instance lock, and no way to disturb the developer's own state.
 */

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

async function ask(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", MAIN, ...args, "--skip-discovery"],
      { cwd, timeout: 120_000, env: { ...process.env, VESPER_SKIP_DISCOVERY: "1" } },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
            ? ((error as unknown as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function sandbox(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vesper-ask-"));
}

describe("--ask answers one question and exits", () => {
  it("answers, prints to stdout, and exits 0", async () => {
    const cwd = await sandbox();
    const result = await ask(["--ask", "what is happening?"], cwd);
    assert.equal(result.code, 0, `exited ${result.code}: ${result.stderr}`);
    assert.ok(result.stdout.trim().length > 0, "answered nothing");
  });

  it("reports honestly that no model is loaded rather than inventing an answer", async () => {
    // With no local backend reachable, the truthful reply is that there is none — not a
    // fabricated one. This is the "do not conflate model output with execution results"
    // rule at the point a user would actually notice it. The probe must be a question
    // no deterministic intent regex captures — otherwise the truthful-fallback branch
    // is not the branch that answered.
    const cwd = await sandbox();
    const result = await ask(["--ask", "please write a haiku about a cat"], cwd);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no local inference backend|not available/i);
  });

  it("serialises the whole turn with --json, including what each tool was allowed to do", async () => {
    const cwd = await sandbox();
    const result = await ask(["--ask", "what is happening?", "--json"], cwd);
    const turn = JSON.parse(result.stdout);
    assert.ok(typeof turn.reply === "string" && turn.reply.length > 0);
    assert.ok(Array.isArray(turn.epistemic), "epistemic tags missing");
    assert.ok(Array.isArray(turn.toolCalls));
    for (const call of turn.toolCalls) {
      assert.ok(typeof call.tool === "string");
      assert.ok("allowed" in call && "level" in call, "a tool call hid its authorization decision");
    }
  });
});

describe("--ask reports a confirmation, and never answers it", () => {
  /**
   * The security-relevant half. A script is not the person a confirmation is asking, so
   * `--ask` must surface the request and stop. Auto-approving would turn a convenience
   * flag into a way to run confirm-tier tools unattended — "confirmation is not
   * authorization" read backwards.
   *
   * Asserted by consequence: the memory is still there afterwards. A test that only
   * checked the exit code would pass even if the tool had run.
   */
  it("exits 3, says what is waiting, and leaves the action unrun", async () => {
    const cwd = await sandbox();

    const stored = await ask(["--ask", "remember that I stream on Thursdays"], cwd);
    assert.equal(stored.code, 0, stored.stderr);

    const attempt = await ask(["--ask", "forget that I stream on Thursdays"], cwd);
    assert.equal(attempt.code, 3, `expected exit 3 for a pending confirmation, got ${attempt.code}`);
    assert.match(attempt.stderr, /confirmation/i, "the waiting action was not reported on stderr");

    // The consequence: nothing was forgotten.
    const after = await ask(["--ask", "what do you remember about streaming"], cwd);
    assert.match(
      after.stdout,
      /Thursdays/,
      "the memory was forgotten without anyone confirming it",
    );
  });

  it("names the tool that is waiting in --json, with ok null because it did not run", async () => {
    const cwd = await sandbox();
    await ask(["--ask", "remember that I stream on Thursdays"], cwd);
    const result = await ask(["--ask", "forget that I stream on Thursdays", "--json"], cwd);
    assert.equal(result.code, 3);
    const turn = JSON.parse(result.stdout);
    assert.equal(turn.pendingConfirmations.length, 1);
    assert.equal(turn.pendingConfirmations[0].tool, "memory_forget");
    const call = turn.toolCalls.find((item: { tool: string }) => item.tool === "memory_forget");
    assert.ok(call, "the queued tool was not reported among the turn's tool calls");
    assert.equal(call.allowed, false, "a confirm-tier tool reported itself as allowed");
    assert.equal(call.ok, null, "a tool awaiting confirmation reported a result");
  });
});


describe("--ask makes a workspace switch survive the next --ask", () => {
  /**
   * The user-visible bug: `vesper --ask "switch to gaming"` said "Switched to Gaming.",
   * but the next `vesper --ask` opened in General with no notice. Without persistence,
   * a script or a schedule that flips the workspace does nothing durable.
   *
   * Driven through the real binary in a shared temp cwd, because whether the two
   * processes agree is exactly what a unit test cannot answer.
   */
  it("switches in one process and reports the new workspace in the next", async () => {
    const cwd = await sandbox();

    const first = await ask(["--ask", "switch to gaming"], cwd);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /gaming/i, `switch reply did not mention the workspace: ${first.stdout}`);

    const second = await ask(["--ask", "status", "--json"], cwd);
    assert.equal(second.code, 0);
    const turn = JSON.parse(second.stdout);
    assert.equal(
      turn.workspaceId,
      "gaming",
      `the second process opened in ${turn.workspaceId}, not gaming — persistence failed`,
    );
  });
});

describe("--first-boot-report surfaces what the discovery pass found", () => {
  // A helper that runs *without* `--skip-discovery`, because the point of this command
  // is precisely to run discovery to completion.
  async function withDiscovery(args: string[], cwd: string) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        ["--experimental-strip-types", MAIN, ...args],
        // Do not pass VESPER_SKIP_DISCOVERY here; the whole point is to run discovery.
        { cwd, timeout: 120_000, env: { ...process.env, VESPER_SKIP_DISCOVERY: undefined } },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
              ? (error as unknown as { code: number }).code
              : error
                ? 1
                : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }

  it("prints the report and exits 0", async () => {
    // Consequence-based: assert on properties of the report the mission actually
    // depends on — the target GPU (BLOCKED-PC), the safe defaults line (never
    // fabricated benchmark numbers), and the honest "no physical validation" footer.
    const cwd = await sandbox();
    const result = await withDiscovery(["--first-boot-report"], cwd);
    assert.equal(result.code, 0, `exited ${result.code}: ${result.stderr}`);
    assert.match(result.stdout, /Vesper first-boot report/);
    assert.match(result.stdout, /Detect OS/);
    assert.match(result.stdout, /RX 7900 XT/, "the target GPU line was missing");
    assert.match(result.stdout, /Safe defaults:/);
    assert.match(
      result.stdout,
      /No physical validation of the Ryzen/,
      "the honest 'no physical validation' footer was missing",
    );
  });
});
