/**
 * Deterministic multi-device scenarios for the continuity substrate.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryCloudProvider } from "./cloud.ts";
import { createKeyring, revokeDevice } from "./crypto.ts";
import { ContinuityEngine } from "./engine.ts";
import { bumpContinuity, createContinuity, formatHandoff, resolveContinuity } from "./conversation.ts";
import { CurrentStateStore } from "./currency.ts";
import { buildSyncRecord } from "./records.ts";
import { continuityPayload } from "./conversation.ts";
import type { SyncRecord } from "./types.ts";
import { disabledVoiceStatus, honestNexusMode } from "./status.ts";
import { selectModel } from "./routing.ts";
import { resolveWakeWord, DEFAULT_VOICE_FOOTHOLD } from "./voice.ts";
import { portableLayout } from "./portable.ts";

function sharedMemory(deviceId: string, entityId: string, value: string, version = 1): SyncRecord {
  return buildSyncRecord({
    entityType: "memory",
    entityId,
    sourceDeviceId: deviceId,
    operation: "update",
    payload: { value },
    privacy: "shared",
    trust: "user",
    origin: deviceId,
    version,
  });
}

async function pairedCloud() {
  const cloud = new MemoryCloudProvider();
  const ring = createKeyring();
  const pcAuth = await cloud.authenticate("dev_pc");
  const laptopAuth = await cloud.authenticate("dev_laptop");
  const usbAuth = await cloud.authenticate("dev_usb");
  assert.ok("token" in pcAuth && "token" in laptopAuth && "token" in usbAuth);
  await cloud.registerDevice(pcAuth, "pk-pc");
  await cloud.registerDevice(laptopAuth, "pk-laptop");
  await cloud.registerDevice(usbAuth, "pk-usb");
  return { cloud, ring, pcAuth, laptopAuth, usbAuth };
}

describe("multi-device scenarios", () => {
  it("device A writes, device B pulls, state matches", async () => {
    const { cloud, ring, pcAuth, laptopAuth } = await pairedCloud();
    const pc = new ContinuityEngine({ localDeviceId: "dev_pc" });
    const laptop = new ContinuityEngine({ localDeviceId: "dev_laptop" });
    pc.enqueue(sharedMemory("dev_pc", "project", "Vesper sync"));
    await pc.exchange({ provider: cloud, auth: pcAuth, ring, local: [], apply: () => undefined });
    const received: SyncRecord[] = [];
    await laptop.exchange({
      provider: cloud,
      auth: laptopAuth,
      ring,
      local: [],
      apply: (record) => {
        received.push(record);
      },
    });
    assert.equal(received.length, 1);
    assert.equal(received[0]?.payload.value, "Vesper sync");
    assert.equal(received[0]?.provenance.trust, "synced_user_data");
  });

  it("offline divergence reconnects as a deterministic conflict", async () => {
    const { cloud, ring, pcAuth, laptopAuth } = await pairedCloud();
    const pc = new ContinuityEngine({ localDeviceId: "dev_pc" });
    const laptop = new ContinuityEngine({ localDeviceId: "dev_laptop" });
    const base = sharedMemory("dev_pc", "stream.day", "Friday");
    pc.enqueue(base);
    await pc.exchange({ provider: cloud, auth: pcAuth, ring, local: [], apply: () => undefined });
    const pulled: SyncRecord[] = [];
    await laptop.exchange({
      provider: cloud,
      auth: laptopAuth,
      ring,
      local: [],
      apply: (record) => {
        pulled.push(record);
      },
    });
    cloud.setConnected(false);
    const pcEdit = sharedMemory("dev_pc", "stream.day", "Thursday", 2);
    const laptopEdit = sharedMemory("dev_laptop", "stream.day", "Saturday", 2);
    pc.enqueue(pcEdit);
    laptop.enqueue(laptopEdit);
    cloud.setConnected(true);
    await pc.exchange({ provider: cloud, auth: pcAuth, ring, local: [pcEdit], apply: () => undefined });
    const outcome = await laptop.exchange({
      provider: cloud,
      auth: laptopAuth,
      ring,
      local: [laptopEdit],
      apply: () => undefined,
    });
    assert.ok(outcome.conflicts.some((item) => item.entityId === "stream.day"));
  });

  it("conversation on A resumes on B, then USB, then PC", () => {
    const pc = createContinuity({
      conversationId: "convo_sync",
      title: "Vesper sync",
      summary: "Encrypted continuity.",
      currentGoal: "Ship the outbox",
      decisions: ["Ciphertext in the cloud"],
      openQuestions: ["Pairing UX"],
      deviceId: "dev_pc",
      workspaceId: "development",
      recentWindow: [{ role: "user", text: "We're working on Vesper sync.", at: "2026-09-02T01:00:00.000Z" }],
    });
    const laptop = bumpContinuity(pc, { currentGoal: "Write the laptop merge test" }, "dev_laptop");
    const toLaptop = resolveContinuity(null, laptop);
    assert.equal(toLaptop.decision, "remote");
    const usb = bumpContinuity(laptop, { pendingActions: ["Copy onto the stick"] }, "dev_usb");
    const backOnPc = resolveContinuity(pc, usb);
    assert.equal(backOnPc.decision, "remote");
    const prompt = formatHandoff(backOnPc.winner!);
    assert.match(prompt, /Copy onto the stick/);
    assert.match(prompt, /We're working on Vesper sync/);
  });

  it("revoked device cannot sync", async () => {
    const { cloud, ring, pcAuth, usbAuth } = await pairedCloud();
    revokeDevice(ring, "dev_usb");
    await cloud.revokeDevice(pcAuth, "dev_usb");
    const usb = new ContinuityEngine({ localDeviceId: "dev_usb" });
    usb.enqueue(sharedMemory("dev_usb", "note", "from usb"));
    const auth = await cloud.authenticate("dev_usb");
    assert.ok("ok" in auth && auth.ok === false);
    const outcome = await usb.exchange({
      provider: cloud,
      auth: usbAuth,
      ring,
      local: [],
      apply: () => {
        throw new Error("must not apply");
      },
    });
    assert.ok(outcome.rejected.length + (outcome.offlineReason ? 1 : 0) > 0);
  });

  it("USB relative paths work from an arbitrary root", () => {
    const dirs = portableLayout("/run/media/user/VESPER");
    assert.equal(dirs.data.startsWith("/run/media/user/VESPER"), true);
  });

  it("NEXUS mock is never reported live, and disabled voice does not capture", async () => {
    assert.equal(honestNexusMode({ mode: "mock", endpoint: null }), "mock");
    assert.equal(honestNexusMode({ mode: "live", endpoint: null }), "stub");
    const voice = disabledVoiceStatus();
    assert.equal(voice.asr.capturing, false);
    assert.equal(voice.wakeWord.capturing, false);
    const wake = resolveWakeWord(DEFAULT_VOICE_FOOTHOLD);
    assert.equal((await wake.listen()).openedDevice, false);
  });

  it("continuity payload is data, not a tool", () => {
    const continuity = createContinuity({
      title: "x",
      summary: "y",
      deviceId: "dev_pc",
      workspaceId: "general",
    });
    const payload = continuityPayload(continuity);
    const record = buildSyncRecord({
      entityType: "conversation_continuity",
      entityId: continuity.conversationId,
      sourceDeviceId: "dev_pc",
      operation: "update",
      payload,
      privacy: "shared",
      trust: "user",
      origin: "pc",
    });
    assert.equal(record.entityType, "conversation_continuity");
  });

  it("current-state facts survive a laptop overwrite as history", () => {
    const store = new CurrentStateStore();
    store.remember({
      subject: "sarah.employer",
      value: "X",
      source: "user",
      deviceId: "dev_pc",
      at: "2026-01-01T00:00:00.000Z",
    });
    store.mergeRemote({
      id: "fact_y",
      subject: "sarah.employer",
      value: "Y",
      currency: "current",
      source: "user",
      at: "2026-09-01T00:00:00.000Z",
      provenance: { trust: "synced_user_data", deviceId: "dev_laptop" },
      confidence: 1,
    });
    assert.equal(store.current("sarah.employer")?.value, "Y");
    assert.equal(store.history("sarah.employer").some((item) => item.value === "X"), true);
  });

  it("routing capability mismatch blocks vision on a text-only local set", () => {
    assert.equal(
      selectModel(
        [
          {
            provider: "ollama",
            model: "qwen3:14b",
            capabilities: { tools: true, vision: false, speech: false },
            contextTokens: 32_000,
            estimatedMemoryMB: 10_000,
            latency: "medium",
            quality: "everyday",
            location: "local",
            available: true,
            priority: 5,
          },
        ],
        { vision: true },
        "desktop",
      ),
      null,
    );
  });

  it("a suspended pairing cannot apply inbound records", async () => {
    const { cloud, ring, pcAuth, usbAuth } = await pairedCloud();
    const pc = new ContinuityEngine({ localDeviceId: "dev_pc" });
    pc.enqueue(sharedMemory("dev_pc", "goal", "one assistant"));
    await pc.exchange({ provider: cloud, auth: pcAuth, ring, local: [], apply: () => undefined });
    const usb = new ContinuityEngine({ localDeviceId: "dev_usb" });
    const applied: string[] = [];
    const outcome = await usb.exchange({
      provider: cloud,
      auth: usbAuth,
      ring,
      local: [],
      apply: (record) => {
        applied.push(record.entityId);
      },
      senderSuspended: (id) => id === "dev_pc",
    });
    assert.equal(applied.length, 0);
    assert.ok(outcome.withheld.some((item) => /suspended/.test(item.reason)));
  });
});
