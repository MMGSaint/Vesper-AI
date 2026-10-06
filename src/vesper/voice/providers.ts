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
  const audio: VoiceAudioIo = {
    id: "simulated-audio",
    platform: "win32",
    ffmpeg: "simulated",
    ffplay: "simulated",
    async listInputDevices() {
      return { available: true, devices: ["Simulated Microphone"], detail: "Simulated audio input." };
    },
    async captureWav() {
      return { available: true, audio: new Uint8Array(44), device: "Simulated Microphone", detail: "Simulated microphone capture." };
    },
    async playWav() {
      return { available: true, detail: "Simulated speaker playback." };
    },
    status() {
      return {
        available: true,
        devices: ["Simulated Microphone"],
        selectedDevice: "Simulated Microphone",
        detail: "Simulated audio I/O.",
      };
    },
  };

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
  audioBackend?: "ffmpeg" | "none";
  audioInputDevice?: string;
  captureSeconds?: number;
  speakResponses?: boolean;
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

  const available = Boolean(sttBinary || ttsBinary);
  const ffmpegAvailable =
    input.audioBackend !== "none"
      ? await which("ffmpeg").catch(() => false)
      : false;
  const ffplayAvailable =
    input.audioBackend !== "none"
      ? await which("ffplay").catch(() => false)
      : false;
  const audio =
    ffmpegAvailable && ffplayAvailable
      ? createFfmpegAudioIo({
          platform: input.platform,
          selectedDevice: input.audioInputDevice,
          spawnImpl: input.spawnImpl,
        })
      : null;

  let audioStatus = audio
    ? await audio.listInputDevices().catch(() => ({
        available: false,
        devices: [],
        detail: "Audio device discovery failed.",
      }))
    : {
        available: false,
        devices: [],
        detail:
          input.audioBackend === "none"
            ? "Physical audio is disabled."
            : "FFmpeg and/or ffplay is not installed on this host.",
      };

  const detail = available
    ? "Local voice conversion backends found (stt: " +
      (sttBinary ?? "none") +
      ", tts: " +
      (ttsBinary ?? "none") +
      "). Physical audio is " +
      (audioStatus.available ? "ready for target-PC validation." : "not ready yet.") 
    : "No local STT/TTS binary was found. Voice stays on text until one is installed.";

  return {
    enabled: input.enabled,
    pushToTalkBound: Boolean(input.pushToTalk),
    captureSeconds: Math.max(1, Math.min(30, Math.round(input.captureSeconds ?? 6))),
    speakResponses: input.speakResponses !== false,
    stt,
    tts,
    audio,
    available: () => available,
    audioAvailable: () => Boolean(audio?.status().available || audioStatus.available),
    status: () => ({
      enabled: input.enabled,
      stt: stt.id,
      tts: tts.id,
      available,
      audioAvailable: Boolean(audio?.status().available || audioStatus.available),
      pushToTalk: Boolean(input.pushToTalk),
      speakResponses: input.speakResponses !== false,
      detail,
    }),
  };
}
