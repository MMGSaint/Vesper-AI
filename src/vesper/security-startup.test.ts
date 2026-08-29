/**
 * Startup residency: the properties that must stay true when Vesper lives on a PC.
 *
 * Every case below asserts a CONSEQUENCE — the state of the runtime, a permission
 * decision, what got written to disk — rather than checking that a private helper was
 * called. The mission's rule is that startup, recovery, and duplicate-instance handling
 * cannot become new authority paths, and the questions to answer are what the runtime
 * decides *after* each of those has run.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime } from "./test-helpers.ts";
import {
  inspectStartupRegistration,
  reconcileStartupRegistration,
} from "./windows/startup-manage.ts";
import type { WindowsRunner } from "./windows/exec.ts";
import type { WindowsCommand } from "./windows/exec.ts";
import { patchConfigFile } from "./config-file.ts";

function noopRunner(): { runner: WindowsRunner; calls: WindowsCommand[] } {
  const calls: WindowsCommand[] = [];
  const runner: WindowsRunner = async (command) => {
    calls.push({ command: command.command, args: [...command.args] });
    return { ok: true, code: 0, stdout: Buffer.from(""), stderr: "", timedOut: false, aborted: false, error: null };
  };
  return { runner, calls };
}

describe("startup registration is not a permission surface", () => {
  it("does not change any autonomy or gate decision", async () => {
    // The most direct assertion the mission asks for: startup cannot bypass permissions.
    const runtime = await testRuntime();
    const before = await runtime.tools.invoke({
      name: "disk_wipe",
      args: {},
      workspaceId: "general",
      confirmed: true,
    });

    // Simulate the "reg.exe was written" side effect however completely — patch config,
    // run reconcile, snapshot again — none of it may move the permission gate.
    await reconcileStartupRegistration({
      intent: { enabled: true, launcher: "C:\\Vesper\\bin\\vesper-host.cmd" },
      platform: "linux",
    });

    const after = await runtime.tools.invoke({
      name: "disk_wipe",
      args: {},
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(before.decision.level, after.decision.level);
    assert.equal(after.decision.level, "never");
    assert.equal(after.result?.ok, false);
  });

  it("refuses a launcher target that is not a Vesper launcher, however the config was set", async () => {
    // Even a config file that names a plausible-looking path elsewhere on disk must
    // not reach reg.exe. This is the containment layer between "user wrote a value"
    // and "reg.exe runs a string at every logon".
    const { runner, calls } = noopRunner();
    for (const bad of [
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\evil\\evilnvertly-named-vesper-host.cmd",
      "/opt/evil/vesper-host.cmd",  // wrong on Windows
      "..\\..\\vesper-host.cmd",
    ]) {
      const result = await reconcileStartupRegistration({
        intent: { enabled: true, launcher: bad },
        platform: "win32",
        runner,
      });
      assert.equal(result.action, "refused", `should refuse ${bad}`);
    }
    assert.ok(!calls.some((c) => c.args[0] === "add"), "no reg.exe add may have been issued");
  });

  it("refuses a launcher containing a newline, so no multi-command smuggling", async () => {
    const { runner, calls } = noopRunner();
    const result = await reconcileStartupRegistration({
      intent: {
        enabled: true,
        launcher: "C:\\Vesper\\bin\\vesper-host.cmd\r\nstart calc.exe",
      },
      platform: "win32",
      runner,
    });
    assert.equal(result.action, "refused");
    assert.ok(!calls.some((c) => c.args[0] === "add"));
  });
});

describe("the config patcher cannot overwrite the whole config", () => {
  it("preserves keys the patch did not name", async () => {
    // Regression: `writeConfigIfMissing` drops entire sections (permissions,
    // approvedRoots, obs). A patch path that reused it would delete the user's
    // permission overrides — which is why patchConfigFile is a separate function that
    // deep-merges. Assert that on this concrete instance.
    const dir = await mkdtemp(join(tmpdir(), "vesper-cfg-"));
    const path = join(dir, "vesper.json");
    // Seed with a sensitive-looking key the patch does not name.
    const seeded = await patchConfigFile(path, {
      permissions: { fs_write: "never" },
      approvedRoots: ["/home/user/notes"],
      windows: { startOnLogin: false },
    });
    assert.equal(seeded.ok, true);

    const patched = await patchConfigFile(path, { windows: { startOnLogin: true } });
    assert.equal(patched.ok, true);

    const { readFile } = await import("node:fs/promises");
    const round = JSON.parse(await readFile(path, "utf8"));
    assert.equal(round.permissions?.fs_write, "never", "permission override must survive");
    assert.deepEqual(round.approvedRoots, ["/home/user/notes"]);
    assert.equal(round.windows?.startOnLogin, true);
    // Sanity: enableTray was NOT touched (present or absent, its value at seed time
    // must be preserved).
    assert.equal(
      "enableTray" in (round.windows ?? {}) ? round.windows.enableTray : undefined,
      undefined,
      "the patcher must not invent keys",
    );
  });

  it("refuses to overwrite a file that is not a JSON object", async () => {
    // Otherwise a patch would silently reformat a file whose shape the user chose.
    const { writeFile, mkdir } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "vesper-cfg-bad-"));
    await mkdir(dir, { recursive: true });
    const path = join(dir, "vesper.json");
    await writeFile(path, "[1, 2, 3]", "utf8");
    const result = await patchConfigFile(path, { windows: { startOnLogin: true } });
    assert.equal(result.ok, false);
  });

  it("refuses prototype-poisoning keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vesper-cfg-proto-"));
    const path = join(dir, "vesper.json");
    const result = await patchConfigFile(path, {
      windows: { startOnLogin: true },
      __proto__: { granted: true },
    } as Record<string, unknown>);
    assert.equal(result.ok, true);
    const { readFile } = await import("node:fs/promises");
    const round = JSON.parse(await readFile(path, "utf8"));
    assert.equal("granted" in round, false);
    // The prototype was not polluted for other objects either.
    assert.equal(({} as Record<string, unknown>).granted, undefined);
  });
});

describe("the inspect path cannot be confused into a rewrite", () => {
  it("a transient reg.exe failure stays 'unknown', not 'absent'", async () => {
    // Directly asserted so any regression in `inspectStartupRegistration` reaches every
    // downstream consumer at once.
    const runner: WindowsRunner = async () => ({
      ok: false,
      code: 5,
      stdout: Buffer.from(""),
      stderr: "Access denied.",
      timedOut: false,
      aborted: false,
      error: null,
    });
    const state = await inspectStartupRegistration({ platform: "win32", runner });
    assert.equal(state.state, "unknown");
    assert.notEqual(state.state, "absent");
  });
});
