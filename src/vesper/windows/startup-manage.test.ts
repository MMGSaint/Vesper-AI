/**
 * Startup reconciliation, exercised against a fake reg.exe on every platform.
 *
 * The purpose is to make it impossible to reintroduce the class of defect the
 * archaeology recorded: a repair path that acts on a transient failure, a state read
 * that cannot distinguish "we could not look" from "not registered", and a launcher
 * value that reaches reg.exe without ever being validated.
 *
 * Every case here uses the injectable `WindowsRunner`, which is the whole reason
 * `windows/exec.ts` documents that seam: "The runner is injectable so command
 * construction and output parsing can be tested on a machine that has no reg.exe."
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inspectStartupRegistration,
  reconcileStartupRegistration,
  snapshotStartupRegistration,
  formatStartupSnapshot,
} from "./startup-manage.ts";
import type { WindowsRunner } from "./exec.ts";
import type { WindowsCommand } from "./exec.ts";
import type { ProcessResult } from "../voice/process.ts";

interface Call {
  command: string;
  args: string[];
}

/** A runner scripted per invocation, recording what was asked. */
function scriptedRunner(script: Array<{ ok?: boolean; code?: number; stdout?: string; stderr?: string; error?: string | null }>): {
  runner: WindowsRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const runner: WindowsRunner = async (command: WindowsCommand) => {
    calls.push({ command: command.command, args: [...command.args] });
    const scripted = script[Math.min(index, script.length - 1)];
    index += 1;
    return {
      ok: scripted?.ok ?? true,
      code: scripted?.code ?? (scripted?.ok === false ? 1 : 0),
      stdout: Buffer.from(scripted?.stdout ?? "", "utf8"),
      stderr: scripted?.stderr ?? "",
      timedOut: false,
      aborted: false,
      error: scripted?.error ?? null,
    };
  };
  return { runner, calls };
}

const REGISTERED_STDOUT =
  "\r\n" +
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n" +
  "    Vesper    REG_SZ    C:\\Users\\me\\AppData\\Local\\Vesper\\bin\\vesper-host.cmd\r\n";

const NOT_FOUND_STDERR = "ERROR: The system was unable to find the specified registry key or value.";

describe("inspectStartupRegistration reports one of three honest states", () => {
  it("reports 'registered' with the exact target the runner returned", async () => {
    const { runner } = scriptedRunner([{ ok: true, stdout: REGISTERED_STDOUT }]);

    const state = await inspectStartupRegistration({ platform: "win32", runner });

    assert.equal(state.state, "registered");
    if (state.state === "registered") {
      assert.equal(state.target, "C:\\Users\\me\\AppData\\Local\\Vesper\\bin\\vesper-host.cmd");
    }
  });

  it("keeps 'unknown' distinct from 'absent' in the reader itself, not just the recon path", async () => {
    // A transient reg.exe failure (access denied, timeout, exec.exe missing) must NOT
    // be reported as 'absent'. The direct assertion of the property, so a downstream
    // caller that reads the state and decides for itself cannot regress this quietly.
    const { runner } = scriptedRunner([
      { ok: false, code: 5, stderr: "Access denied." },
      { ok: false, code: 5, stderr: "Access denied." },
    ]);
    const state = await inspectStartupRegistration({ platform: "win32", runner });
    assert.equal(state.state, "unknown");
    assert.notEqual(state.state, "absent");
  });

  it("reports 'absent' when reg.exe explicitly says the value is not there", async () => {
    // The reader in startup.ts maps this AND runner failure to registered:false. This
    // is the exact distinction reconcile must have to avoid re-registering on a
    // transient reg.exe failure.
    const { runner } = scriptedRunner([
      { ok: false, code: 1, stderr: NOT_FOUND_STDERR },
      { ok: false, code: 1, stderr: NOT_FOUND_STDERR },
    ]);

    const state = await inspectStartupRegistration({ platform: "win32", runner });

    assert.equal(state.state, "absent");
  });

  it("reports 'unknown' when reg.exe itself could not answer", async () => {
    // Access denied, reg.exe not on PATH, a hang the runner killed — none of these are
    // 'absent', and a repair path that treated them as such would rewrite on every
    // boot after a transient failure.
    const { runner } = scriptedRunner([
      { ok: false, code: 5, stderr: "Access denied." },
      { ok: false, code: 5, stderr: "Access denied." },
    ]);

    const state = await inspectStartupRegistration({ platform: "win32", runner });

    assert.equal(state.state, "unknown");
    assert.match(state.detail, /Access denied|could not answer/i);
  });

  it("reports 'unknown' on a non-Windows host", async () => {
    const state = await inspectStartupRegistration({ platform: "linux" });
    assert.equal(state.state, "unknown");
  });
});

describe("reconcileStartupRegistration converges idempotently or refuses honestly", () => {
  it("is unchanged when the entry already matches the intent", async () => {
    const { runner, calls } = scriptedRunner([{ ok: true, stdout: REGISTERED_STDOUT }]);

    const result = await reconcileStartupRegistration({
      intent: {
        enabled: true,
        launcher: "C:\\Users\\me\\AppData\\Local\\Vesper\\bin\\vesper-host.cmd",
      },
      platform: "win32",
      runner,
    });

    assert.equal(result.action, "unchanged");
    assert.equal(result.outcome, "in-sync");
    // Only the query happened — no add/delete.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.args[0], "query");
  });

  it("writes when the entry is absent and the intent is on", async () => {
    // Reads absent, then adds, then re-reads to confirm inspect would see the new value.
    const { runner, calls } = scriptedRunner([
      { ok: false, code: 1, stderr: NOT_FOUND_STDERR },
      { ok: false, code: 1, stderr: NOT_FOUND_STDERR },
      { ok: true, stdout: "" },
    ]);

    const result = await reconcileStartupRegistration({
      intent: { enabled: true, launcher: "C:\\Vesper\\bin\\vesper-host.cmd" },
      platform: "win32",
      runner,
    });

    assert.equal(result.action, "wrote");
    assert.equal(result.outcome, "changed");
    // The write call is `reg.exe add` with the exact target.
    const write = calls.find((c) => c.args[0] === "add");
    assert.ok(write, "an add must have been issued");
    assert.equal(write!.args.at(-2), "C:\\Vesper\\bin\\vesper-host.cmd");
  });

  it("removes when the entry is present and the intent is off", async () => {
    const { runner, calls } = scriptedRunner([{ ok: true, stdout: REGISTERED_STDOUT }, { ok: true, stdout: "" }]);

    const result = await reconcileStartupRegistration({
      intent: { enabled: false, launcher: null },
      platform: "win32",
      runner,
    });

    assert.equal(result.action, "removed");
    assert.equal(result.outcome, "changed");
    assert.ok(calls.some((c) => c.args[0] === "delete"));
  });

  it("is unchanged when the entry is already absent and the intent is off", async () => {
    const { runner, calls } = scriptedRunner([
      { ok: false, code: 1, stderr: NOT_FOUND_STDERR },
      { ok: false, code: 1, stderr: NOT_FOUND_STDERR },
    ]);

    const result = await reconcileStartupRegistration({
      intent: { enabled: false, launcher: null },
      platform: "win32",
      runner,
    });

    assert.equal(result.action, "unchanged");
    assert.equal(result.outcome, "in-sync");
    assert.ok(!calls.some((c) => c.args[0] === "delete"), "no delete may be attempted");
  });

  it("refuses to write a launcher that is not an absolute path to a Vesper launcher", async () => {
    // The startup value is never validated by the underlying primitive — the whole
    // point is that reg.exe runs the string on every logon. Containment belongs here.
    const { runner, calls } = scriptedRunner([{ ok: false, code: 1, stderr: NOT_FOUND_STDERR }]);
    for (const bad of [
      "vesper-host.cmd",
      "C:\\evil\\pwned.exe",
      "C:\\Vesper\\bin\\other-launcher.cmd",
      "C:\\Vesper\\bin\\vesper-host.cmd; calc.exe",
      "C:\\Vesper\\bin\\vesper-host.cmd\ncalc.exe",
    ]) {
      const result = await reconcileStartupRegistration({
        intent: { enabled: true, launcher: bad },
        platform: "win32",
        runner,
      });
      assert.equal(result.action, "refused", `should refuse ${JSON.stringify(bad)}`);
      assert.equal(result.outcome, "refused");
    }
    assert.ok(!calls.some((c) => c.args[0] === "add"), "no write may be attempted");
  });

  it("refuses when start-on-login is on but no launcher is configured", async () => {
    const { runner, calls } = scriptedRunner([{ ok: false, code: 1, stderr: NOT_FOUND_STDERR }]);

    const result = await reconcileStartupRegistration({
      intent: { enabled: true, launcher: null },
      platform: "win32",
      runner,
    });

    assert.equal(result.action, "refused");
    assert.match(result.detail, /no launcher path is configured/i);
    assert.ok(!calls.some((c) => c.args[0] === "add"));
  });

  it("refuses to act when the current state could not be read", async () => {
    // The exact regression the three-state inspect() exists for: a transient failure
    // must not cause a rewrite, because otherwise the reconcile is doing exactly what
    // it is supposed to prevent.
    const { runner, calls } = scriptedRunner([
      { ok: false, code: 5, stderr: "Access denied." },
      { ok: false, code: 5, stderr: "Access denied." },
    ]);

    const result = await reconcileStartupRegistration({
      intent: { enabled: true, launcher: "C:\\Vesper\\bin\\vesper-host.cmd" },
      platform: "win32",
      runner,
    });

    assert.equal(result.action, "unknown");
    assert.equal(result.outcome, "unable");
    assert.ok(!calls.some((c) => c.args[0] === "add" || c.args[0] === "delete"));
  });

  it("is a no-op on a non-Windows host, and says so", async () => {
    const result = await reconcileStartupRegistration({
      intent: { enabled: true, launcher: "/opt/vesper/bin/vesper-host.mjs" },
      platform: "linux",
    });
    assert.equal(result.outcome, "unable");
    assert.match(result.detail, /Windows/);
  });

  it("compares targets case-insensitively on Windows, since NTFS is", async () => {
    const { runner, calls } = scriptedRunner([{ ok: true, stdout: REGISTERED_STDOUT }]);
    const result = await reconcileStartupRegistration({
      intent: {
        enabled: true,
        launcher: "c:\\users\\me\\appdata\\local\\vesper\\bin\\vesper-host.cmd",
      },
      platform: "win32",
      runner,
    });
    assert.equal(result.action, "unchanged", "case must not trigger a rewrite");
    assert.ok(!calls.some((c) => c.args[0] === "add"));
  });

  it("treats a quoted registered target as equivalent to the unquoted intent", async () => {
    // The PowerShell installer wrote the value wrapped in literal double quotes; the
    // reader captures them verbatim. Round-tripping through reconcile would otherwise
    // rewrite on every boot.
    const quoted =
      '"C:\\Users\\me\\AppData\\Local\\Vesper\\bin\\vesper-host.cmd"';
    const { runner, calls } = scriptedRunner([
      {
        ok: true,
        stdout:
          "\r\n" +
          "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n" +
          "    Vesper    REG_SZ    " + quoted + "\r\n",
      },
    ]);
    const result = await reconcileStartupRegistration({
      intent: {
        enabled: true,
        launcher: "C:\\Users\\me\\AppData\\Local\\Vesper\\bin\\vesper-host.cmd",
      },
      platform: "win32",
      runner,
    });
    assert.equal(result.action, "unchanged");
    assert.ok(!calls.some((c) => c.args[0] === "add"));
  });
});

describe("snapshotStartupRegistration is a diagnostic, not a write", () => {
  it("is in-sync when a matching entry is present", async () => {
    const { runner } = scriptedRunner([{ ok: true, stdout: REGISTERED_STDOUT }]);
    const snapshot = await snapshotStartupRegistration({
      intent: {
        enabled: true,
        launcher: "C:\\Users\\me\\AppData\\Local\\Vesper\\bin\\vesper-host.cmd",
      },
      platform: "win32",
      runner,
    });
    assert.equal(snapshot.inSync, true);
  });

  it("is trivially in-sync when a Linux host wants start-on-login off", async () => {
    const snapshot = await snapshotStartupRegistration({
      intent: { enabled: false, launcher: null },
      platform: "linux",
    });
    assert.equal(snapshot.inSync, true);
  });

  it("is out of sync when a Linux host wants start-on-login on", async () => {
    const snapshot = await snapshotStartupRegistration({
      intent: { enabled: true, launcher: "/opt/vesper/bin/vesper-host.mjs" },
      platform: "linux",
    });
    assert.equal(snapshot.inSync, false);
  });

  it("formats the snapshot for a human", async () => {
    const snapshot = await snapshotStartupRegistration({
      intent: { enabled: false, launcher: null },
      platform: "linux",
    });
    const text = formatStartupSnapshot(snapshot);
    assert.match(text, /Startup preference: off/);
    assert.match(text, /In sync/);
  });
});
