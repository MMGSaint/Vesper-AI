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

  it("supports push-to-talk and interrupt on the simulated provider", async () => {
    const session = createVoiceSession(createSimulatedVoice());
    const held = session.holdPtt();
    assert.equal(held.ok, true);
    const released = await session.releasePtt();
    assert.equal(released.ok, true);
    session.holdPtt();
    const interrupted = session.interrupt();
    assert.equal(interrupted.ok, true);
    assert.equal(session.mode(), "interrupted");
  });
});
