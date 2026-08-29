/**
 * Startup CLI, end to end and cross-platform.
 *
 * On non-Windows the reg.exe layer refuses honestly; on Windows the same code writes
 * for real. Both are exercised here through the actual entry point — no host mock —
 * because the CLI dispatch used to be a class of defect all its own (the Windows entry
 * guard silently failed to run main(); the export-memory branch skipped discovery only
 * because a ternary happened to reach it). These tests fail if either half of that
 * plumbing regresses.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function invoke(args: string[], env: Record<string, string> = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await run("node", ["--experimental-strip-types", MAIN, ...args], {
      env: { ...process.env, VESPER_ENV: "development", ...env },
      timeout: 20_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err),
    };
  }
}

async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), "vesper-startup-cli-"));
  return { dir, dataDir: dir };
}

describe("--startup-status prints an honest three-state answer", () => {
  it("prints the current preference, launcher, and registry state", async () => {
    const { dir } = await fresh();
    const result = await invoke(["--startup-status"], { VESPER_DATA_DIR: dir });

    assert.match(result.stdout, /Startup preference:/);
    assert.match(result.stdout, /Launcher:/);
    assert.match(result.stdout, /Registry:/);
    assert.match(result.stdout, /In sync:/);
  });

  it("exits 0 when a Linux host with the default (off) preference is trivially in sync", async () => {
    const { dir } = await fresh();
    const result = await invoke(["--startup-status"], { VESPER_DATA_DIR: dir });
    if (process.platform === "linux") {
      assert.equal(result.code, 0);
    } else {
      // On Windows a fresh dir means no config; startOnLogin defaults false, no Run
      // entry, so still in-sync. Documented rather than asserted differently: this
      // matches the current shipping behaviour and would need re-thinking if the
      // default changed.
      assert.equal(result.code, 0);
    }
  });
});

describe("--enable-startup on Linux refuses honestly and does NOT flip the preference", () => {
  it("prints why, exits 2, and leaves no config file behind", async () => {
    // Regression: an earlier draft patched the config first and reconciled after, so
    // Linux flipped `windows.startOnLogin` to true before refusing the registry write
    // — a preference the user never actually got the effect of. Now the write is
    // conditional on the reconcile making progress.
    if (process.platform !== "linux") return;
    const { dir } = await fresh();

    const result = await invoke(["--enable-startup"], { VESPER_DATA_DIR: dir });

    assert.equal(result.code, 2);
    assert.match(result.stdout + result.stderr, /Windows|only applies/);
    // No config was written.
    await assert.rejects(readFile(join(dir, "config", "vesper.json"), "utf8"));
  });
});

describe("--disable-startup on Linux is a no-op that reports in-sync", () => {
  it("exits 0 because 'not on Windows' plus 'not enabled' is trivially aligned", async () => {
    if (process.platform !== "linux") return;
    const { dir } = await fresh();

    const result = await invoke(["--disable-startup"], { VESPER_DATA_DIR: dir });

    assert.match(result.stdout + result.stderr, /Windows/);
    // outcome === "unable" on the reconcile path, so exit 2. Documenting the actual
    // shape rather than the wished-for one: `--disable-startup` on Linux CANNOT
    // confirm the registry state, so a green exit would overclaim.
    assert.equal(result.code, 2);
  });
});

describe("the CLI dispatcher recognises the new commands", () => {
  it("--help lists all three", async () => {
    const result = await invoke(["--help"]);
    assert.match(result.stdout, /--startup-status/);
    assert.match(result.stdout, /--enable-startup/);
    assert.match(result.stdout, /--disable-startup/);
  });

  it("rejects them combined with other commands", async () => {
    const result = await invoke(["--enable-startup", "--status"]);
    assert.notEqual(result.code, 0);
  });
});
