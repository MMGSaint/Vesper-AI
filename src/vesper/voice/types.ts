export interface SpeechToText {
  transcribe(audio: Uint8Array): Promise<{ text: string; available: boolean }>;
}

export interface TextToSpeech {
  speak(text: string): Promise<{ audio?: Uint8Array; available: boolean; detail: string }>;
}

export interface VoiceModule {
  enabled: boolean;
  stt: SpeechToText;
  tts: TextToSpeech;
  pushToTalkBound: boolean;
}

export function createDisabledVoice(): VoiceModule {
  return {
    enabled: false,
    pushToTalkBound: false,
    stt: {
      async transcribe() {
        return { text: "", available: false };
      },
    },
    tts: {
      async speak() {
        return {
          available: false,
          detail: "Voice is modular and disabled. Planned local backends: faster-whisper, Piper, Kokoro.",
        };
      },
    },
  };
}
