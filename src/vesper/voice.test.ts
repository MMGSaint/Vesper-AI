import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDisabledVoice } from "./voice/types.ts";
import { createSimulatedVoice, createVoiceModule } from "./voice/providers.ts";
import { testRuntime } from "./test-helpers.ts";

describe("voice", () => {
  it("stays disabled by default", async () => {
    const runtime = await testRuntime();
    assert.equal(runtime.voice.enabled, false);
    assert.equal(runtime.voice.available(), false);
    const disabled = createDisabledVoice();
    const spoken = await disabled.tts.speak("hello");
    assert.equal(spoken.available, false);
  });

  it("simulated provider is labeled and optional", async () => {
    const voice = createSimulatedVoice();
    const text = await voice.stt.transcribe(new Uint8Array());
    assert.equal(text.available, true);
    assert.match(text.detail, /simulated/i);
  });

  it("does not claim audio capture when binaries are missing", async () => {
    const voice = await createVoiceModule({
      enabled: true,
      stt: "faster-whisper",
      tts: "piper",
      which: async () => false,
    });
    assert.equal(voice.available(), false);
    assert.match(voice.status().detail, /not installed|optional|not found|disabled/i);
  });
});
