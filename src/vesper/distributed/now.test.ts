import assert from "node:assert/strict";
import test from "node:test";
import { buildNow, renderNow } from "./now.ts";
import { classifyDeviceIntent, resolveTarget } from "./intent.ts";
import type { DeviceRecord } from "./registry.ts";
import type { TrustState } from "./identity.ts";

function device(input: {
  id: string;
  name: string;
  type?: "desktop" | "laptop" | "phone";
  trust?: TrustState;
  online?: boolean;
  activity?: DeviceRecord["presence"]["activity"];
  capabilities?: string[];
}): DeviceRecord {
  return {
    identity: {
      deviceId: input.id,
      deviceType: input.type ?? "desktop",
      name: input.name,
      os: "windows",
      publicKey: "k",
      createdAt: "2026-01-01T00:00:00.000Z",
      vesperVersion: "test",
    },
    trust: input.trust ?? "trusted",
    presence: {
      reachability: input.online === false ? "offline" : "online",
      activity: input.activity ?? "idle",
      lastSeen: "2026-01-01T00:00:00.000Z",
    },
    capabilities: input.capabilities
      ? {
          deviceId: input.id,
          generatedAt: "2026-01-01T00:00:00.000Z",
          findings: input.capabilities.map((id) => ({
            id: id as never,
            state: "AVAILABLE" as const,
            detail: "probed",
          })),
        }
      : null,
    enrolledAt: "2026-01-01T00:00:00.000Z",
    revokedAt: null,
  };
}

const DESKTOP = device({ id: "dev_desktop", name: "desktop-main", capabilities: ["local_llm", "nexus"] });
const LAPTOP = device({ id: "dev_laptop", name: "laptop-main", type: "laptop", activity: "active" });
const PHONE = device({ id: "dev_phone", name: "phone", type: "phone", activity: "background" });

test("device intent", async (t) => {
  await t.test("an unqualified request stays on the current device", () => {
    for (const text of ["open discord", "what's happening?", "remember that I stream on Fridays"]) {
      assert.equal(classifyDeviceIntent(text).kind, "current", text);
    }
  });

  await t.test("naming a machine targets that machine", () => {
    for (const [text, hint] of [
      ["start my desktop", "desktop"],
      ["prepare my PC for VRChat", "desktop"],
      ["check the laptop", "laptop"],
      ["send it to my phone", "phone"],
    ] as const) {
      const intent = classifyDeviceIntent(text);
      assert.equal(intent.kind, "device", text);
      assert.equal(intent.kind === "device" && intent.hint, hint);
    }
  });

  await t.test("asking Vesper to choose is its own intent", () => {
    for (const text of ["run this benchmark wherever is best", "do it on whichever machine is fastest"]) {
      assert.equal(classifyDeviceIntent(text).kind, "best", text);
    }
  });

  await t.test("a named offline device is never silently swapped for another", () => {
    // This is the failure the whole module exists to prevent: issuing "prepare my PC for
    // VRChat" from the laptop must not prepare the laptop.
    const resolved = resolveTarget({
      intent: classifyDeviceIntent("prepare my PC for VRChat"),
      devices: [device({ id: "dev_desktop", name: "desktop-main", online: false }), LAPTOP],
      currentDeviceId: "dev_laptop",
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.problem ?? "", /offline\. I did not substitute another device/);
    assert.equal(resolved.device?.identity.name, "desktop-main");
  });

  await t.test("a named device that is not trusted cannot be asked to act", () => {
    const resolved = resolveTarget({
      intent: classifyDeviceIntent("run it on my desktop"),
      devices: [device({ id: "dev_desktop", name: "desktop-main", trust: "restricted" })],
      currentDeviceId: "dev_laptop",
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.problem ?? "", /'restricted', so it cannot be asked to act/);
  });

  await t.test("a named, online, capable device resolves", () => {
    const resolved = resolveTarget({
      intent: classifyDeviceIntent("benchmark models on my desktop"),
      devices: [DESKTOP, LAPTOP],
      currentDeviceId: "dev_laptop",
      requiredCapabilities: ["local_llm"],
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.device?.identity.name, "desktop-main");
  });

  await t.test("a local request that this device cannot serve says what is missing", () => {
    const resolved = resolveTarget({
      intent: classifyDeviceIntent("summarise this with a local model"),
      devices: [LAPTOP],
      currentDeviceId: "dev_laptop",
      requiredCapabilities: ["local_llm"],
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.problem ?? "", /does not have: local_llm/);
  });

  await t.test("best-effort prefers an idle machine and never picks an untrusted one", () => {
    const resolved = resolveTarget({
      intent: classifyDeviceIntent("run this benchmark wherever is best"),
      devices: [
        DESKTOP,
        device({ id: "dev_usb", name: "usb-portable", trust: "restricted", capabilities: ["local_llm"] }),
      ],
      currentDeviceId: "dev_usb",
      requiredCapabilities: ["local_llm"],
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.device?.identity.name, "desktop-main");
  });

  await t.test("best-effort with nothing capable runs nothing and says so", () => {
    const resolved = resolveTarget({
      intent: classifyDeviceIntent("run this wherever is best"),
      devices: [LAPTOP, PHONE],
      currentDeviceId: "dev_laptop",
      requiredCapabilities: ["nexus"],
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.problem ?? "", /queued nothing and run nothing/);
  });
});

test("Vesper Now", async (t) => {
  const base = {
    self: LAPTOP,
    hostPosture: "owned" as const,
    workspace: "development",
    devices: [DESKTOP, LAPTOP, PHONE],
    tasks: [],
    models: { active: "auto", available: [{ id: "ollama", available: false }, { id: "echo", available: true }] },
    voice: "disabled",
    optimizer: "mock",
    now: () => "2026-08-26T12:00:00.000Z",
  };

  await t.test("summarises the ecosystem from the current device's point of view", () => {
    const now = buildNow(base);
    assert.equal(now.activeDevice.name, "laptop-main");
    assert.equal(now.devices.find((d) => d.isCurrent)?.name, "laptop-main");
    assert.deepEqual(now.devices.find((d) => d.name === "desktop-main")?.headline, ["local_llm", "nexus"]);
    assert.deepEqual(now.models.available, ["echo"], "only reachable providers are listed");
  });

  await t.test("renders compactly and names offline devices as offline", () => {
    const now = buildNow({ ...base, devices: [device({ id: "dev_desktop", name: "desktop-main", online: false }), LAPTOP] });
    const text = renderNow(now);
    assert.match(text, /Active device: laptop-main \(trusted\)/);
    assert.match(text, /desktop-main \(desktop, trusted\): offline/);
    assert.ok(text.split("\n").length < 12, "this is included every turn; it has to stay small");
  });

  await t.test("a foreign host is stated plainly in the context the model sees", () => {
    const text = renderNow(buildNow({ ...base, hostPosture: "foreign" }));
    assert.match(text, /host that is not yours/);
    assert.match(text, /able to observe this session/);
  });

  await t.test("task counts appear only when there are tasks", () => {
    assert.ok(!renderNow(buildNow(base)).includes("Tasks:"));
    const busy = renderNow(
      buildNow({
        ...base,
        tasks: [
          { state: "queued" } as never,
          { state: "running" } as never,
          { state: "failed" } as never,
        ],
      }),
    );
    assert.match(busy, /Tasks: 1 running, 1 queued, 0 blocked, 1 failed/);
  });

  await t.test("says plainly when nothing else is enrolled", () => {
    const text = renderNow(buildNow({ ...base, devices: [LAPTOP] }));
    assert.match(text, /Other devices: none enrolled/);
  });
});
