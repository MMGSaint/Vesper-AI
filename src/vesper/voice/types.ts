export interface SpeechToText {
  id: string;
  transcribe(audio: Uint8Array): Promise<{ text: string; available: boolean; detail: string }>;
}

export interface TextToSpeech {
  id: string;
  speak(text: string): Promise<{ audio?: Uint8Array; available: boolean; detail: string }>;
}

export interface VoiceModule {
  enabled: boolean;
  stt: SpeechToText;
  tts: TextToSpeech;
  pushToTalkBound: boolean;
  available(): boolean;
  status(): { enabled: boolean; stt: string; tts: string; available: boolean; pushToTalk: boolean; detail: string };
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
    stt,
    tts,
    available: () => false,
    status: () => ({
      enabled: false,
      stt: "none",
      tts: "none",
      available: false,
      pushToTalk: false,
      detail: "Voice is optional and currently disabled.",
    }),
  };
}
