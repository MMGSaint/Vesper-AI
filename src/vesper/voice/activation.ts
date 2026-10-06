/**
 * Local wake-phrase activation loop.
 *
 * This deliberately keeps the wake path local: microphone -> FFmpeg -> local STT.
 * No cloud model is called until a wake phrase has been detected and a user command
 * has been captured. The feature is OFF by default because it continuously samples
 * the selected microphone when enabled.
 *
 * This first implementation uses the already-supported local STT backend to detect
 * the phrase. A future openWakeWord backend can replace the detector without changing
 * the audio/session boundary.
 */

import type { VoiceModule } from "./types.ts";

export interface VoiceCommandResult {
  reply: string;
  pendingConfirmationId?: string;
}

export interface VoiceActivationOptions {
  voice: VoiceModule;
  wakePhrase: string;
  detectionSeconds?: number;
  commandSeconds?: number;
  cooldownMs?: number;
  enabled?: boolean;
  shouldListen?: () => boolean;
  onCommand: (text: string) => Promise<VoiceCommandResult | string>;
  onConfirm?: (
    confirmationId: string,
    approve: boolean,
  ) => Promise<VoiceCommandResult | string>;
  onReply?: (text: string) => Promise<void>;
  onEvent?: (kind: "started" | "stopped" | "wake" | "error", detail: string) => void;
}

function normalise(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function wakePhraseHeard(transcript: string, phrase: string): boolean {
  const heard = normalise(transcript);
  const wanted = normalise(phrase);
  return wanted.length > 0 && heard.includes(wanted);
}

export function textAfterWakePhrase(transcript: string, phrase: string): string {
  const wanted = normalise(phrase);
  if (!wanted) return transcript.trim();

  const rawWords = transcript.trim().split(/\s+/);
  let start = -1;
  const normalisedWords = rawWords.map((word) => normalise(word));
  const wantedWords = wanted.split(" ");

  for (let i = 0; i <= normalisedWords.length - wantedWords.length; i += 1) {
    let matches = true;
    for (let j = 0; j < wantedWords.length; j += 1) {
      if (normalisedWords[i + j] !== wantedWords[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      start = i + wantedWords.length;
      break;
    }
  }

  return start < 0 ? "" : rawWords.slice(start).join(" ").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VoiceActivationController {
  private readonly voice: VoiceModule;
  private readonly wakePhrase: string;
  private readonly detectionSeconds: number;
  private readonly commandSeconds: number;
  private readonly cooldownMs: number;
  private readonly shouldListen: () => boolean;
  private readonly onCommand: (text: string) => Promise<string>;
  private readonly onReply?: (text: string) => Promise<void>;
  private readonly onEvent?: VoiceActivationOptions["onEvent"];
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private sequence = 0;
  private pendingConfirmationId: string | null = null;

  constructor(options: VoiceActivationOptions) {
    this.voice = options.voice;
    this.wakePhrase = options.wakePhrase.trim();
    this.detectionSeconds = Math.max(1, Math.min(6, Math.round(options.detectionSeconds ?? 2)));
    this.commandSeconds = Math.max(1, Math.min(30, Math.round(options.commandSeconds ?? 8)));
    this.cooldownMs = Math.max(250, Math.min(60_000, Math.round(options.cooldownMs ?? 1500)));
    this.shouldListen = options.shouldListen ?? (() => true);
    this.onCommand = options.onCommand;
    this.onReply = options.onReply;
    this.onEvent = options.onEvent;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): boolean {
    if (this.running) return false;
    if (!this.voice.enabled || !this.voice.audio || !this.voice.stt.id) return false;
    if (!this.wakePhrase) return false;
    this.running = true;
    this.onEvent?.("started", "Wake-phrase activation started.");
    this.loopPromise = this.run();
    return true;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
      this.loopPromise = null;
    }
    this.onEvent?.("stopped", "Wake-phrase activation stopped.");
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        if (!this.shouldListen()) {
          await sleep(Math.max(1000, this.cooldownMs));
          continue;
        }

        const audio = this.voice.audio;
        if (!audio) {
          await sleep(5000);
          continue;
        }

        const captured = await audio.captureWav(this.detectionSeconds);
        if (!captured.available || !captured.audio) {
          this.onEvent?.("error", captured.detail);
          await sleep(5000);
          continue;
        }

        const transcript = await this.voice.stt.transcribe(captured.audio);
        if (!transcript.available || !transcript.text.trim()) {
          await sleep(150);
          continue;
        }

        const commandInWindow = textAfterWakePhrase(transcript.text, this.wakePhrase);
        if (!wakePhraseHeard(transcript.text, this.wakePhrase)) {
          await sleep(100);
          continue;
        }

        this.sequence += 1;
        this.onEvent?.("wake", "Wake phrase detected (activation #" + this.sequence + ").");

        let command = commandInWindow;
        if (!command) {
          const commandAudio = await audio.captureWav(this.commandSeconds);
          if (!commandAudio.available || !commandAudio.audio) {
            this.onEvent?.("error", commandAudio.detail);
            await sleep(this.cooldownMs);
            continue;
          }
          const commandTranscript = await this.voice.stt.transcribe(commandAudio.audio);
          if (!commandTranscript.available) {
            this.onEvent?.("error", commandTranscript.detail);
            await sleep(this.cooldownMs);
            continue;
          }
          command = commandTranscript.text.trim();
        }

        if (!command) {
          await sleep(this.cooldownMs);
          continue;
        }

        let result: VoiceCommandResult | string;
        const affirmative = /^(yes|yeah|yep|sure|approve|approved|do it|go ahead|confirm)$/i.test(command.trim());
        const negative = /^(no|nope|cancel|deny|decline|don't|do not)$/i.test(command.trim());

        if (this.pendingConfirmationId && (affirmative || negative) && this.onConfirm) {
          result = await this.onConfirm(this.pendingConfirmationId, affirmative);
          this.pendingConfirmationId =
            typeof result === "string" ? null : (result.pendingConfirmationId ?? null);
        } else {
          result = await this.onCommand(command);
          this.pendingConfirmationId =
            typeof result === "string" ? null : (result.pendingConfirmationId ?? null);
        }

        const reply = typeof result === "string" ? result : result.reply;
        if (reply.trim() && this.onReply) {
          await this.onReply(reply);
        }
        await sleep(this.cooldownMs);
      } catch (error) {
        this.onEvent?.(
          "error",
          error instanceof Error ? error.message : String(error),
        );
        await sleep(2000);
      }
    }
  }
}

/** Factory mainly used so callers can inject a fake VoiceModule in tests. */
export function createVoiceActivationController(
  options: VoiceActivationOptions,
): VoiceActivationController {
  return new VoiceActivationController(options);
}
