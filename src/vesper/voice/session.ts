import type { VoiceModule } from "./types.ts";

export type VoiceSessionMode =
  | "idle"
  | "listening"
  | "speaking"
  | "interrupted"
  | "fallback-text";

export interface VoiceDiagnostics {
  enabled: boolean;
  available: boolean;
  audioAvailable: boolean;
  stt: string;
  tts: string;
  pushToTalk: boolean;
  speakResponses: boolean;
  mode: VoiceSessionMode;
  lastError: string | null;
  hardwareValidated: boolean;
  detail: string;
}

export interface VoiceSession {
  mode(): VoiceSessionMode;
  holdPtt(): { ok: boolean; summary: string };
  releasePtt(signal?: AbortSignal): Promise<{
    ok: boolean;
    summary: string;
    transcript?: string;
  }>;
  speak(text: string, signal?: AbortSignal): Promise<{ ok: boolean; summary: string }>;
  interrupt(): { ok: boolean; summary: string };
  fallbackToText(reason?: string): { ok: boolean; summary: string };
  diagnostics(): VoiceDiagnostics;
}

export function createVoiceSession(module: VoiceModule): VoiceSession {
  let mode: VoiceSessionMode = module.enabled ? "idle" : "fallback-text";
  let lastError: string | null = null;
  let hardwareValidated = false;
  let speakingController: AbortController | null = null;

  return {
    mode: () => mode,

    holdPtt() {
      if (!module.enabled) {
        return { ok: false, summary: "Voice is disabled. Staying on text." };
      }
      if (!module.pushToTalkBound) {
        return { ok: false, summary: "Push-to-talk is not enabled in configuration." };
      }
      mode = "listening";
      lastError = null;
      return {
        ok: true,
        summary: "Push-to-talk held. Capturing locally when released.",
      };
    },

    async releasePtt(signal) {
      if (mode !== "listening") {
        return { ok: false, summary: "Push-to-talk was not held." };
      }
      if (!module.audio) {
        mode = "fallback-text";
        lastError = "No physical audio backend is configured.";
        return { ok: false, summary: lastError };
      }

      const captured = await module.audio.captureWav(
        module.captureSeconds,
        undefined,
        signal,
      );
      if (!captured.available || !captured.audio) {
        mode = "fallback-text";
        lastError = captured.detail;
        return { ok: false, summary: captured.detail };
      }

      const result = await module.stt.transcribe(captured.audio);
      if (!result.available) {
        mode = "fallback-text";
        lastError = result.detail;
        return { ok: false, summary: result.detail };
      }

      mode = "idle";
      hardwareValidated = true;
      lastError = null;
      return {
        ok: true,
        summary: captured.detail + " " + result.detail,
        transcript: result.text,
      };
    },

    async speak(text, signal) {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, summary: "There is no response text to speak." };
      if (!module.enabled || !module.speakResponses) {
        return { ok: false, summary: "Spoken responses are disabled." };
      }
      if (!module.audio) {
        lastError = "No physical audio playback backend is configured.";
        return { ok: false, summary: lastError };
      }

      speakingController?.abort();
      const controller = new AbortController();
      speakingController = controller;
      const relay = () => controller.abort();
      signal?.addEventListener("abort", relay, { once: true });

      mode = "speaking";
      try {
        const synthesized = await module.tts.speak(trimmed, controller.signal);
        if (!synthesized.available || !synthesized.audio) {
          mode = "fallback-text";
          lastError = synthesized.detail;
          return { ok: false, summary: synthesized.detail };
        }
        const played = await module.audio.playWav(synthesized.audio, controller.signal);
        if (!played.available) {
          mode = controller.signal.aborted ? "interrupted" : "fallback-text";
          lastError = played.detail;
          return { ok: false, summary: played.detail };
        }
        mode = "idle";
        hardwareValidated = true;
        lastError = null;
        return { ok: true, summary: synthesized.detail + " " + played.detail };
      } finally {
        signal?.removeEventListener("abort", relay);
        if (speakingController === controller) speakingController = null;
      }
    },

    interrupt() {
      if (mode !== "speaking" && mode !== "listening") {
        return { ok: false, summary: "Nothing to interrupt." };
      }
      speakingController?.abort();
      speakingController = null;
      mode = "interrupted";
      return { ok: true, summary: "Voice activity interrupted. Control returned to text." };
    },

    fallbackToText(reason) {
      speakingController?.abort();
      speakingController = null;
      mode = "fallback-text";
      lastError = reason ?? lastError;
      return {
        ok: true,
        summary: reason ?? "Fell back to text. Voice remains optional.",
      };
    },

    diagnostics() {
      const status = module.status();
      const audio = module.audio?.status();
      return {
        enabled: status.enabled,
        available: status.available,
        audioAvailable: status.audioAvailable,
        stt: status.stt,
        tts: status.tts,
        pushToTalk: status.pushToTalk,
        speakResponses: status.speakResponses,
        mode,
        lastError,
        hardwareValidated,
        detail:
          status.detail +
          (audio ? " " + audio.detail : " No physical audio backend is configured."),
      };
    },
  };
}
