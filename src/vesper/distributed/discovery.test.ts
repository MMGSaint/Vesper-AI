import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDiscoveryProbes, type DiscoverySubjects } from "./discovery.ts";
import { capabilityState, discoverCapabilities, manifestHas } from "./capabilities.ts";
import { testRuntime } from "../test-helpers.ts";

function subjects(patch: Partial<DiscoverySubjects> = {}): DiscoverySubjects {
  return {
    models: { status: () => ({ available: [] }) },
    voice: { status: () => ({ available: false, stt: "", tts: "" }) },
    optimizer: async () => undefined as never,
    obs: {},
    tools: { list: () => [] },
    hostPosture: "owned",
    ...patch,
  } as DiscoverySubjects;
}

async function manifest(patch: Partial<DiscoverySubjects> = {}) {
  return discoverCapabilities({
    deviceId: "dev_test",
    probes: buildDiscoveryProbes(
      subjects({
        optimizer: { getStatus: async () => ({ available: false, mode: "unavailable" as const, detail: "no" }) },
        ...patch,
      }),
    ),
  });
}

describe("capability discovery asks rather than assumes", () => {
  it("does not report a local LLM on a device where no backend answered", async () => {
    const none = await manifest();
    assert.equal(manifestHas(none, "local_llm"), false);

    const withLocal = await manifest({
      models: { status: () => ({ available: [{ id: "ollama", kind: "local", available: true }] }) },
    });
    assert.equal(manifestHas(withLocal, "local_llm"), true);
  });

  it("does not count an unreachable backend as a backend", async () => {
    const unreachable = await manifest({
      models: { status: () => ({ available: [{ id: "ollama", kind: "local", available: false }] }) },
    });
    assert.equal(manifestHas(unreachable, "local_llm"), false);
  });

  it("never reports NEXUS as available when the adapter is a mock", async () => {
    // The mock adapter answers `available: true` — it is a working mock. Treating that
    // as the capability would let a peer route real optimization work to a device that
    // can only pretend to perform it, and would let Vesper claim an optimization
    // happened when nothing touched the machine.
    const mocked = await manifest({
      optimizer: {
        getStatus: async () => ({
          available: true,
          mode: "mock" as const,
          detail: "Mock optimizer adapter. The real PC optimizer API is not connected.",
        }),
      },
    });
    assert.equal(manifestHas(mocked, "nexus"), false);
    assert.equal(capabilityState(mocked, "nexus"), "NOT_CONFIGURED");

    const live = await manifest({
      optimizer: {
        getStatus: async () => ({ available: true, mode: "live" as const, detail: "NEXUS 2.1" }),
      },
    });
    assert.equal(manifestHas(live, "nexus"), true);
  });

  it("distinguishes 'we asked and it said no' from 'nothing is wired up'", async () => {
    // UNAVAILABLE and NOT_CONFIGURED are different claims. Collapsing them would report
    // an unbuilt feature as a broken one.
    const m = await manifest();
    assert.equal(capabilityState(m, "voice_stt"), "UNAVAILABLE", "voice was asked");
    assert.equal(capabilityState(m, "sync"), "NOT_CONFIGURED", "sync has no transport");
    assert.equal(capabilityState(m, "windows_control"), "NOT_CONFIGURED", "no windows host");
  });

  it("refuses to execute other devices' tasks while on a foreign host", async () => {
    // The portable case: the machine underneath is not the user's, so this Vesper may
    // ask for work to be done elsewhere but must not become the worker.
    const foreign = await manifest({ hostPosture: "foreign" });
    assert.equal(manifestHas(foreign, "task_execute"), false);
    assert.equal(manifestHas(foreign, "task_create"), true, "it can still ask");

    const owned = await manifest({ hostPosture: "owned" });
    assert.equal(manifestHas(owned, "task_execute"), true);
  });

  it("reports a probe that throws as unavailable with the reason, not as absent", async () => {
    const broken = await manifest({
      optimizer: {
        getStatus: async () => {
          throw new Error("socket hang up");
        },
      },
    });
    assert.equal(capabilityState(broken, "nexus"), "UNAVAILABLE");
    const finding = broken.findings.find((item) => item.id === "nexus");
    assert.match(finding?.detail ?? "", /socket hang up/);
  });
});

describe("wiring: a started runtime knows what it can do", () => {
  it("records its own manifest so routing has something to match against", async () => {
    // Without this the registry holds a device with no manifest, and routing correctly
    // refuses every capability-bearing task — which looks exactly like a machine that
    // cannot do anything.
    const runtime = await testRuntime();
    const self = await runtime.devices.get(runtime.deviceIdentity.deviceId);
    assert.ok(self?.capabilities, "the running device recorded no capability manifest");
    assert.equal(manifestHas(self.capabilities, "conversation"), true);

    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: { description: "summarise my notes", requiredCapabilities: ["conversation"] },
      workspaceId: "general",
    });
    assert.match(
      queued.result?.summary ?? "",
      /Assigned to/,
      "a task this device can do was not routed to it",
    );
    await runtime.stop();
  });

  it("never lists a capability whose detail says it is assumed", async () => {
    // The module's rule: "assumed" is never an acceptable answer.
    const runtime = await testRuntime();
    const self = await runtime.devices.get(runtime.deviceIdentity.deviceId);
    for (const finding of self?.capabilities?.findings ?? []) {
      assert.ok(finding.detail.length > 0, `${finding.id} has no explanation`);
      assert.doesNotMatch(finding.detail, /assum/i, `${finding.id} was assumed, not probed`);
    }
    await runtime.stop();
  });
});
