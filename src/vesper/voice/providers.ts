import type { SpeechToText, TextToSpeech, VoiceModule } from "./types.ts";
import { createDisabledVoice } from "./types.ts";
import type { WhichFn } from "../models/backends.ts";
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
  sttPath?: string;
  sttSha256?: string;
  ttsPath?: string;
  ttsSha256?: string;
  sttLanguage?: string;
  sttArgs?: string[];
  ttsArgs?: string[];
  spawnImpl?: typeof nodeSpawn;
}): Promise<VoiceModule> {
  if (!input.enabled) return createDisabledVoice();
  // Test doubles may inject discovery. Production never accepts an arbitrary PATH
  // result; it requires an explicit configured path and SHA-256 pin for each executable.
  const resolve = async (
    name: string,
    configuredPath?: string,
    configuredSha256?: string,
  ): Promise<{ path: string; sha256: string } | null> => {
    if (input.which) return (await input.which(name)) ? { path: name, sha256: "" } : null;
    if (!configuredPath || !configuredSha256 || !/^[A-Za-z]:[\\/]/.test(configuredPath)) return null;
    return { path: configuredPath, sha256: configuredSha256 };
  };

  // Resolve the actual binary path, since the whisper CLI ships under several names.
  const sttBinary = await resolve(
    input.stt === "faster-whisper" ? "whisper-ctranslate2" : input.stt,
    input.sttPath,
    input.sttSha256,
  );

  const ttsBinary = await resolve(
    input.tts === "kokoro" ? "kokoro" : input.tts,
    input.ttsPath,
    input.ttsSha256,
  );

  const stt = sttBinary
    ? createWhisperStt({
        binary: sttBinary.path,
        ...(sttBinary.sha256 ? { expectedSha256: sttBinary.sha256 } : {}),
        ...(input.which ? {} : { requireAbsolutePath: true }),
        model: input.sttModel ?? "base",
        language: input.sttLanguage,
        extraArgs: input.sttArgs,
        spawnImpl: input.spawnImpl,
      })
    : createUnavailableStt(
        input.stt,
        `${input.stt} has no explicitly pinned executable configured on this host. Voice remains optional.`,
      );

  const tts = ttsBinary
    ? createPiperTts({
        binary: ttsBinary.path,
        ...(ttsBinary.sha256 ? { expectedSha256: ttsBinary.sha256 } : {}),
        ...(input.which ? {} : { requireAbsolutePath: true }),
        model: input.ttsModel ?? "en_US-lessac-medium",
        extraArgs: input.ttsArgs,
        spawnImpl: input.spawnImpl,
      })
    : createUnavailableTts(
        input.tts,
        `${input.tts} has no explicitly pinned executable configured on this host. Voice remains optional.`,
      );

  // "Available" means Vesper can convert between text and audio buffers. It never
  // means an audio device was opened: capture and playback stay hardware-dependent.
  const available = Boolean(sttBinary || ttsBinary);
  const detail = available
    ? `Local voice backends found (stt: ${sttBinary?.path ?? "none"}, tts: ${ttsBinary?.path ?? "none"}). Vesper can convert audio buffers to and from text. Microphone capture and speaker playback are not performed here and still require validation on the target PC.`
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
