/**
 * Optional openWakeWord wake detector.
 *
 * The detector is deliberately an external worker boundary. Vesper does not
 * embed an inference runtime or model weights. The worker uses openWakeWord +
 * ONNX Runtime and PyAudio to consume 16 kHz mono PCM and emits bounded JSON
 * wake events. Model downloads are never performed by Vesper.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import readline from "node:readline";

import { commandExists, type WhichFn } from "../models/backends.ts";


export interface WakeWordDetectorStatus {
  available: boolean;
  running: boolean;
  backend: "openwakeword" | "none";
  modelPath: string | null;
  detail: string;
}

export interface WakeWordDetector {
  readonly id: string;
  available(): boolean;
  start(onWake: (detail: string) => void, onError: (detail: string) => void): boolean;
  stop(): Promise<void>;
  status(): WakeWordDetectorStatus;
}

export interface OpenWakeWordOptions {
  platform?: NodeJS.Platform;
  modelPath?: string;
  threshold?: number;
  deviceName?: string;
  pythonCommand?: string | null;
  spawnImpl?: typeof nodeSpawn;
}

export async function findPythonCommand(
  which: WhichFn = (name) => commandExists(name, process.platform),
  candidates: readonly string[] = ["python", "py"],
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await which(candidate).catch(() => false)) return candidate;
  }
  return null;
}

interface WorkerMessage {
  readonly ok?: boolean;
  readonly wake?: boolean;
  readonly score?: number;
  readonly model?: string | null;
  readonly detail?: string;
}

function safeModelPath(value?: string): string | null {
  const path = value?.trim() ?? "";
  if (!path || path.includes("\0") || path.includes("\r") || path.includes("\n")) return null;
  return path;
}

export function createOpenWakeWordDetector(
  options: OpenWakeWordOptions,
): WakeWordDetector {
  const platform = options.platform ?? process.platform;
  const modelPath = safeModelPath(options.modelPath);
  const threshold = Math.max(0.05, Math.min(0.99, options.threshold ?? 0.5));
  const deviceName = options.deviceName?.trim() ?? "";
  const python = options.pythonCommand ?? null;
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), "openwakeword_worker.py");

  let child: ReturnType<typeof nodeSpawn> | null = null;
  const available = platform === "win32" && Boolean(modelPath) && Boolean(python);
  let lastDetail = !modelPath
    ? "An explicit local openWakeWord model path is required."
    : !python
      ? "Python was not found. Install Python and the openWakeWord/onnxruntime/PyAudio packages."
      : platform !== "win32"
        ? "openWakeWord microphone integration is currently implemented for Windows."
        : "Python and an explicit local wake model are available; dependency import is checked when started.";

  const status = (): WakeWordDetectorStatus => ({
    available,
    running: child !== null,
    backend: available ? "openwakeword" : "none",
    modelPath,
    detail: lastDetail,
  });

  return {
    id: "openwakeword",
    available: () => available,
    start(onWake, onError) {
      if (!available || child || !python || !modelPath) return false;

      let settled = false;
      try {
        child = spawnImpl(
          python,
          [
            "-u",
            workerPath,
            "--model",
            modelPath,
            "--threshold",
            String(threshold),
            ...(deviceName ? ["--device-name", deviceName] : []),
          ],
          { shell: false, stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        child = null;
        lastDetail = error instanceof Error ? error.message : String(error);
        onError(lastDetail);
        return false;
      }

      const proc = child;
      const lineReader = readline.createInterface({ input: proc.stdout! });
      lineReader.on("line", (line) => {
        if (line.length > 4096) {
          onError("openWakeWord emitted an oversized status line; ignoring it.");
          return;
        }
        let message: WorkerMessage;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            onError("openWakeWord emitted malformed status data.");
            return;
          }
          message = parsed as WorkerMessage;
        } catch {
          onError("openWakeWord emitted non-JSON status data.");
          return;
        }

        if (message.ok === true) {
          lastDetail = message.detail ?? "openWakeWord worker ready.";
          return;
        }
        if (message.wake === true) {
          const score =
            typeof message.score === "number" && Number.isFinite(message.score)
              ? Math.max(0, Math.min(1, message.score))
              : 0;
          const model = typeof message.model === "string" ? message.model : "configured model";
          onWake(\`openWakeWord detected \${model} (score \${score.toFixed(3)}).\`);
        }
        if (message.ok !== true && message.detail) {
          lastDetail = message.detail;
          onError(lastDetail);
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const detail = chunk.toString("utf8").trim().slice(-1024);
        if (detail) lastDetail = detail;
      });

      const finish = (detail: string) => {
        if (settled) return;
        settled = true;
        lineReader.close();
        child = null;
        lastDetail = detail;
        if (detail !== "openWakeWord worker stopped.") onError(detail);
      };
      proc.on("error", (error) => finish(error.message));
      proc.on("close", (code) =>
        finish(code === 0 ? "openWakeWord worker stopped." : \`openWakeWord worker exited with code \${code ?? "unknown"}.\`),
      );
      return true;
    },

    async stop() {
      const proc = child;
      if (!proc) return;
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already exited */
          }
          resolve();
        }, 2000);
        proc.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      child = null;
    },

    status,
  };
}
