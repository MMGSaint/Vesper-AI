import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wakePhraseHeard, textAfterWakePhrase, createVoiceActivationController } from "./activation.ts";
import type { VoiceAudioIo } from "./audio.ts";
import type { VoiceModule } from "./types.ts";

function fakeVoice(transcripts: string[]): VoiceModule {
  let index = 0;
  const audio: VoiceAudioIo = {
    id: "fake-audio",
    platform: "win32",
    ffmpeg: "fake",
    ffplay: "fake",
    async listInputDevices() {
      return { available: true, devices: ["Mic"], detail: "fake" };
    },
    async captureWav() {
      return { available: true, audio: new Uint8Array([1, 2, 3]), device: "Mic", detail: "captured" };
    },
    async playWav() {
      return { available: true, detail: "played" };
    },
    status() {
      return { available: true, devices: ["Mic"], selectedDevice: "Mic", detail: "fake" };
    },
  };
  return {
    enabled: true,
    stt: {
      id: "fake-stt",
      async transcribe() {
        const text = transcripts[Math.min(index++, transcripts.length - 1)] ?? "";
        return { text, available: true, detail: "fake stt" };
      },
    },
    tts: {
      id: "fake-tts",
      async speak() {
        return { available: true, audio: new Uint8Array([1, 2, 3]), detail: "fake tts" };
      },
    },
    audio,
    pushToTalkBound: true,
    captureSeconds: 1,
    speakResponses: true,
    available: () => true,
    audioAvailable: () => true,
    status: () => ({
      enabled: true,
      stt: "fake-stt",
      tts: "fake-tts",
      available: true,
      audioAvailable: true,
      pushToTalk: true,
      speakResponses: true,
      detail: "fake",
    }),
  };
}

describe("voice activation", () => {
  it("matches and strips a wake phrase", () => {
    assert.equal(wakePhraseHeard("Hey, Vesper, optimize this", "hey vesper"), true);
    assert.equal(textAfterWakePhrase("Hey, Vesper, optimize this", "hey vesper"), "optimize this");
  });

  it("routes yes/no to a pending confirmation", async () => {
    const confirmations: Array<{ id: string; approve: boolean }> = [];
    const controller = createVoiceActivationController({
      voice: fakeVoice(["hey vesper optimize this", "yes"]),
      wakePhrase: "hey vesper",
      detectionSeconds: 1,
      commandSeconds: 1,
      cooldownMs: 250,
      onCommand: async () => ({
        reply: "Please confirm.",
        pendingConfirmationId: "confirm-1",
      }),
      onConfirm: async (id, approve) => {
        confirmations.push({ id, approve });
        return { reply: approve ? "Approved." : "Cancelled." };
      },
    });

    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 650));
    await controller.stop();

    assert.deepEqual(confirmations, [{ id: "confirm-1", approve: true }]);
  });

  it("drives one wake -> command -> reply cycle", async () => {
    let commands: string[] = [];
    let replies: string[] = [];
    const controller = createVoiceActivationController({
      voice: fakeVoice(["nothing to see", "hey vesper optimize this"]),
      wakePhrase: "hey vesper",
      detectionSeconds: 1,
      commandSeconds: 1,
      cooldownMs: 250,
      onCommand: async (text) => {
        commands.push(text);
        return "done";
      },
      onReply: async (text) => {
        replies.push(text);
      },
    });

    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 650));
    await controller.stop();

    assert.deepEqual(commands, ["optimize this"]);
    assert.deepEqual(replies, ["done"]);
  });
});
