import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  JsonObject,
  ModelRole,
  ModelToolCall,
} from "../types.ts";

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = baseUrl.replace(/\/$/, "");
  try {
    const res = await fetchImpl(`${url}/models`, { signal: controller.signal });
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
    clearTimeout(timer);
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
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? 60_000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          return unavailable(options.id, model, request.role, `HTTP ${res.status}: ${text.slice(0, 240)}`);
        }
        const json = (await res.json()) as {
          choices?: {
            message?: {
              content?: string | null;
              tool_calls?: {
                id: string;
                function: { name: string; arguments: string };
              }[];
            };
          }[];
        };
        const message = json.choices?.[0]?.message;
        const toolCalls: ModelToolCall[] = (message?.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: safeJson(call.function.arguments),
        }));
        return {
          text: message?.content ?? "",
          toolCalls,
          providerId: options.id,
          model,
          role: request.role,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return unavailable(options.id, model, request.role, detail);
      } finally {
        clearTimeout(timer);
      }
    },
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
