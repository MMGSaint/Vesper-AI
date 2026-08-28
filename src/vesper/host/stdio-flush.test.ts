/**
 * Regression tests for the Windows stdout-truncation bug.
 *
 * `--ask` wrote its answer with console.log and then called process.exit(). Node's
 * writes to a *pipe* are synchronous on Linux and macOS but ASYNCHRONOUS on Windows,
 * so on Windows the process died with the answer still queued: empty stdout, exit
 * code 0. Every child-process test in ask.test.ts failed on windows-latest for a
 * month while ubuntu-latest stayed green, because the bug is invisible on the
 * platform where the pipe write completes inline.
 *
 * That asymmetry is also why these tests are shaped the way they are. A
 * consequence-based end-to-end assertion ("stdout is non-empty after exit") cannot
 * distinguish the fixed code from the broken code on Linux — it passes either way.
 * So the coverage here is split:
 *
 *   1. A behavioural test of the flush contract itself, against a stream that
 *      genuinely backpressures. This runs anywhere and fails if the wait is removed.
 *   2. A structural test that the one-shot exit path actually awaits a flush before
 *      process.exit. This is the same technique the repo already uses to pin the
 *      installer and the runtime to one config path — parse the source and assert the
 *      relationship, because the property is about wiring rather than output.
 *
 * The genuine end-to-end proof is the windows-latest CI job. That is stated plainly
 * rather than implied: neither test below proves the Windows behaviour, they prove
 * the two properties the Windows behaviour depends on.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

/**
 * The same wait the host performs before exiting, reimplemented here against the
 * stream contract rather than against process.stdout — a test must not depend on the
 * real stdout being backpressured, which it is not under the test runner.
 */
async function waitForDrain(stream: Writable, timeoutMs = 2000): Promise<void> {
  if (!stream.writableNeedDrain) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      stream.off("drain", finish);
      resolve();
    };
    stream.once("drain", finish);
    setTimeout(finish, timeoutMs);
  });
}

describe("stdout flush contract — what the Windows exit path depends on", () => {
  it("waits for a backpressured stream to drain before resolving", async () => {
    // A stream that holds every write until released. `write()` returns false once the
    // highWaterMark is exceeded, which is exactly the state Windows leaves stdout in
    // when a pipe consumer has not read yet. Callbacks are held in a QUEUE: a single
    // slot would be overwritten when the stream starts the next chunk, and the last
    // write would never complete.
    const pending: Array<() => void> = [];
    const slow = new Writable({
      highWaterMark: 1,
      write(_chunk, _enc, cb) {
        pending.push(() => cb());
      },
    });

    assert.equal(slow.write("first"), false, "precondition: the stream backpressures");
    slow.write("second");
    assert.equal(slow.writableNeedDrain, true, "precondition: data is still buffered");

    let drained = false;
    const waiting = waitForDrain(slow).then(() => {
      drained = true;
    });

    await new Promise((r) => setTimeout(r, 5));
    assert.equal(drained, false, "the wait must not resolve while data is still queued");

    // Release the queued writes one at a time; only the last one drains the stream.
    while (pending.length) {
      pending.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }

    await waiting;
    assert.equal(drained, true, "the wait resolves once the stream has drained");
  });

  it("resolves immediately when nothing is pending", async () => {
    const idle = new Writable({ write(_c, _e, cb) { cb(); } });
    const started = process.hrtime.bigint();
    await waitForDrain(idle);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 250, `an already-drained stream must not stall (took ${elapsedMs}ms)`);
  });

  it("does not hang forever on a stream that never drains", async () => {
    // A consumer that went away must not wedge shutdown. Exiting slightly early beats
    // not exiting.
    const stuck = new Writable({ highWaterMark: 1, write() { /* never calls back */ } });
    stuck.write("a");
    stuck.write("b");
    const started = Date.now();
    await waitForDrain(stuck, 150);
    assert.ok(Date.now() - started < 1000, "the wait must be bounded by its timeout");
  });
});

describe("the one-shot exit path flushes before it exits", () => {
  it("shutdown awaits a stdio flush before calling process.exit", async () => {
    // Structural, deliberately. On Linux the behavioural difference is unobservable —
    // a pipe write completes inline, so output survives process.exit() either way.
    // This asserts the wiring the Windows path depends on, in the same spirit as the
    // existing test that parses the installer to pin its config path.
    const source = await readFile(MAIN, "utf8");

    const shutdownMatch = source.match(/const shutdown = async \([^)]*\) => \{[\s\S]*?\n  \};/);
    assert.ok(shutdownMatch, "could not locate the shutdown helper in main.ts");
    const body = shutdownMatch[0];

    assert.match(
      body,
      /await flushStdio\(\);/,
      "shutdown must await a stdio flush — without it, Windows loses buffered stdout on exit",
    );

    // Compare the STATEMENTS, not any mention of them. The explanatory comment above
    // the call names `process.exit()` in prose, and a naive indexOf would match that
    // and report the ordering backwards.
    const code = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const flushIndex = code.indexOf("await flushStdio()");
    const exitIndex = code.indexOf("process.exit(code)");
    assert.ok(flushIndex !== -1, "the flush call must be present in the shutdown body");
    assert.ok(exitIndex !== -1, "the exit call must be present in the shutdown body");
    assert.ok(
      flushIndex < exitIndex,
      "the flush must come BEFORE process.exit — after it would never run",
    );
  });

  it("main.ts defines flushStdio and it waits on both stdout and stderr", async () => {
    const source = await readFile(MAIN, "utf8");
    assert.match(source, /async function flushStdio\(\)/, "flushStdio must exist");
    const fn = source.slice(source.indexOf("async function flushStdio()"));
    assert.match(fn, /process\.stdout/, "must flush stdout");
    assert.match(
      fn,
      /process\.stderr/,
      "must flush stderr too — the confirmation path writes the waiting action there",
    );
  });
});

describe("the entry guard recognises this module on every platform", () => {
  /**
   * The bug that kept windows-latest red on every commit of this branch.
   *
   * The guard was `process.argv[1].endsWith("host/main.ts")`. On Windows argv[1] is
   * `D:\a\...\src\vesper\host\main.ts` — backslashes — so the suffix never matched,
   * `main()` never ran, and the process exited 0 having printed nothing. All seven
   * child-process tests saw `exit=0 stdout="" stderr=""`. Not a test artifact:
   * `vesper --ask "..."` on Windows did nothing and reported success.
   *
   * These tests run the SAME decision the guard makes, against both separator styles,
   * so the Windows shape is checked from Linux.
   */

  /** The guard's rule, extracted so the test exercises the decision rather than prose. */
  function isEntry(argv1: string, thisFile: string, platform: string): boolean {
    // Mirrors main.ts: resolved-path comparison, case-insensitive on win32, plus the
    // packaged-launcher basename escape hatch.
    const invoked = argv1;
    const same =
      invoked === thisFile ||
      (platform === "win32" && invoked.toLowerCase() === thisFile.toLowerCase());
    const base = invoked.split(/[\\/]/).pop() ?? "";
    return same || base === "vesper-host.mjs";
  }

  it("matches a Windows-shaped argv against a Windows-shaped module path", () => {
    const win = "D:\\a\\Vesper-AI\\Vesper-AI\\src\\vesper\\host\\main.ts";
    assert.equal(isEntry(win, win, "win32"), true, "the Windows path must be recognised");
  });

  it("matches regardless of drive-letter casing, as NTFS does", () => {
    const a = "D:\\a\\Vesper-AI\\src\\vesper\\host\\main.ts";
    const b = "d:\\A\\Vesper-AI\\src\\vesper\\host\\Main.ts";
    assert.equal(isEntry(b, a, "win32"), true, "case differences must not hide the entry point");
    assert.equal(isEntry(b, a, "linux"), false, "POSIX is case-sensitive and must stay so");
  });

  it("still matches a POSIX path", () => {
    const posix = "/home/user/vesper-ai/src/vesper/host/main.ts";
    assert.equal(isEntry(posix, posix, "linux"), true);
  });

  it("still honours the packaged launcher on both separators", () => {
    const other = "/opt/vesper/lib/main.ts";
    assert.equal(isEntry("/usr/local/bin/vesper-host.mjs", other, "linux"), true);
    assert.equal(isEntry("C:\\Program Files\\Vesper\\vesper-host.mjs", other, "win32"), true);
  });

  it("does not fire for an unrelated entry point", () => {
    const me = "/home/user/vesper-ai/src/vesper/host/main.ts";
    assert.equal(isEntry("/home/user/vesper-ai/scripts/package.mjs", me, "linux"), false);
    assert.equal(isEntry("C:\\other\\tool.mjs", me, "win32"), false);
  });

  it("the shipped guard compares resolved paths, not a POSIX-shaped suffix", async () => {
    // The specific regression: a `.endsWith("host/main.ts")` check is unreachable on
    // Windows. Assert the source no longer relies on one.
    const source = await readFile(MAIN, "utf8");
    const guard = source.slice(source.indexOf("const entryArg"));
    assert.ok(guard.length > 0, "the entry guard must be present");
    assert.ok(
      !/endsWith\(["'`][^"'`]*\//.test(guard),
      "the guard must not test a slash-bearing suffix — that form cannot match on Windows",
    );
    assert.match(guard, /fileURLToPath\(import\.meta\.url\)/, "must resolve this module's own path");
    assert.match(guard, /resolve\(entryArg\)/, "must resolve the invoked path before comparing");
  });
});
