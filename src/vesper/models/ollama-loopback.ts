/**
 * A local server that speaks Ollama's wire protocol, for tests.
 *
 * `createOllamaProvider` was covered only by tests that stub `fetchImpl` 36 times, while
 * the provider calls five real endpoints and returns bytes it read from a socket. What a
 * stubbed fetch cannot exercise:
 *
 *   - NDJSON framing for `/api/chat` — one JSON object per line, with `done:true` on the
 *     last frame, and no guarantee that Vesper's reader breaks the stream on the same
 *     boundaries the server writes it on;
 *   - the tool-calling shape — Ollama issues no call ids, so the provider synthesises
 *     stable local ones and the agent's tool-record loop has to survive that;
 *   - genuine HTTP failure modes (redirect refused, non-200, connection dropped mid-body);
 *   - the round-trip of the token counters, which are the only measurement (as opposed
 *     to estimate) Vesper's benchmark harness has.
 *
 * The harness binds `127.0.0.1:0` so a port is chosen for it, serves the five endpoints
 * the provider actually calls, and closes on `stop()`. It is deliberately dumb: the test
 * is what decides what a request should produce, not the server.
 *
 * Only loopback. Do NOT bind another interface. Do NOT leave a server running past its
 * test. Neither line is a comment — the tests below assert both.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface OllamaTagFixture {
  name: string;
  size?: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  format?: string;
}

export interface OllamaChatFrame {
  content?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
  thinking?: string;
  /** Only allowed on the last frame; the server enforces `done` on the very last write. */
  error?: string;
}

export interface OllamaChatCompletion {
  frames: OllamaChatFrame[];
  finishReason?: string;
  promptEvalCount?: number;
  evalCount?: number;
  evalDurationNs?: number;
  loadDurationNs?: number;
  /** If set, the server sleeps this long before sending the first frame. */
  firstFrameDelayMs?: number;
  /** If set, the server sends the frames and then closes the socket without `done`. */
  cutBeforeDone?: boolean;
  /** If set, HTTP status returned instead of 200. */
  status?: number;
  /** If set with a redirect status, the Location header the server sends. */
  location?: string;
}

export interface OllamaLoopbackFixture {
  tags?: OllamaTagFixture[];
  /** Keyed by model name; missing model → 404 from /api/show. */
  contextLength?: Record<string, number>;
  /** { name → vram bytes }; empty means /api/ps returns no models. */
  resident?: { name: string; vramBytes?: number }[];
  /** Keyed by model; missing → 404 from /api/embed. */
  embeddings?: Record<string, number[][]>;
  /**
   * Keyed by model. A single completion serves every request; an array is popped in
   * order with the last entry sticking, so a multi-turn agent gets a scripted
   * conversation with a real socket between each turn.
   */
  chat?: Record<string, OllamaChatCompletion | OllamaChatCompletion[]>;
}

export interface OllamaLoopback {
  url: string;
  /** The address the server actually bound to, per `server.address()`. */
  boundAddress: string;
  /** The port the server actually bound to. */
  boundPort: number;
  requests: RequestLog[];
  stop: () => Promise<void>;
  update: (fixture: OllamaLoopbackFixture) => void;
}

export interface RequestLog {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/** Start the server and return its address. Await stop() before letting the test end. */
export async function startOllamaLoopback(initial: OllamaLoopbackFixture = {}): Promise<OllamaLoopback> {
  let fixture = initial;
  const requests: RequestLog[] = [];

  const server = createServer((req, res) => {
    void handle(req, res, () => fixture, requests);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Loopback only. Passing anything else here would be a bug in this harness.
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    boundAddress: address.address,
    boundPort: address.port,
    requests,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    update(next) {
      fixture = next;
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  getFixture: () => OllamaLoopbackFixture,
  requests: RequestLog[],
): Promise<void> {
  const body = await readBody(req);
  const parsed = body.length > 0 ? safeJson(body) : null;
  const path = new URL(req.url ?? "/", "http://loopback").pathname;
  requests.push({ method: req.method ?? "GET", path, body: parsed, headers: req.headers });

  const fixture = getFixture();

  if (req.method === "GET" && path === "/api/tags") {
    const tags = (fixture.tags ?? []).map((t) => ({
      name: t.name,
      model: t.name,
      size: t.size ?? 0,
      details: {
        parameter_size: t.parameterSize,
        quantization_level: t.quantization,
        family: t.family,
        format: t.format ?? "gguf",
      },
    }));
    return sendJson(res, 200, { models: tags });
  }

  if (req.method === "POST" && path === "/api/show") {
    const model = String((parsed as Record<string, unknown>)?.model ?? "");
    const length = fixture.contextLength?.[model];
    if (length == null) return sendJson(res, 404, { error: "model not found" });
    return sendJson(res, 200, { model_info: { "llama.context_length": length } });
  }

  if (req.method === "GET" && path === "/api/ps") {
    const running = (fixture.resident ?? []).map((entry) => ({
      name: entry.name,
      model: entry.name,
      size_vram: entry.vramBytes ?? 0,
    }));
    return sendJson(res, 200, { models: running });
  }

  if (req.method === "POST" && path === "/api/embed") {
    const model = String((parsed as Record<string, unknown>)?.model ?? "");
    const input = (parsed as Record<string, unknown>)?.input;
    const inputs = Array.isArray(input) ? input : [];
    const table = fixture.embeddings?.[model];
    if (!table) return sendJson(res, 404, { error: "model not found" });
    // Vesper checks length match, so the server serves exactly the right count.
    const out = inputs.map((_, i) => table[i] ?? table[table.length - 1] ?? []);
    return sendJson(res, 200, { embeddings: out });
  }

  if (req.method === "POST" && path === "/api/chat") {
    const model = String((parsed as Record<string, unknown>)?.model ?? "");
    const entry = fixture.chat?.[model];
    if (!entry) return sendJson(res, 404, { error: `no completion for ${model}` });
    if (Array.isArray(entry)) {
      // Pop in order, last one sticks. Mutates the fixture through the closure — fine
      // for a test harness serving one runtime at a time.
      const next = entry.length > 1 ? entry.shift()! : entry[0];
      return sendChat(res, next!);
    }
    return sendChat(res, entry);
  }

  return sendJson(res, 404, { error: "unknown endpoint" });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(chunk as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { _unparseable: raw };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function sendChat(res: ServerResponse, completion: OllamaChatCompletion): Promise<void> {
  const status = completion.status ?? 200;
  const headers: Record<string, string> = { "Content-Type": "application/x-ndjson" };
  if (completion.location) headers.Location = completion.location;

  if (status >= 300 && status < 400) {
    // Redirect: the provider should refuse without following. No body.
    res.writeHead(status, headers);
    res.end();
    return;
  }

  res.writeHead(status, headers);

  if (completion.firstFrameDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, completion.firstFrameDelayMs));
  }

  const frames = completion.frames;
  const last = frames.length - 1;
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    const isLast = i === last && !completion.cutBeforeDone;
    const record: Record<string, unknown> = {
      model: "loopback",
      created_at: "2024-01-01T00:00:00Z",
      done: isLast,
    };
    const message: Record<string, unknown> = { role: "assistant", content: frame.content ?? "" };
    if (frame.toolCall) {
      message.tool_calls = [
        { function: { name: frame.toolCall.name, arguments: frame.toolCall.args } },
      ];
    }
    if (frame.thinking) message.thinking = frame.thinking;
    record.message = message;
    if (frame.error) record.error = frame.error;
    if (isLast) {
      record.done_reason = completion.finishReason ?? "stop";
      if (completion.promptEvalCount != null) record.prompt_eval_count = completion.promptEvalCount;
      if (completion.evalCount != null) record.eval_count = completion.evalCount;
      if (completion.evalDurationNs != null) record.eval_duration = completion.evalDurationNs;
      if (completion.loadDurationNs != null) record.load_duration = completion.loadDurationNs;
    }
    res.write(`${JSON.stringify(record)}\n`);
    // Split writes across microtasks so the client's stream reader has to reassemble
    // frames that don't line up with socket boundaries — the real failure mode a
    // fetch-stub could never surface.
    if (i < last) await new Promise((resolve) => setImmediate(resolve));
  }

  if (completion.cutBeforeDone) {
    // Drop the connection without a done frame; the provider should surface the abort.
    res.destroy();
    return;
  }
  res.end();
}
