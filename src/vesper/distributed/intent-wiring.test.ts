import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrolCompanion, testRuntime } from "../test-helpers.ts";
import type { CapabilityManifest } from "./capabilities.ts";

function manifest(deviceId: string, available: string[]): CapabilityManifest {
  return {
    deviceId,
    generatedAt: "2026-01-01T00:00:00.000Z",
    findings: available.map((id) => ({ id: id as never, state: "AVAILABLE" as const, detail: "probed" })),
  };
}

/** A capable desktop that is currently switched off. */
async function offlineDesktop(runtime: Awaited<ReturnType<typeof testRuntime>>) {
  const desktop = await enrolCompanion(runtime, { name: "desktop" });
  await runtime.devices.setCapabilities(
    desktop.deviceId,
    manifest(desktop.deviceId, ["conversation", "task_execute"]),
  );
  // Enrolment is itself contact, so a freshly enrolled device is online. Switch it off.
  await runtime.devices.recordPresence(desktop.deviceId, { reachability: "offline" });
  return desktop;
}

describe("naming a device is a constraint, not a preference", () => {
  it("does not run work on another machine when the named one is offline", async () => {
    // "Prepare my desktop for VRChat" is not a request to do something to the laptop.
    // Substituting a device and reporting success is how an action lands on a machine
    // it was never meant for.
    const runtime = await testRuntime();
    const desktop = await offlineDesktop(runtime);

    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: {
        description: "prepare for VRChat",
        requiredCapabilities: ["conversation"],
        targetDevice: "desktop",
      },
      workspaceId: "general",
    });

    const summary = queued.result?.summary ?? "";
    assert.doesNotMatch(
      summary,
      new RegExp(`Assigned to (?!${desktop.deviceId})`),
      `the task was reassigned away from the named device: ${summary}`,
    );
    assert.match(summary, /offline|not assigned/i, `expected an honest hold, got: ${summary}`);
    await runtime.stop();
  });

  it("says so plainly when no enrolled device matches the name", async () => {
    const runtime = await testRuntime();
    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: { description: "render the timelapse", targetDevice: "laptop" },
      workspaceId: "general",
    });
    assert.equal(queued.result?.ok, false);
    assert.match(queued.result?.summary ?? "", /No enrolled device matches/i);
    await runtime.stop();
  });

  it("still routes normally when no device is named", async () => {
    // The control must not turn every task into a refusal.
    const runtime = await testRuntime();
    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: { description: "summarise my notes", requiredCapabilities: ["conversation"] },
      workspaceId: "general",
    });
    assert.match(queued.result?.summary ?? "", /Assigned to/);
    await runtime.stop();
  });
});

describe("a named device stays named for the life of the task", () => {
  it("never migrates the work to another machine after the named one drops off", async () => {
    // Resolving at creation time is not enough. A task created for the desktop while it
    // was online must not be picked up by the laptop when the desktop goes away — the
    // user named a machine, and that is a property of the task, not of the moment it
    // was created.
    const runtime = await testRuntime();
    const desktop = await enrolCompanion(runtime, { name: "desktop" });
    await runtime.devices.setCapabilities(
      desktop.deviceId,
      manifest(desktop.deviceId, ["conversation", "task_execute"]),
    );

    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: {
        description: "prepare for VRChat",
        requiredCapabilities: ["conversation"],
        targetDevice: "desktop",
      },
      workspaceId: "general",
    });
    assert.match(
      queued.result?.summary ?? "",
      new RegExp(`Assigned to ${desktop.deviceId}`),
      "the named, online, capable device should have taken the task",
    );

    // The desktop is switched off before the task runs.
    await runtime.devices.recordPresence(desktop.deviceId, { reachability: "offline" });
    await runtime.taskQueue.schedule(await runtime.devices.list());

    const tasks = await runtime.taskQueue.list();
    const task = tasks.find((item) => item.description === "prepare for VRChat");
    assert.notEqual(
      task?.assignedTo,
      runtime.deviceIdentity.deviceId,
      "the task migrated to this machine after the named device went offline",
    );
    // The load-bearing assertion: the name is recorded on the task as a hard
    // constraint, not merely honoured at the moment it was created. `preferredDevice`
    // would not survive this — routing treats it as a hint and falls through when the
    // preferred machine is unavailable.
    assert.deepEqual(
      task?.eligibleDevices,
      [desktop.deviceId],
      "the named device was not recorded as a constraint on the task",
    );
    await runtime.stop();
  });
});
