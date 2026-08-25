import type { VoiceModule } from "./types.ts";

export type VoiceSessionMode = "idle" | "listening" | "speaking" | "interrupted" | "fallback-text";

export interface VoiceDiagnostics {
  enabled: boolean;
  available: boolean;
  stt: string;
  tts: string;
  pushToTalk: boolean;
  mode: VoiceSessionMode;
  lastError: string | null;
  hardwareValidated: boolean;
  detail: string;
}

export interface VoiceSession {
  mode(): VoiceSessionMode;
  holdPtt(): { ok: boolean; summary: string };
  releasePtt(): Promise<{ ok: boolean; summary: string; transcript?: string }>;
  interrupt(): { ok: boolean; summary: string };
  fallbackToText(reason?: string): { ok: boolean; summary: string };
  diagnostics(): VoiceDiagnostics;
}

export function createVoiceSession(module: VoiceModule): VoiceSession {
  let mode: VoiceSessionMode = module.enabled ? "idle" : "fallback-text";
  let lastError: string | null = null;

  return {
    mode: () => mode,
    holdPtt() {
      if (!module.enabled) {
        return { ok: false, summary: "Voice is disabled. Staying on text." };
      }
      if (!module.pushToTalkBound) {
        return { ok: false, summary: "Push-to-talk is not bound. Voice stays optional." };
      }
      if (!module.available()) {
        mode = "fallback-text";
        lastError = "Audio devices were not opened.";
        return {
          ok: false,
          summary: "Push-to-talk was pressed, but no microphone session was opened. Falling back to text.",
        };
      }
      mode = "listening";
      return { ok: true, summary: "Push-to-talk held. Listening (simulated or local STT)." };
    },
    async releasePtt() {
      if (mode !== "listening") {
        return { ok: false, summary: "Push-to-talk was not held." };
      }
      const result = await module.stt.transcribe(new Uint8Array());
      if (!result.available) {
        mode = "fallback-text";
        lastError = result.detail;
        return { ok: false, summary: result.detail };
      }
      mode = "idle";
      return { ok: true, summary: result.detail, transcript: result.text };
    },
    interrupt() {
      if (mode !== "speaking" && mode !== "listening") {
        return { ok: false, summary: "Nothing to interrupt." };
      }
      mode = "interrupted";
      return { ok: true, summary: "Voice output interrupted. Control returned to text." };
    },
    fallbackToText(reason) {
      mode = "fallback-text";
      lastError = reason ?? lastError;
      return {
        ok: true,
        summary: reason ?? "Fell back to text. Voice remains optional.",
      };
    },
    diagnostics() {
      const status = module.status();
      return {
        enabled: status.enabled,
        available: status.available,
        stt: status.stt,
        tts: status.tts,
        pushToTalk: status.pushToTalk,
        mode,
        lastError,
        hardwareValidated: false,
        detail: `${status.detail} Physical microphone/speaker validation has not been performed.`,
      };
    },
  };
}
