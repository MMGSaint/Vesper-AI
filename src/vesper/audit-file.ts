import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEntry } from "./types.ts";

/**
 * Diagnostics-visible state of a JSONL audit sink.
 *
 * `failing` is the fact operators need: the audit trail is incomplete right now. It is
 * deliberately separate from `dropped`, which records permanent loss.
 */
export interface AuditSinkState {
  written: number;
  /** Entries held in memory because the file could not be written. */
  buffered: number;
  /** Entries lost because the in-memory fallback filled up. */
  dropped: number;
  failing: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface AuditSink {
  (entry: AuditEntry): void;
  /** Wait for every queued entry to reach disk. Never rejects. */
  flush(): Promise<AuditSinkState>;
  state(): AuditSinkState;
}

export interface JsonlSinkOptions {
  /** Entries kept in memory while writes fail. Oldest are dropped first. */
  maxBuffered?: number;
  /** Minimum gap between write attempts once the sink is failing. */
  retryAfterMs?: number;
  /** Called on each transition into and out of the failing state. */
  onFailure?: (state: AuditSinkState) => void;
  /** Test seam. */
  now?: () => number;
}

const DEFAULT_MAX_BUFFERED = 500;
const DEFAULT_RETRY_AFTER_MS = 1_000;

/** Audit logs record what the assistant was asked to do. Only the owner may read them. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function serialize(entry: AuditEntry): string {
  try {
    return `${JSON.stringify(entry)}\n`;
  } catch (error) {
    // A value that cannot be serialised must still leave a trace, and must not carry the
    // offending payload into the file.
    return `${JSON.stringify({
      id: entry.id,
      at: entry.at,
      category: entry.category,
      level: entry.level,
      message: entry.message,
      data: { unserializable: error instanceof Error ? error.message : String(error) },
    })}\n`;
  }
}

/**
 * Append audit entries to a JSONL file.
 *
 * A sink that cannot write must never take the assistant down with it. The previous
 * implementation chained `appendFile` onto a promise it never awaited and whose rejection
 * handler repeated the same failing write, so a full disk, a revoked permission, or a
 * deleted log directory produced an unhandled rejection and Node killed the process.
 *
 * Here every write is contained: failures park the entries in a bounded in-memory buffer,
 * flip `failing`, and are reported once per transition rather than once per entry. The
 * buffer is drained on the next successful write, so a transient failure loses nothing.
 */
export function createJsonlSink(filePath: string, options: JsonlSinkOptions = {}): AuditSink {
  const maxBuffered = Math.max(1, options.maxBuffered ?? DEFAULT_MAX_BUFFERED);
  const retryAfterMs = Math.max(0, options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
  const now = options.now ?? (() => Date.now());
  const onFailure =
    options.onFailure ??
    ((state: AuditSinkState) => {
      const detail = state.failing
        ? `Vesper audit log write failed (${state.lastError}); holding ${state.buffered} entries in memory.`
        : `Vesper audit log write recovered; ${state.dropped} entries were lost.`;
      process.stderr.write(`${detail}\n`);
    });

  let pending: string[] = [];
  let written = 0;
  let dropped = 0;
  let failing = false;
  let lastError: string | null = null;
  let lastErrorAt: string | null = null;
  let lastAttempt = 0;
  let tightened = false;
  let chain: Promise<void> = Promise.resolve();

  function state(): AuditSinkState {
    return { written, buffered: pending.length, dropped, failing, lastError, lastErrorAt };
  }

  function trim() {
    if (pending.length <= maxBuffered) return;
    dropped += pending.length - maxBuffered;
    pending = pending.slice(pending.length - maxBuffered);
  }

  /** Best-effort tightening of a log file an earlier version may have created world-readable. */
  async function tighten() {
    if (tightened || process.platform === "win32") return;
    tightened = true;
    try {
      await chmod(filePath, FILE_MODE);
    } catch {
      // The file exists and is writable; its mode is a hardening nicety, not a gate.
    }
  }

  async function drain(force: boolean): Promise<void> {
    if (pending.length === 0) return;
    if (failing && !force && now() - lastAttempt < retryAfterMs) return;
    const batch = pending;
    pending = [];
    lastAttempt = now();
    try {
      await mkdir(dirname(filePath), { recursive: true, mode: DIR_MODE });
      await appendFile(filePath, batch.join(""), { encoding: "utf8", mode: FILE_MODE });
      written += batch.length;
      await tighten();
      if (failing) {
        failing = false;
        onFailure(state());
      }
    } catch (error) {
      // Put the batch back at the front so ordering survives a transient failure.
      pending = [...batch, ...pending];
      trim();
      lastError = error instanceof Error ? error.message : String(error);
      lastErrorAt = new Date().toISOString();
      if (!failing) {
        failing = true;
        onFailure(state());
      }
    }
  }

  function schedule(force: boolean) {
    // `drain` swallows its own errors, so this chain can never reject; the trailing catch
    // is insurance against a future edit reintroducing the crash this sink is here to avoid.
    chain = chain.then(
      () => drain(force),
      () => drain(force),
    ).catch(() => undefined);
    return chain;
  }

  const sink = ((entry: AuditEntry) => {
    pending.push(serialize(entry));
    trim();
    void schedule(false);
  }) as AuditSink;

  sink.flush = async () => {
    // Force past the retry cooldown: a flush is the caller saying "now, and tell me".
    await schedule(true);
    return state();
  };
  sink.state = () => state();
  return sink;
}

function isAuditSink(value: unknown): value is AuditSink {
  return typeof value === "function" && typeof (value as Partial<AuditSink>).flush === "function";
}

/**
 * Drain a sink before shutdown.
 *
 * This used to be a 10ms sleep, which neither waited for the queue nor reported anything.
 * It now awaits the real write and hands back the sink's state so a caller can tell
 * whether the last entries actually landed.
 */
export async function flushSink(
  sink: ((entry: AuditEntry) => void) | undefined,
): Promise<AuditSinkState | null> {
  if (!isAuditSink(sink)) return null;
  return sink.flush();
}
