import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeInstallPlan, describeResetPlan, describeUninstallPlan } from "./packaging.ts";
import { createNativeTrayAdapter } from "./native-tray.ts";
import { detectApprovedApps } from "./apps.ts";
import { createLifecycleController } from "./lifecycle.ts";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_APPS } from "../config.ts";

describe("windows packaging and lifecycle", () => {
  it("describes install/uninstall/reset without claiming they were applied", () => {
    const install = describeInstallPlan({ platform: "linux", registerStartup: true });
    assert.equal(install.kind, "install");
    assert.equal(install.steps.every((step) => step.applied === false), true);
    assert.ok(install.notes.some((note) => /not windows|hardware-dependent/i.test(note)));
    const uninstall = describeUninstallPlan({ purgeData: true, platform: "win32" });
    assert.equal(uninstall.kind, "uninstall");
    const reset = describeResetPlan({ platform: "win32" });
    assert.equal(reset.kind, "reset");
    assert.ok(reset.notes.some((note) => /optimizer/i.test(note)));
  });

  it("defines a native tray without applying Shell_NotifyIcon on Linux", () => {
    const tray = createNativeTrayAdapter({ platform: "linux" });
    assert.equal(tray.available, false);
    const attached = tray.attach({
      state: "running",
      startedAt: null,
      paused: false,
      startOnLogin: false,
    });
    // The wording may change; what must not is that it never claims an icon exists.
    assert.equal(attached.ok, false);
    assert.match(attached.summary, /only runs on Windows|no icon was created|not applied/i);
    assert.equal(tray.applied, false);
  });

  it("detects approved apps from a process list", () => {
    const detected = detectApprovedApps(DEFAULT_APPS, [
      { pid: 1, name: "VRChat.exe", title: "VRChat" },
    ]);
    assert.equal(detected.find((item) => item.app.id === "vrchat")?.running, true);
    assert.equal(detected.find((item) => item.app.id === "obs")?.running, false);
  });

  it("runs isolated shutdown hooks", async () => {
    const root = join(tmpdir(), `vesper-life-${Date.now()}`);
    await mkdir(join(root, "data"), { recursive: true });
    await mkdir(join(root, "logs"), { recursive: true });
    const life = createLifecycleController({
      dirs: { root, config: join(root, "config"), data: join(root, "data"), logs: join(root, "logs"), models: join(root, "models") },
      hooks: [
        {
          name: "boom",
          run: () => {
            throw new Error("hook failed");
          },
        },
      ],
    });
    const result = await life.shutdown("test");
    assert.equal(result.ok, false);
    assert.match(result.summary, /hook failed/);
  });
});
