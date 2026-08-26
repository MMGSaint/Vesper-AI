/**
 * Local STT/TTS backends driven as subprocesses.
 *
 * What is software and what is hardware, precisely:
 *
 *   - Turning an audio buffer into text, and text into an audio buffer, is software.
 *     It is implemented here and tested against a fake binary.
 *   - *Capturing* from a microphone and *playing* to a speaker are hardware. Neither
 *     happens in this file, and neither is claimed anywhere in it.
 *
 * Command shapes follow the documented CLIs:
 *   whisper-ctranslate2 / faster-whisper - OpenAI-whisper compatible:
 *     `<binary> <audio> --model <name> --output_format txt --output_dir <dir>`
 *   piper - text on stdin:
 *     `<binary> --model <voice.onnx> --output_file <out.wav>`
 *
 * Both accept extra arguments from config so a different local build can be driven
 * without changing code.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { spawn as nodeSpawn } from "node:child_process";
import { runProcess } from "./process.ts";
import type { SpeechToText, TextToSpeech } from "./types.ts";

export interface LocalBackendOptions {
  binary: string;
  model: string;
  extraArgs?: string[];
  timeoutMs?: number;
  spawnImpl?: typeof nodeSpawn;
  /** Overrides the temp directory; tests use this to keep everything inspectable. */
  workDir?: string;
}

async function scratchDir(prefix: string, override?: string): Promise<string> {
  if (override) return override;
  return mkdtemp(join(tmpdir(), prefix));
}

async function cleanup(dir: string, keep: boolean): Promise<void> {
  if (keep) return;
  await rm(dir, { recursive: true, force: true }).catch(() => {
    /* a leftover temp directory is not worth failing a transcription over */
  });
}

/**
 * Speech to text via a whisper CLI.
 *
 * The caller supplies the audio bytes; where they came from is not this module's
 * concern, which is exactly why this is testable without a microphone.
 */
export function createWhisperStt(
  options: LocalBackendOptions & { language?: string },
): SpeechToText {
  return {
    id: options.binary,
    async transcribe(audio: Uint8Array) {
      if (audio.length === 0) {
        return { text: "", available: false, detail: "No audio was supplied to transcribe." };
      }
      const dir = await scratchDir("vesper-stt-", options.workDir);
      const audioPath = join(dir, "input.wav");
      try {
        await writeFile(audioPath, audio);
        const result = await runProcess({
          command: options.binary,
          args: [
            audioPath,
            "--model",
            options.model,
            "--output_format",
            "txt",
            "--output_dir",
            dir,
            ...(options.language ? ["--language", options.language] : []),
            ...(options.extraArgs ?? []),
          ],
          timeoutMs: options.timeoutMs ?? 120_000,
          spawnImpl: options.spawnImpl,
        });

        if (!result.ok) {
          return {
            text: "",
            available: false,
            detail: `${options.binary} failed: ${result.error ?? "unknown error"}${
              result.stderr ? ` (${result.stderr.slice(0, 200)})` : ""
            }`,
          };
        }

        // The CLI writes <basename>.txt beside the input; fall back to stdout for
        // builds that stream the transcript instead of writing a file.
        const transcriptPath = join(dir, `${basename(audioPath, ".wav")}.txt`);
        const fromFile = await readFile(transcriptPath, "utf8").catch(() => null);
        const text = (fromFile ?? result.stdout.toString("utf8")).trim();
        if (!text) {
          return {
            text: "",
            available: true,
            detail: `${options.binary} ran but produced no transcript.`,
          };
        }
        return {
          text,
          available: true,
          detail: `Transcribed by ${options.binary} (${options.model}). No microphone was opened by Vesper.`,
        };
      } catch (error) {
        return {
          text: "",
          available: false,
          detail: `Transcription failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        await cleanup(dir, Boolean(options.workDir));
      }
    },
  };
}

/**
 * Text to speech via Piper. Returns WAV bytes; playing them is the caller's problem
 * and requires an audio device this process never touches.
 */
export function createPiperTts(options: LocalBackendOptions & { speaker?: number }): TextToSpeech {
  return {
    id: options.binary,
    async speak(text: string) {
      const trimmed = text.trim();
      if (!trimmed) {
        return { available: false, detail: "No text was supplied to speak." };
      }
      const dir = await scratchDir("vesper-tts-", options.workDir);
      const outputPath = join(dir, "speech.wav");
      try {
        const result = await runProcess({
          command: options.binary,
          args: [
            "--model",
            options.model,
            "--output_file",
            outputPath,
            ...(options.speaker !== undefined ? ["--speaker", String(options.speaker)] : []),
            ...(options.extraArgs ?? []),
          ],
          // Text goes on stdin, never interpolated into a command line.
          stdin: trimmed,
          timeoutMs: options.timeoutMs ?? 60_000,
          spawnImpl: options.spawnImpl,
        });

        if (!result.ok) {
          return {
            available: false,
            detail: `${options.binary} failed: ${result.error ?? "unknown error"}${
              result.stderr ? ` (${result.stderr.slice(0, 200)})` : ""
            }`,
          };
        }

        const audio = await readFile(outputPath).catch(() => null);
        const bytes = audio ?? (result.stdout.length ? result.stdout : null);
        if (!bytes || bytes.length === 0) {
          return { available: true, detail: `${options.binary} ran but produced no audio.` };
        }
        return {
          audio: new Uint8Array(bytes),
          available: true,
          detail: `Synthesised ${bytes.length} bytes by ${options.binary} (${options.model}). Vesper did not open an audio device.`,
        };
      } catch (error) {
        return {
          available: false,
          detail: `Synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        await cleanup(dir, Boolean(options.workDir));
      }
    },
  };
}
