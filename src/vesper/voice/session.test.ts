import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createVoiceSession } from "./session.ts";
import { createDisabledVoice } from "./types.ts";
import { createSimulatedVoice } from "./providers.ts";

describe("voice session", () => {
  it("falls back to text when disabled", () => {
    const session = createVoiceSession(createDisabledVoice());
    const held = session.holdPtt();
    assert.equal(held.ok, false);
    assert.equal(session.diagnostics().hardwareValidated, false);
  });

  it("supports push-to-talk capture on the simulated provider", async () => {
    const session = createVoiceSession(createSimulatedVoice());
    const held = session.holdPtt();
    assert.equal(held.ok, true);
    const released = await session.releasePtt();
    assert.equal(released.ok, true);
    assert.equal(released.transcript, "simulated transcript");
    assert.equal(session.diagnostics().hardwareValidated, true);
  });

  it("can synthesize, play, and interrupt spoken output", async () => {
    const session = createVoiceSession(createSimulatedVoice());
    const spoken = await session.speak("hello");
    assert.equal(spoken.ok, true);
    assert.equal(session.mode(), "idle");
    session.holdPtt();
    assert.equal(session.interrupt().ok, true);
    assert.equal(session.mode(), "interrupted");
  });
});
