import type { SpeechToText, TextToSpeech, VoiceModule } from "./types.ts";
import { createDisabledVoice } from "./types.ts";
import { commandExists, type WhichFn } from "../models/backends.ts";

export function createUnavailableStt(id: string, detail: string): SpeechToText {
  return {
    id,
    async transcribe() {
      return { text: "", available: false, detail };
    },
  };
}

export function createUnavailableTts(id: string, detail: string): TextToSpeech {
  return {
    id,
    async speak() {
      return { available: false, detail };
    },
  };
}

export function createSimulatedVoice(): VoiceModule {
  const stt: SpeechToText = {
    id: "simulated-stt",
    async transcribe() {
      return {
        text: "simulated transcript",
        available: true,
        detail: "Simulated STT. No microphone was used.",
      };
    },
  };
  const tts: TextToSpeech = {
    id: "simulated-tts",
    async speak() {
      return { available: true, detail: "Simulated TTS. No audio device was used." };
    },
  };
  return {
    enabled: true,
    pushToTalkBound: true,
    stt,
    tts,
    available: () => true,
    status: () => ({
      enabled: true,
      stt: stt.id,
      tts: tts.id,
      available: true,
      pushToTalk: true,
      detail: "Simulated voice module. Physical audio was not validated.",
    }),
  };
}

export async function createVoiceModule(input: {
  enabled: boolean;
  stt: string;
  tts: string;
  pushToTalk?: boolean;
  which?: WhichFn;
  platform?: NodeJS.Platform;
}): Promise<VoiceModule> {
  if (!input.enabled) return createDisabledVoice();
  const which = input.which ?? ((name: string) => commandExists(name, input.platform));

  const sttPresent =
    input.stt === "faster-whisper"
      ? (await which("faster-whisper")) || (await which("whisper"))
      : false;
  const ttsPresent =
    input.tts === "piper"
      ? await which("piper")
      : input.tts === "kokoro"
        ? (await which("kokoro")) || (await which("kokoro-tts"))
        : false;

  const stt = sttPresent
    ? createUnavailableStt(
        input.stt,
        `${input.stt} binary was found but audio capture is hardware-dependent and was not opened.`,
      )
    : createUnavailableStt(
        input.stt,
        `${input.stt} is not installed on this host. Voice remains optional.`,
      );
  const tts = ttsPresent
    ? createUnavailableTts(
        input.tts,
        `${input.tts} binary was found but playback is hardware-dependent and was not opened.`,
      )
    : createUnavailableTts(input.tts, `${input.tts} is not installed on this host. Voice remains optional.`);

  const available = false;
  const detail = [
    sttPresent || ttsPresent
      ? "A local voice binary was detected, but audio devices were not opened on this host."
      : "No local STT/TTS binary was found. Voice stays disabled for runtime audio.",
    "Physical audio validation requires the target PC.",
  ].join(" ");

  return {
    enabled: input.enabled,
    pushToTalkBound: Boolean(input.pushToTalk),
    stt,
    tts,
    available: () => available,
    status: () => ({
      enabled: input.enabled,
      stt: input.stt,
      tts: input.tts,
      available,
      pushToTalk: Boolean(input.pushToTalk),
      detail,
    }),
  };
}
