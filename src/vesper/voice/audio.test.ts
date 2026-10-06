import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDirectShowAudioDevices } from "./audio.ts";

describe("DirectShow audio parsing", () => {
  it("extracts only named audio devices and deduplicates them", () => {
    const stderr = [
      '[dshow @ 000001] "Microphone (USB Audio Device)" (audio)',
      '[dshow @ 000001] "Webcam" (video)',
      '[dshow @ 000001] "Microphone (USB Audio Device)" (audio)',
      '[dshow @ 000001] "Headset Microphone" (audio)',
    ].join("
");
    assert.deepEqual(parseDirectShowAudioDevices(stderr), [
      "Microphone (USB Audio Device)",
      "Headset Microphone",
    ]);
  });

  it("returns an empty list for unrelated output", () => {
    assert.deepEqual(parseDirectShowAudioDevices("ffmpeg error: device unavailable"), []);
  });
});
