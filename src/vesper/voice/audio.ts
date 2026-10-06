/**
 * Physical audio I/O boundary for the voice subsystem.
 *
 * Vesper owns orchestration and validation; FFmpeg owns Windows audio device
 * plumbing. We do not embed an audio driver/library here.
 *
 * Windows capture uses DirectShow (dshow) and produces mono 16 kHz PCM WAV,
 * which matches the existing whisper providers. Playback uses ffplay and reads
 * the generated WAV from stdin.
 *
 * The configured input device is one argv element and is never shell-expanded.
 */

import type { spawn as nodeSpawn } from "node:child_process";
import { runProcess } from "./process.ts";

export interface VoiceAudioIo {
  readonly id: string;
  readonly platform: NodeJS.Platform;
  readonly ffmpeg: string;
  readonly ffplay: string;
  listInputDevices(signal?: AbortSignal): Promise<{
    available: boolean;
    devices: string[];
    detail: string;
  }>;
  captureWav(
    seconds: number,
    configuredDevice?: string,
    signal?: AbortSignal,
  ): Promise<{
    available: boolean;
    audio?: Uint8Array;
    device?: string;
    detail: string;
  }>;
  playWav(
    audio: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ available: boolean; detail: string }>;
  status(): {
    available: boolean;
    devices: string[];
    selectedDevice: string | null;
    detail: string;
  };
}

export interface FfmpegAudioIoOptions {
  platform?: NodeJS.Platform;
  ffmpeg?: string;
  ffplay?: string;
  selectedDevice?: string;
  which?: (name: string) => Promise<boolean>;
  spawnImpl?: typeof nodeSpawn;
  deviceCacheMs?: number;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * FFmpeg/DirectShow generally prints:
 *   [dshow @ ...] "Microphone (USB ...)" (audio)
 *
 * We accept only those named audio devices.
 */
export function parseDirectShowAudioDevices(stderr: string): string[] {
  const found: string[] = [];
  const quoted = /"([^"\\]*(?:\\.[^"\\]*)*)"\\s+\\(audio\\)/gi;
  for (const match of stderr.matchAll(quoted)) {
    const value = match[1]?.trim();
    if (value) found.push(value);
  }
  return unique(found);
}

function boundSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 1;
  return Math.max(1, Math.min(30, Math.round(seconds)));
}

export function createFfmpegAudioIo(options: FfmpegAudioIoOptions = {}): VoiceAudioIo {
  const platform = options.platform ?? process.platform;
  const ffmpeg = options.ffmpeg ?? "ffmpeg";
  const ffplay = options.ffplay ?? "ffplay";
  const which =
    options.which ??
    (async (name: string) => {
      const { commandExists } = await import("../models/backends.ts");
      return commandExists(name, platform);
    });
  const spawnImpl = options.spawnImpl;
  const deviceCacheMs = Math.max(1000, Math.min(60_000, options.deviceCacheMs ?? 15_000));

  let devices: string[] = [];
  let selectedDevice: string | null = options.selectedDevice?.trim() || null;
  let cachedAt = 0;
  let deviceProbe:
    | Promise<{ available: boolean; devices: string[]; detail: string }>
    | null = null;

  async function listInputDevices(signal?: AbortSignal) {
    if (platform !== "win32") {
      return {
        available: false,
        devices: [],
        detail: "Physical FFmpeg DirectShow capture is currently implemented for Windows.",
      };
    }
    if (deviceProbe) return deviceProbe;
    if (cachedAt > 0 && Date.now() - cachedAt < deviceCacheMs) {
      return {
        available: devices.length > 0,
        devices: devices.slice(),
        detail: devices.length
          ? devices.length + " DirectShow audio device(s) found."
          : "No DirectShow audio devices were found.",
      };
    }

    deviceProbe = (async () => {
      const result = await runProcess({
        command: ffmpeg,
        args: ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
        timeoutMs: 5000,
        signal,
        spawnImpl,
        maxOutputBytes: 512 * 1024,
      });
      deviceProbe = null;
      cachedAt = Date.now();
      if (!result.ok && !result.stderr) {
        devices = [];
        return {
          available: false,
          devices: [],
          detail: result.error ?? "FFmpeg device discovery failed.",
        };
      }
      devices = parseDirectShowAudioDevices(result.stderr);
      return {
        available: devices.length > 0,
        devices: devices.slice(),
        detail: devices.length
          ? devices.length + " DirectShow audio device(s) found."
          : "FFmpeg responded, but no DirectShow audio capture devices were found.",
      };
    })();
    return deviceProbe;
  }

  async function resolveDevice(
    configuredDevice?: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const probe = await listInputDevices(signal);
    if (!probe.available) return null;

    const requested = configuredDevice?.trim() || selectedDevice;
    if (requested) {
      const exact = probe.devices.find((device) => device === requested);
      if (exact) {
        selectedDevice = exact;
        return exact;
      }
      return null;
    }

    selectedDevice =
      selectedDevice && probe.devices.includes(selectedDevice)
        ? selectedDevice
        : (probe.devices[0] ?? null);
    return selectedDevice;
  }

  return {
    id: "ffmpeg-dshow",
    platform,
    ffmpeg,
    ffplay,

    async listInputDevices(signal) {
      return listInputDevices(signal);
    },

    async captureWav(seconds, configuredDevice, signal) {
      if (platform !== "win32") {
        return {
          available: false,
          detail: "Physical FFmpeg DirectShow capture is currently implemented for Windows.",
        };
      }

      const device = await resolveDevice(configuredDevice, signal);
      if (!device) {
        const requested = configuredDevice?.trim() || selectedDevice;
        return {
          available: false,
          detail: requested
            ? 'Configured microphone "' + requested + '" was not found among current DirectShow audio devices.'
            : "No DirectShow microphone is available.",
        };
      }

      const duration = boundSeconds(seconds);
      const result = await runProcess({
        command: ffmpeg,
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "dshow",
          "-i",
          'audio="' + device + '"',
          "-t",
          String(duration),
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          "-f",
          "wav",
          "pipe:1",
        ],
        timeoutMs: (duration + 5) * 1000,
        signal,
        spawnImpl,
        maxOutputBytes: 8 * 1024 * 1024,
      });

      if (!result.ok || result.stdout.length < 44) {
        return {
          available: false,
          device,
          detail:
            result.error ??
            (result.stderr.slice(0, 400) || "FFmpeg returned no usable microphone audio."),
        };
      }

      return {
        available: true,
        audio: new Uint8Array(result.stdout),
        device,
        detail: 'Captured microphone audio from "' + device + '" via FFmpeg/DirectShow.',
      };
    },

    async playWav(audio, signal) {
      if (platform !== "win32") {
        return {
          available: false,
          detail: "Physical FFmpeg playback is currently implemented for Windows.",
        };
      }
      if (audio.length < 44) {
        return { available: false, detail: "WAV payload is too short to play." };
      }

      const result = await runProcess({
        command: ffplay,
        args: ["-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit", "-i", "-"],
        stdin: audio,
        timeoutMs: 120_000,
        signal,
        spawnImpl,
        maxOutputBytes: 32 * 1024,
      });

      return result.ok
        ? { available: true, detail: "Audio played through ffplay." }
        : {
            available: false,
            detail:
              result.error ??
              (result.stderr.slice(0, 400) || "ffplay could not play the response."),
          };
    },

    status() {
      return {
        available: devices.length > 0,
        devices: devices.slice(),
        selectedDevice,
        detail: devices.length
          ? "FFmpeg/DirectShow audio ready; " + devices.length + " input device(s) known."
          : "FFmpeg/DirectShow audio has not found an input device yet.",
      };
    },
  };
}
