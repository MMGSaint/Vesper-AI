/**
 * Subprocess plumbing for local voice backends.
 *
 * Voice providers shell out to binaries the user installed. That is the whole attack
 * surface of the voice subsystem, so it lives in one small module:
 *
 *   - never a shell string; always an argv array with `shell: false`
 *   - arguments carrying NUL bytes are refused before they reach the OS
 *   - every run is bounded by a timeout and honours a caller's AbortSignal
 *
 * The runner is injectable so the providers can be tested against a fake binary
 * without installing anything.
 */

import { spawn as nodeSpawn } from "node:child_process";

export interface ProcessResult {
  ok: boolean;
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  error: string | null;
}

export interface RunProcessInput {
  command: string;
  args: string[];
  /** Written to the child's stdin and then closed. */
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
  spawnImpl?: typeof nodeSpawn;
  /** Hard cap on captured stdout, so a runaway child cannot exhaust memory. */
  maxOutputBytes?: number;
}

const NUL = /\0/;

export async function runProcess(input: RunProcessInput): Promise<ProcessResult> {
  const failure = (error: string): ProcessResult => ({
    ok: false,
    code: null,
    stdout: Buffer.alloc(0),
    stderr: "",
    timedOut: false,
    aborted: false,
    error,
  });

  if (!input.command || NUL.test(input.command)) {
    return failure("Refused to run a command with an empty or NUL-containing name.");
  }
  if (input.args.some((arg) => NUL.test(arg))) {
    return failure("Refused to run a command with a NUL byte in its arguments.");
  }
  if (input.signal?.aborted) {
    return { ...failure("Cancelled before the process started."), aborted: true };
  }

  const spawnImpl = input.spawnImpl ?? nodeSpawn;
  const timeoutMs = input.timeoutMs ?? 120_000;
  const maxOutputBytes = input.maxOutputBytes ?? 64 * 1024 * 1024;

  return await new Promise<ProcessResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";

    let child;
    try {
      // shell:false is the default for spawn with an argv array, and is stated here
      // because it is the property that makes the argument handling safe.
      child = spawnImpl(input.command, input.args, { shell: false });
    } catch (error) {
      resolve(failure(error instanceof Error ? error.message : String(error)));
      return;
    }

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* the child is already gone */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      kill();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      stdoutBytes += chunk.length;
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Keep only the tail: enough to explain a failure, bounded in size.
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192);
    });

    child.on("error", (error: Error) => {
      finish(failure(error.message));
    });

    child.on("close", (code: number | null) => {
      finish({
        ok: code === 0 && !timedOut && !aborted,
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: stderr.trim(),
        timedOut,
        aborted,
        error: timedOut
          ? `Process timed out after ${timeoutMs}ms.`
          : aborted
            ? "Cancelled."
            : truncated
              ? "Process output exceeded the capture limit."
              : code === 0
                ? null
                : `Process exited with code ${code}.`,
      });
    });

    if (input.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        /* the child may exit before reading stdin; the close handler reports it */
      });
      child.stdin.end(input.stdin);
    } else {
      child.stdin?.end();
    }
  });
}
