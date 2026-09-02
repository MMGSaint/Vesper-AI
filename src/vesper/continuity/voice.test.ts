import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_VOICE_FOOTHOLD, resolveWakeWord } from "./voice.ts";

describe("voice foothold", () => {
  it("disabled providers perform no capture", async () => {
    const wake = resolveWakeWord(DEFAULT_VOICE_FOOTHOLD);
    const listened = await wake.listen();
    assert.equal(listened.heard, false);
    assert.equal(listened.openedDevice, false);
    assert.equal(wake.status().capturing, false);
    assert.match(listened.detail, /No microphone was opened/);
  });

  it("enabling the module without the wake-word flag still opens nothing", async () => {
    const wake = resolveWakeWord({
      enabled: true,
      wakeWord: { enabled: false },
      asr: { enabled: false },
      tts: { enabled: false },
    });
    const listened = await wake.listen();
    assert.equal(listened.openedDevice, false);
    assert.equal(wake.enabled, false);
  });
});
