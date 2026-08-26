import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  JsonObject,
  ModelRole,
  ModelToolCall,
  TokenUsage,
} from "../types.ts";
import { emptyUsage } from "../types.ts";
import { finiteOrNull, isRedirect, linkAbort, NO_REDIRECT, readSseJson } from "./http.ts";

export interface OpenAiCompatOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  kind: "local" | "optional-cloud" | "test";
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function toOpenAiMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
          },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

export async function probeOpenAiCompatible(
  baseUrl: string,
  timeoutMs = 800,
  fetchImpl: typeof fetch = fetch,
): Promise<{ available: boolean; detail: string }> {
  const listed = await listOpenAiModels(baseUrl, timeoutMs, fetchImpl);
  return { available: listed.available, detail: listed.detail };
}

export async function listOpenAiModels(
  baseUrl: string,
  timeoutMs = 800,
  fetchImpl: typeof fetch = fetch,
): Promise<{ available: boolean; models: string[]; detail: string }> {
  const link = linkAbort(undefined, timeoutMs);
  const url = baseUrl.replace(/\/$/, "");
  try {
    const res = await fetchImpl(`${url}/models`, { signal: link.signal, ...NO_REDIRECT });
    if (isRedirect(res.status)) {
      return { available: false, models: [], detail: `Refused redirect (HTTP ${res.status}) from ${url}` };
    }
    if (!res.ok) return { available: false, models: [], detail: `HTTP ${res.status} from ${url}` };
    const json = (await res.json()) as { data?: { id?: string }[] };
    const models = (json.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id));
    return {
      available: true,
      models,
      detail: models.length ? `Reached ${url} (${models.length} models)` : `Reached ${url}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, models: [], detail: `Unreachable: ${message}` };
  } finally {
    link.release();
  }
}

export function createOpenAiCompatProvider(options: OpenAiCompatOptions) {
  let available =
    options.kind === "test" || (options.kind === "optional-cloud" && Boolean(options.apiKey));
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    id: options.id,
    kind: options.kind,
    defaultModel: options.defaultModel,
    async probe() {
      if (!options.apiKey && options.kind === "optional-cloud") {
        available = false;
        return { available, detail: "No API key" };
      }
      if (options.kind === "optional-cloud" && options.apiKey) {
        available = true;
        return { available, detail: "Optional cloud key present (not probed on every boot)" };
      }
      const result = await probeOpenAiCompatible(options.baseUrl, options.timeoutMs ?? 1200, fetchImpl);
      available = result.available;
      return result;
    },
    isAvailable: () => available,
    async complete(request: CompletionRequest, model: string): Promise<CompletionResult> {
      if (!available && options.kind !== "optional-cloud") {
        return unavailable(options.id, model, request.role, "Provider is not available.");
      }
      const apiKey = options.apiKey;
      if (options.kind === "optional-cloud" && !apiKey) {
        return unavailable(options.id, model, request.role, "Optional cloud provider has no key.");
      }
      const url = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const body: Record<string, unknown> = {
        model,
        messages: toOpenAiMessages(request.messages),
        temperature: request.temperature ?? 0.5,
        max_tokens: request.maxTokens ?? 900,
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
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const wantsStream = typeof request.onDelta === "function";
      if (wantsStream) {
        body.stream = true;
        // Servers that ignore this simply omit usage; Vesper then reports null counters
        // rather than estimating them.
        body.stream_options = { include_usage: true };
      }

      const startedAt = Date.now();
      const timeoutMs = options.timeoutMs ?? 60_000;
      const link = linkAbort(request.signal, timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: link.signal,
          ...NO_REDIRECT,
        });
        if (isRedirect(res.status)) {
          return unavailable(
            options.id,
            model,
            request.role,
            `Refused redirect (HTTP ${res.status}) from ${url}.`,
          );
        }
        if (!res.ok) {
          const text = await res.text();
          return unavailable(options.id, model, request.role, `HTTP ${res.status}: ${text.slice(0, 240)}`);
        }

        if (wantsStream) {
          return await readStream(res, request, options.id, model, startedAt);
        }

        const json = (await res.json()) as {
          choices?: {
            finish_reason?: string;
            message?: {
              content?: string | null;
              tool_calls?: {
                id: string;
                function: { name: string; arguments: string };
              }[];
            };
          }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const choice = json.choices?.[0];
        const message = choice?.message;
        const toolCalls: ModelToolCall[] = (message?.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: safeJson(call.function.arguments),
        }));
        const usage = emptyUsage();
        usage.promptTokens = finiteOrNull(json.usage?.prompt_tokens);
        usage.completionTokens = finiteOrNull(json.usage?.completion_tokens);
        return {
          text: message?.content ?? "",
          toolCalls,
          providerId: options.id,
          model,
          role: request.role,
          streamed: false,
          usage,
          // Not streamed, so time-to-first-token was never observable.
          timing: { ttftMs: null, totalMs: Date.now() - startedAt },
          finishReason: choice?.finish_reason,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (link.cancelledByCaller()) {
          return {
            text: "",
            toolCalls: [],
            providerId: options.id,
            model,
            role: request.role,
            aborted: true,
            error: "Cancelled before the reply finished.",
            timing: { ttftMs: null, totalMs: Date.now() - startedAt },
          };
        }
        if (link.timedOut()) {
          return unavailable(
            options.id,
            model,
            request.role,
            `Timed out after ${timeoutMs}ms waiting for ${model}.`,
          );
        }
        return unavailable(options.id, model, request.role, detail);
      } finally {
        link.release();
      }
    },
  };
}

interface StreamToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Consume an OpenAI-style SSE stream.
 *
 * Tool-call arguments arrive as string fragments keyed by index and must be
 * reassembled before parsing; a fragment on its own is not valid JSON.
 */
async function readStream(
  res: Response,
  request: CompletionRequest,
  providerId: string,
  model: string,
  startedAt: number,
): Promise<CompletionResult> {
  let text = "";
  let ttftMs: number | null = null;
  let sawDelta = false;
  let finishReason: string | undefined;
  const usage: TokenUsage = emptyUsage();
  const pending = new Map<number, StreamToolCall>();

  for await (const raw of readSseJson(res)) {
    const frame = raw as {
      choices?: {
        index?: number;
        finish_reason?: string | null;
        delta?: {
          content?: string | null;
          tool_calls?: {
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    };

    if (frame.usage) {
      usage.promptTokens = finiteOrNull(frame.usage.prompt_tokens);
      usage.completionTokens = finiteOrNull(frame.usage.completion_tokens);
    }

    const choice = frame.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const piece = choice.delta?.content;
    if (piece) {
      if (ttftMs === null) ttftMs = Date.now() - startedAt;
      sawDelta = true;
      text += piece;
      request.onDelta?.(piece);
    }

    for (const call of choice.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const existing = pending.get(index) ?? { id: "", name: "", args: "" };
      if (call.id) existing.id = call.id;
      if (call.function?.name) existing.name = call.function.name;
      if (call.function?.arguments) existing.args += call.function.arguments;
      pending.set(index, existing);
      if (ttftMs === null) ttftMs = Date.now() - startedAt;
    }
  }

  const toolCalls: ModelToolCall[] = [...pending.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, call]) => call.name)
    .map(([index, call]) => ({
      id: call.id || `${providerId}-tc-${index + 1}`,
      name: call.name,
      arguments: safeJson(call.args || "{}"),
    }));

  return {
    text,
    toolCalls,
    providerId,
    model,
    role: request.role,
    streamed: sawDelta,
    usage,
    timing: { ttftMs, totalMs: Date.now() - startedAt },
    finishReason,
  };
}

function safeJson(raw: string): JsonObject {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
    return { value: raw };
  } catch {
    return { raw };
  }
}

function unavailable(
  providerId: string,
  model: string,
  role: ModelRole,
  error: string,
): CompletionResult {
  return {
    text: "",
    toolCalls: [],
    providerId,
    model,
    role,
    unavailable: true,
    error,
  };
}

export type OpenAiCompatProvider = ReturnType<typeof createOpenAiCompatProvider>;
