import type { SpeechToText, TextToSpeech, VoiceModule } from "./types.ts";
import { createDisabledVoice } from "./types.ts";
import { commandExists, type WhichFn } from "../models/backends.ts";
import type { spawn as nodeSpawn } from "node:child_process";
import { createPiperTts, createWhisperStt } from "./local-providers.ts";

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
  sttModel?: string;
  ttsModel?: string;
  sttLanguage?: string;
  sttArgs?: string[];
  ttsArgs?: string[];
  spawnImpl?: typeof nodeSpawn;
}): Promise<VoiceModule> {
  if (!input.enabled) return createDisabledVoice();
  const which = input.which ?? ((name: string) => commandExists(name, input.platform));

  // Resolve the actual binary name, since the whisper CLI ships under several.
  const sttBinary =
    input.stt === "faster-whisper"
      ? ((await which("whisper-ctranslate2"))
          ? "whisper-ctranslate2"
          : (await which("faster-whisper"))
            ? "faster-whisper"
            : (await which("whisper"))
              ? "whisper"
              : null)
      : (await which(input.stt))
        ? input.stt
        : null;

  const ttsBinary =
    input.tts === "piper"
      ? ((await which("piper")) ? "piper" : null)
      : input.tts === "kokoro"
        ? ((await which("kokoro")) ? "kokoro" : (await which("kokoro-tts")) ? "kokoro-tts" : null)
        : (await which(input.tts))
          ? input.tts
          : null;

  const stt = sttBinary
    ? createWhisperStt({
        binary: sttBinary,
        model: input.sttModel ?? "base",
        language: input.sttLanguage,
        extraArgs: input.sttArgs,
        spawnImpl: input.spawnImpl,
      })
    : createUnavailableStt(
        input.stt,
        `${input.stt} is not installed on this host. Voice remains optional.`,
      );

  const tts = ttsBinary
    ? createPiperTts({
        binary: ttsBinary,
        model: input.ttsModel ?? "en_US-lessac-medium",
        extraArgs: input.ttsArgs,
        spawnImpl: input.spawnImpl,
      })
    : createUnavailableTts(
        input.tts,
        `${input.tts} is not installed on this host. Voice remains optional.`,
      );

  // "Available" means Vesper can convert between text and audio buffers. It never
  // means an audio device was opened: capture and playback stay hardware-dependent.
  const available = Boolean(sttBinary || ttsBinary);
  const detail = available
    ? `Local voice backends found (stt: ${sttBinary ?? "none"}, tts: ${ttsBinary ?? "none"}). Vesper can convert audio buffers to and from text. Microphone capture and speaker playback are not performed here and still require validation on the target PC.`
    : "No local STT/TTS binary was found. Voice stays disabled for runtime audio.";

  return {
    enabled: input.enabled,
    pushToTalkBound: Boolean(input.pushToTalk),
    stt,
    tts,
    available: () => available,
    status: () => ({
      enabled: input.enabled,
      stt: stt.id,
      tts: tts.id,
      available,
      pushToTalk: Boolean(input.pushToTalk),
      detail,
    }),
  };
}
