import path from "node:path";
import { runProcess } from "../voice/process.ts";

export interface AudioSession {
  readonly pid: number;
  readonly processName: string;
  readonly displayName: string;
  readonly volume: number;
  readonly muted: boolean;
  readonly sessionIdentifier: string;
}

interface HelperResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

function helperConfig(): { path: string; sha256: string } {
  const helper = process.env.VESPER_AUDIO_HELPER?.trim();
  const sha256 = process.env.VESPER_AUDIO_HELPER_SHA256?.trim();
  if (!helper) throw new Error("VESPER_AUDIO_HELPER is not configured.");
  if (!path.isAbsolute(helper)) throw new Error("VESPER_AUDIO_HELPER must be an absolute executable path.");
  if (!sha256 || !/^[a-fA-F0-9]{64}$/.test(sha256)) {
    throw new Error("VESPER_AUDIO_HELPER_SHA256 must be a SHA-256 trust pin.");
  }
  return { path: helper, sha256 };
}

async function callHelper(request: Record<string, unknown>): Promise<unknown> {
  const helper = helperConfig();
  const result = await runProcess({
    command: helper.path,
    args: [],
    stdin: JSON.stringify(request) + "\n",
    timeoutMs: 5_000,
    maxOutputBytes: 1024 * 1024,
    requireAbsolutePath: true,
    expectedSha256: helper.sha256,
  });

  if (!result.ok) {
    throw new Error(
      result.error ??
        result.stderr.slice(0, 400) ??
        "Audio helper failed.",
    );
  }

  const response = result.stdout.toString("utf8").trim().split(/\r?\n/)[0] ?? "";
  let parsed: HelperResponse;
  try {
    parsed = JSON.parse(response) as HelperResponse;
  } catch {
    throw new Error("Audio helper returned invalid JSON.");
  }
  if (!parsed.ok) throw new Error(parsed.error ?? "Audio helper refused the request.");
  return parsed.result;
}

export async function listAudioSessions(): Promise<AudioSession[]> {
  return (await callHelper({ command: "list-sessions" })) as AudioSession[];
}

export async function getAudioSession(pid: number): Promise<AudioSession> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");
  return (await callHelper({ command: "get-session", pid })) as AudioSession;
}

export async function setAudioVolume(pid: number, volume: number): Promise<Record<string, unknown>> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error("volume must be between 0 and 1");
  return (await callHelper({ command: "set-volume", pid, volume })) as Record<string, unknown>;
}

export async function setAudioMute(pid: number, muted: boolean): Promise<Record<string, unknown>> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");
  return (await callHelper({ command: "set-mute", pid, muted })) as Record<string, unknown>;
}
