import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  DiscoveredModel,
  JsonObject,
  ModelRole,
  ModelToolCall,
  TokenUsage,
} from "../types.ts";
import { emptyUsage } from "../types.ts";
import { finiteOrNull, isRedirect, linkAbort, NO_REDIRECT, nsToMs, readNdjson } from "./http.ts";
import { nativeRoot } from "./ollama-resolve.ts";

export interface OllamaOptions {
  id?: string;
  /**
   * Either the native root (`http://127.0.0.1:11434`) or the OpenAI-compat URL
   * (`.../v1`). The `/v1` suffix is stripped so one config value serves both.
   */
  baseUrl: string;
  defaultModel: string;
  /** Probe/metadata calls. Kept short so a dead backend never stalls startup. */
  probeTimeoutMs?: number;
  /** Generation calls. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Opt-in reasoning mode, sent explicitly on every request.
   *
   * Omitting the field does NOT mean "off" — it means "whatever this model defaults
   * to", and Ollama defaults thinking ON for a thinking-capable model. Vesper reads
   * only `message.content` and discards `message.thinking`, so an omitted field bought
   * reasoning nobody would ever see: measured against a real qwen3:14b, an identical
   * one-sentence answer cost 131 eval tokens and 56.6s with the field omitted versus 8
   * tokens and 3.9s with `think:false`. On slower hardware that difference is the whole
   * 120s generation budget, after which the turn falls back to the offline stub and
   * reports "no local inference backend is available" — a reachable backend that looks
   * like an outage.
   *
   * `think: false` is accepted by non-thinking models too (verified against
   * qwen2.5:0.5b, capabilities `["completion","tools"]`), so this is safe to send
   * unconditionally. `think: true` is not — Ollama rejects it on models without the
   * capability — which is why the opt-in stays opt-in.
   */
  think?: boolean;
  /**
   * Extra native roots to probe, in order, after `baseUrl`. Used by the router so a
   * production config that still has the built-in 127.0.0.1 default can find a daemon
   * answering on localhost or OLLAMA_HOST. Tests that omit this only probe `baseUrl`.
   */
  endpointCandidates?: readonly string[];
}

export { nativeRoot } from "./ollama-resolve.ts";

interface OllamaTag {
  name?: string;
  model?: string;
  size?: number;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
    format?: string;
  };
}

interface OllamaChatChunk {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
  load_duration?: number;
  total_duration?: number;
  error?: string;
}

function toOllamaMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    if (message.role === "tool") {
      // Ollama correlates tool results by name, not by an opaque call id.
      return { role: "tool", content: message.content, tool_name: message.name };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content ?? "",
        tool_calls: message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: call.arguments ?? {} },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function toObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
    } catch {
      /* fall through */
    }
    return { value };
  }
  return {};
}

/** Parse "14.8B" / "7B" / "3.2B" into a number of billions. Unknown shapes stay null. */
export function parseParameterSize(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = /^([\d.]+)\s*([BbMm])$/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return match[2].toLowerCase() === "m" ? value / 1000 : value;
}

export function createOllamaProvider(options: OllamaOptions) {
  const id = options.id ?? "ollama";
  let root = nativeRoot(options.baseUrl);
  const candidates = uniqueRoots([
    root,
    ...(options.endpointCandidates ?? []).map((item) => nativeRoot(item)),
  ]);
  const fetchImpl = options.fetchImpl ?? fetch;
  const probeTimeoutMs = options.probeTimeoutMs ?? 1200;
  let available = false;
  let detail = "Not probed yet.";
  let tags: OllamaTag[] = [];

  async function getJson<T>(path: string, timeoutMs: number, atRoot = root): Promise<T | null> {
    const link = linkAbort(undefined, timeoutMs);
    try {
      const res = await fetchImpl(`${atRoot}${path}`, { signal: link.signal, ...NO_REDIRECT });
      if (isRedirect(res.status) || !res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    } finally {
      link.release();
    }
  }

  async function postJson<T>(path: string, body: unknown, timeoutMs: number): Promise<T | null> {
    const link = linkAbort(undefined, timeoutMs);
    try {
      const res = await fetchImpl(`${root}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: link.signal,
        ...NO_REDIRECT,
      });
      if (isRedirect(res.status) || !res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    } finally {
      link.release();
    }
  }

  return {
    id,
    kind: "local" as const,
    defaultModel: options.defaultModel,
    isAvailable: () => available,
    installedNames: () =>
      tags
        .map((tag) => tag.name ?? tag.model)
        .filter((name): name is string => typeof name === "string" && name.length > 0),

    /** Names from the last successful /api/tags. Empty means unknown, not "none installed". */
    installedModels: () =>
      tags.map((tag) => tag.name ?? tag.model).filter((name): name is string => Boolean(name)),


    async probe(): Promise<{ available: boolean; detail: string }> {
      const results = await Promise.all(
        candidates.map(async (candidate) => {
          const json = await getJson<{ models?: OllamaTag[] }>("/api/tags", probeTimeoutMs, candidate);
          return { candidate, json };
        }),
      );
      const hit = candidates
        .map((candidate) => results.find((row) => row.candidate === candidate && row.json))
        .find((row): row is { candidate: string; json: { models?: OllamaTag[] } } => Boolean(row?.json));
      if (hit) {
        root = hit.candidate;
        tags = Array.isArray(hit.json.models) ? hit.json.models : [];
        available = true;
        detail = tags.length
          ? `Ollama reachable at ${root} with ${tags.length} installed model(s).`
          : `Ollama reachable at ${root} but no models are installed (\`ollama pull <model>\`).`;
        return { available, detail };
      }
      available = false;
      tags = [];
      detail = `No Ollama server answered at ${candidates.join(" or ")}.`;
      return { available, detail };
    },

    /** Installed models with the metadata Vesper needs to pick one. */
    async listModels(): Promise<DiscoveredModel[]> {
      const json = await getJson<{ models?: OllamaTag[] }>("/api/tags", probeTimeoutMs);
      if (!json) return [];
      tags = Array.isArray(json.models) ? json.models : [];
      return tags
        .map((tag): DiscoveredModel | null => {
          const name = tag.name ?? tag.model;
          if (!name) return null;
          const sizeBytes = finiteOrNull(tag.size);
          return {
            provider: id,
            name,
            available: true,
            family: tag.details?.family ?? null,
            parameterSizeB: parseParameterSize(tag.details?.parameter_size),
            quantization: tag.details?.quantization_level ?? null,
            sizeGB: sizeBytes === null ? null : Number((sizeBytes / 1024 ** 3).toFixed(2)),
            contextLength: null,
          };
        })
        .filter((item): item is DiscoveredModel => item !== null);
    },

    /** Context length comes from /api/show; absent metadata stays null, never guessed. */
    async contextLength(model: string): Promise<number | null> {
      const json = await postJson<{ model_info?: Record<string, unknown> }>(
        "/api/show",
        { model },
        probeTimeoutMs,
      );
      if (!json?.model_info) return null;
      for (const [key, value] of Object.entries(json.model_info)) {
        if (key.endsWith(".context_length")) return finiteOrNull(value);
      }
      return null;
    },

    /** Models currently resident, with the VRAM they hold. Observation, not inference. */
    async resident(): Promise<{ model: string; vramBytes: number | null }[]> {
      const json = await getJson<{ models?: { name?: string; model?: string; size_vram?: number }[] }>(
        "/api/ps",
        probeTimeoutMs,
      );
      if (!json?.models) return [];
      return json.models
        .map((entry) => {
          const name = entry.name ?? entry.model;
          return name ? { model: name, vramBytes: finiteOrNull(entry.size_vram) } : null;
        })
        .filter((item): item is { model: string; vramBytes: number | null } => item !== null);
    },

    async embed(texts: string[], model: string): Promise<number[][] | null> {
      if (texts.length === 0) return [];
      const json = await postJson<{ embeddings?: number[][] }>(
        "/api/embed",
        { model, input: texts },
        options.timeoutMs ?? 30_000,
      );
      if (!json || !Array.isArray(json.embeddings)) return null;
      if (json.embeddings.length !== texts.length) return null;
      return json.embeddings;
    },

    async complete(request: CompletionRequest, model: string): Promise<CompletionResult> {
      const startedAt = Date.now();
      const timeoutMs = options.timeoutMs ?? 120_000;
      const link = linkAbort(request.signal, timeoutMs);
      const wantsStream = typeof request.onDelta === "function";

      const body: Record<string, unknown> = {
        model,
        messages: toOllamaMessages(request.messages),
        stream: true,
        options: {
          temperature: request.temperature ?? 0.5,
          ...(request.maxTokens ? { num_predict: request.maxTokens } : {}),
        },
      };
      if (request.tools?.length) {
        body.tools = request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
      }
      // Always explicit. `if (options.think) body.think = true` left the field absent in
      // the default case, which hands the decision to the model's own default rather
      // than making it. See `OllamaOptions.think`.
      body.think = options.think === true;

      let text = "";
      let ttftMs: number | null = null;
      let sawDelta = false;
      const toolCalls: ModelToolCall[] = [];
      const usage: TokenUsage = emptyUsage();
      let finishReason: string | undefined;

      try {
        const res = await fetchImpl(`${root}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: link.signal,
          ...NO_REDIRECT,
        });
        if (isRedirect(res.status)) {
          return unavailable(id, model, request.role, `Refused redirect (HTTP ${res.status}) from ${root}.`);
        }
        if (!res.ok) {
          const detailText = await res.text().catch(() => "");
          return unavailable(id, model, request.role, `HTTP ${res.status}: ${detailText.slice(0, 240)}`);
        }

        for await (const raw of readNdjson(res)) {
          const chunk = raw as OllamaChatChunk;
          if (chunk.error) {
            return unavailable(id, model, request.role, chunk.error.slice(0, 240));
          }
          const piece = chunk.message?.content ?? "";
          if (piece) {
            if (ttftMs === null) ttftMs = Date.now() - startedAt;
            sawDelta = true;
            text += piece;
            if (wantsStream) request.onDelta?.(piece);
          }
          for (const call of chunk.message?.tool_calls ?? []) {
            const name = call.function?.name;
            if (!name) continue;
            if (ttftMs === null) ttftMs = Date.now() - startedAt;
            // Ollama does not issue tool-call ids; synthesize a stable local one.
            toolCalls.push({
              id: `${id}-tc-${toolCalls.length + 1}`,
              name,
              arguments: toObject(call.function?.arguments),
            });
          }
          if (chunk.done) {
            finishReason = chunk.done_reason;
            usage.promptTokens = finiteOrNull(chunk.prompt_eval_count);
            usage.completionTokens = finiteOrNull(chunk.eval_count);
            usage.evalDurationMs = nsToMs(chunk.eval_duration);
            usage.loadDurationMs = nsToMs(chunk.load_duration);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (link.cancelledByCaller()) {
          return {
            text,
            toolCalls,
            providerId: id,
            model,
            role: request.role,
            aborted: true,
            streamed: sawDelta,
            error: "Cancelled before the reply finished.",
            timing: { ttftMs, totalMs: Date.now() - startedAt },
          };
        }
        if (link.timedOut()) {
          return unavailable(id, model, request.role, `Timed out after ${timeoutMs}ms waiting for ${model}.`);
        }
        return unavailable(id, model, request.role, message);
      } finally {
        link.release();
      }

      return {
        text,
        toolCalls,
        providerId: id,
        model,
        role: request.role,
        streamed: sawDelta,
        usage,
        timing: { ttftMs, totalMs: Date.now() - startedAt },
        finishReason,
      };
    },
  };
}

function uniqueRoots(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function unavailable(
  providerId: string,
  model: string,
  role: ModelRole,
  error: string,
): CompletionResult {
  return { text: "", toolCalls: [], providerId, model, role, unavailable: true, error };
}

export type OllamaProvider = ReturnType<typeof createOllamaProvider>;
