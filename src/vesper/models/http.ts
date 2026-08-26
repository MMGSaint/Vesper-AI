/**
 * Shared HTTP plumbing for local model backends.
 *
 * Everything here is transport-only: no provider chooses a model, interprets a reply,
 * or touches the permission layer. Providers stay swappable because this module owns
 * cancellation, redirect policy, and incremental body parsing in one place.
 */

export interface LinkedAbort {
  signal: AbortSignal;
  /** True when *our* timeout fired rather than the caller cancelling. */
  timedOut: () => boolean;
  /** True when the caller's own signal aborted. */
  cancelledByCaller: () => boolean;
  release: () => void;
}

/**
 * Combine a caller-supplied AbortSignal with a local timeout so a provider can tell the
 * two apart. "You cancelled" and "the backend went silent" are different facts and
 * Vesper reports them differently.
 */
export function linkAbort(callerSignal: AbortSignal | undefined, timeoutMs: number): LinkedAbort {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;

  const onCallerAbort = () => {
    cancelled = true;
    controller.abort();
  };

  if (callerSignal) {
    if (callerSignal.aborted) {
      cancelled = true;
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancelledByCaller: () => cancelled,
    release() {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * Redirects are refused rather than followed. A local backend has no legitimate reason
 * to redirect, and following one would replay request headers (including any API key)
 * to a host the user never approved.
 */
export const NO_REDIRECT: Pick<RequestInit, "redirect"> = { redirect: "manual" };

export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Read a response body line by line without buffering the whole thing. */
export async function* readLines(res: Response): AsyncGenerator<string> {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    for (const line of text.split("\n")) yield line;
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.length) yield buffer.replace(/\r$/, "");
}

/**
 * Server-Sent Events payloads (`data: {...}`), as used by OpenAI-compatible
 * `/chat/completions` streaming. Yields parsed JSON objects and stops at `[DONE]`.
 * Malformed frames are skipped rather than throwing: one bad frame must not lose a
 * whole reply.
 */
export async function* readSseJson(res: Response): AsyncGenerator<unknown> {
  for await (const line of readLines(res)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") return;
    try {
      yield JSON.parse(payload) as unknown;
    } catch {
      continue;
    }
  }
}

/** Newline-delimited JSON, as used by Ollama's native endpoints. */
export async function* readNdjson(res: Response): AsyncGenerator<unknown> {
  for await (const line of readLines(res)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
  }
}

/** Ollama reports durations in nanoseconds. Convert without inventing precision. */
export function nsToMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value / 1e6);
}

export function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
