/**
 * Wake-word foothold. STT/TTS already exist under src/vesper/voice.
 *
 * Defaults remain OFF. A disabled provider performs no capture and opens no device.
 * whisper.cpp / Piper remain optional adapters behind the existing voice module.
 */

export interface WakeWordProvider {
  id: string;
  enabled: boolean;
  listen(): Promise<{ heard: boolean; detail: string; openedDevice: boolean }>;
  status(): { enabled: boolean; available: boolean; capturing: boolean; detail: string };
}

export function createDisabledWakeWord(): WakeWordProvider {
  return {
    id: "none",
    enabled: false,
    async listen() {
      return {
        heard: false,
        openedDevice: false,
        detail: "Wake word is disabled. No microphone was opened.",
      };
    },
    status() {
      return {
        enabled: false,
        available: false,
        capturing: false,
        detail: "Wake word is optional and currently disabled.",
      };
    },
  };
}

export function createSimulatedWakeWord(): WakeWordProvider {
  return {
    id: "simulated",
    enabled: true,
    async listen() {
      return {
        heard: false,
        openedDevice: false,
        detail: "Simulated wake word. No microphone was used.",
      };
    },
    status() {
      return {
        enabled: true,
        available: true,
        capturing: false,
        detail: "Simulated wake word. Physical audio was not validated.",
      };
    },
  };
}

export interface VoiceFootholdConfig {
  enabled: boolean;
  wakeWord: { enabled: boolean };
  asr: { enabled: boolean };
  tts: { enabled: boolean };
}

export const DEFAULT_VOICE_FOOTHOLD: VoiceFootholdConfig = {
  enabled: false,
  wakeWord: { enabled: false },
  asr: { enabled: false },
  tts: { enabled: false },
};

export function resolveWakeWord(config: VoiceFootholdConfig): WakeWordProvider {
  if (!config.enabled || !config.wakeWord.enabled) return createDisabledWakeWord();
  return createSimulatedWakeWord();
}
