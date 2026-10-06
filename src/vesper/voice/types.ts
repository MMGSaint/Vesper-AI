import type { VoiceAudioIo } from "./audio.ts";
import type { WakeWordDetector } from "./openwakeword.ts";

export interface SpeechToText {
  id: string;
  transcribe(audio: Uint8Array): Promise<{ text: string; available: boolean; detail: string }>;
}

export interface TextToSpeech {
  id: string;
  speak(text: string, signal?: AbortSignal): Promise<{ audio?: Uint8Array; available: boolean; detail: string }>;
}

export interface VoiceModule {
  enabled: boolean;
  stt: SpeechToText;
  tts: TextToSpeech;
  audio: VoiceAudioIo | null;
  pushToTalkBound: boolean;
  captureSeconds: number;
  speakResponses: boolean;
  wakeDetector: WakeWordDetector | null;
  available(): boolean;
  audioAvailable(): boolean;
  status(): {
    enabled: boolean;
    stt: string;
    tts: string;
    available: boolean;
    audioAvailable: boolean;
    pushToTalk: boolean;
    speakResponses: boolean;
    detail: string;
  };
}

export function createDisabledVoice(): VoiceModule {
  const stt: SpeechToText = {
    id: "none",
    async transcribe() {
      return { text: "", available: false, detail: "Voice is disabled." };
    },
  };
  const tts: TextToSpeech = {
    id: "none",
    async speak() {
      return {
        available: false,
        detail: "Voice is modular and disabled. Planned local backends: faster-whisper, Piper, Kokoro.",
      };
    },
  };
  return {
    enabled: false,
    pushToTalkBound: false,
    captureSeconds: 6,
    speakResponses: true,
    stt,
    tts,
    audio: null,
    available: () => false,
    audioAvailable: () => false,
    status: () => ({
      enabled: false,
      stt: "none",
      tts: "none",
      available: false,
      audioAvailable: false,
      pushToTalk: false,
      speakResponses: true,
      detail: "Voice is optional and currently disabled.",
    }),
  };
}
