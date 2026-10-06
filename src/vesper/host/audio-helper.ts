import { spawn } from "node:child_process";

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

function helperPath(): string {
  const value = process.env.VESPER_AUDIO_HELPER;
  if (!value) throw new Error("VESPER_AUDIO_HELPER is not configured.");
  return value;
}

async function callHelper(request: Record<string, unknown>): Promise<unknown> {
  const child = spawn(helperPath(), [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.write(JSON.stringify(request) + "\n");
  child.stdin.end();

  const response = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 && stdout.length === 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8") || "audio helper exited with code " + code));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim().split(/\r?\n/)[0] ?? "");
    });
  });

  let parsed: HelperResponse;
  try { parsed = JSON.parse(response) as HelperResponse; }
  catch { throw new Error("Audio helper returned invalid JSON."); }
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
