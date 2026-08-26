import { createId, nowIso } from "./id.ts";
import type { Logger } from "./logging.ts";
import type { MemoryStore } from "./memory/store.ts";
import type { KnowledgeIndex } from "./knowledge/rag.ts";
import type { ModelRouter } from "./models/router.ts";
import type { NotificationHub } from "./notifications.ts";
import type { EventBus } from "./events.ts";
import type { ToolRegistry } from "./tools/registry.ts";
import type { WorkspaceManager } from "./workspaces.ts";
import type { SimulatedHardware } from "./hardware/simulated.ts";
import type { OptimizerAdapter } from "./specialists/optimizer.ts";
import { VESPER_SYSTEM_PROMPT, composeStatusReply } from "./personality.ts";
import { formatWorkloadContext, inspectWorkload } from "./specialists/context.ts";
import { MEMORY_CATEGORIES } from "./types.ts";
import type {
  AgentTurn,
  ChatMessage,
  CompletionResult,
  EpistemicTag,
  JsonObject,
  MemoryCategory,
  PendingConfirmation,
  ToolCallRecord,
} from "./types.ts";

interface AgentDeps {
  log: Logger;
  memory: MemoryStore;
  knowledge: KnowledgeIndex;
  models: ModelRouter;
  tools: ToolRegistry;
  workspaces: WorkspaceManager;
  events: EventBus;
  notifications: NotificationHub;
  hardware: SimulatedHardware;
  optimizer: OptimizerAdapter;
  confirmations: Map<string, PendingConfirmation>;
  history: ChatMessage[];
  maxToolIterations: number;
}

interface DirectIntent {
  kind:
    | "status"
    | "remember"
    | "forget"
    | "recall"
    | "workspace"
    | "optimize"
    | "ready"
    | "scenario"
    | "confirm"
    | "diagnostics"
    | "gpu"
    | "thermal"
    | "obs";
  confidence: number;
  slots: Record<string, string>;
}

/** Messages of context sent to the model, and the cap kept in memory. */
const HISTORY_WINDOW = 16;
const HISTORY_LIMIT = 40;

/**
 * Context budget, in characters.
 *
 * Tool results were inlined whole: a file read, a process list, or a diagnostics dump
 * went into the conversation at full size, several times per turn. On a local model
 * with a modest context window that silently pushes out the system prompt and the
 * user's actual question.
 *
 * Characters, not tokens, on purpose. Vesper cannot count a backend's tokens without
 * asking it, and an estimate must never be presented as a measurement - this is a
 * budget for trimming, and it is never reported as a token count.
 */
const MAX_TOOL_RESULT_CHARS = 3_000;
const MAX_CONTEXT_CHARS = 24_000;

/**
 * Serialize a tool result for the model, keeping the parts that carry meaning.
 *
 * `summary` and `epistemic` are what the model reasons over and what Vesper's honesty
 * rules depend on, so they survive intact; bulky `data` is trimmed, and the trimming is
 * stated in the payload so the model knows the view is partial.
 */
export function encodeToolResult(value: unknown, limit = MAX_TOOL_RESULT_CHARS): string {
  const encoded = JSON.stringify(value ?? {});
  if (encoded.length <= limit) return encoded;

  const record = (value ?? {}) as { summary?: unknown; epistemic?: unknown; ok?: unknown };
  const core = {
    ok: record.ok,
    epistemic: record.epistemic,
    summary: typeof record.summary === "string" ? record.summary : undefined,
  };
  const coreEncoded = JSON.stringify(core);
  const room = Math.max(0, limit - coreEncoded.length - 80);
  return JSON.stringify({
    ...core,
    truncated: true,
    note: `Result was ${encoded.length} characters; showing the first ${room}. Ask for a narrower query if you need more.`,
    dataPreview: room > 0 ? encoded.slice(0, room) : undefined,
  });
}

/** Drop the oldest whole exchanges until the context fits the budget. */
export function fitContext(
  messages: ChatMessage[],
  limit = MAX_CONTEXT_CHARS,
): { messages: ChatMessage[]; dropped: number } {
  const size = (list: ChatMessage[]) =>
    list.reduce((total, message) => total + message.content.length + 32, 0);
  if (size(messages) <= limit) return { messages, dropped: 0 };

  // The system prompt is not optional; trimming starts after it.
  const system = messages[0]?.role === "system" ? [messages[0]] : [];
  let rest = messages.slice(system.length);
  let dropped = 0;

  while (rest.length > 1 && size([...system, ...rest]) > limit) {
    // Remove one message, then re-align so the window still starts at a user turn.
    rest = rest.slice(1);
    dropped += 1;
    const aligned = rest.findIndex((message) => message.role === "user");
    if (aligned > 0) {
      dropped += aligned;
      rest = rest.slice(aligned);
    }
  }
  return { messages: [...system, ...rest], dropped };
}

/**
 * Take the tail of the conversation without splitting an exchange.
 *
 * A window must never begin on a tool result, or on an assistant turn that only issues
 * tool calls: both are meaningless without the message they answer, and a backend
 * rejects the request outright. The window therefore starts at the first user turn
 * inside it.
 */
export function historyWindow(history: ChatMessage[], max: number): ChatMessage[] {
  const start = Math.max(0, history.length - max);
  let index = start;
  while (index < history.length && history[index].role !== "user") index += 1;
  // Every turn pushes the user message before calling the model, so a user turn is
  // always present. If one somehow is not, send no history rather than a broken slice.
  if (index >= history.length) return [];
  return history.slice(index);
}

const READY_APPS: Record<string, string[]> = {
  vrchat: ["steam", "discord", "vrchat"],
  gaming: ["steam", "discord"],
  streaming: ["obs", "discord"],
  development: ["vscode"],
};

export class Agent {
  private readonly deps: AgentDeps;
  /**
   * Turns are serialized. The console, a scheduled task, and a companion session all
   * share one conversation, and a turn mutates it in several steps: user message, tool
   * calls, tool results, reply. Interleaving two turns splices those sequences into
   * each other and reproduces exactly the dangling-tool-call corruption that history
   * integrity is meant to prevent.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  handle(
    userText: string,
    options?: {
      confirmId?: string;
      approve?: boolean;
      signal?: AbortSignal;
      onDelta?: (delta: string) => void;
    },
  ): Promise<AgentTurn> {
    const run = this.queue.then(
      () => this.handleExclusive(userText, options),
      () => this.handleExclusive(userText, options),
    );
    // The queue must survive a failed turn, so it chains on settlement, not success.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * A cancelled turn is recorded honestly: whatever text arrived is kept, the tools
   * that already ran are reported, and nothing claims to have finished.
   */
  private cancelledTurn(
    userText: string,
    toolCalls: ToolCallRecord[],
    at: string,
    completion: CompletionResult,
  ): AgentTurn {
    const partial = completion.text.trim();
    const reply = partial
      ? `${partial}\n\n[Stopped at your request. That reply is incomplete.]`
      : "Stopped at your request. Nothing was completed.";
    return this.turn(userText, reply, ["could_not_access"], toolCalls, [], at, undefined, completion);
  }

  private async handleExclusive(
    userText: string,
    options?: {
      confirmId?: string;
      approve?: boolean;
      /** Cancels the turn: the in-flight model call is aborted and no tool runs after it. */
      signal?: AbortSignal;
      /** Receives assistant text as it is generated, when the backend can stream. */
      onDelta?: (delta: string) => void;
    },
  ): Promise<AgentTurn> {
    const at = nowIso();
    const workspace = this.deps.workspaces.current();
    const epistemic: EpistemicTag[] = [];
    const toolCalls: ToolCallRecord[] = [];
    const pending: PendingConfirmation[] = [];
    const notes = [];

    if (options?.confirmId) {
      const confirmation = this.deps.confirmations.get(options.confirmId);
      if (!confirmation) {
        return this.turn(userText, "That confirmation is no longer pending.", ["could_not_access"], [], [], at);
      }
      this.deps.confirmations.delete(options.confirmId);
      if (options.approve === false) {
        this.deps.log.info("permission", "User denied confirmation", { id: options.confirmId });
        return this.turn(
          userText,
          `I did not run ${confirmation.toolName}. You declined confirmation.`,
          ["could_not_access"],
          [],
          [],
          at,
        );
      }
      const record = await this.deps.tools.invoke({
        name: confirmation.toolName,
        args: confirmation.args,
        workspaceId: confirmation.workspaceId,
        confirmed: true,
      });
      toolCalls.push(record);
      const reply = record.result?.ok
        ? record.result.summary
        : `I could not complete ${confirmation.toolName}: ${record.result?.summary ?? record.decision.reason}`;
      return this.turn(
        userText,
        reply,
        [record.result?.epistemic ?? "could_not_access"],
        toolCalls,
        [],
        at,
        record.result?.ok ? "changed" : undefined,
      );
    }

    const intent = classifyIntent(userText);
    if (intent && intent.confidence >= 0.85) {
      const direct = await this.executeIntent(intent, userText);
      this.deps.history.push({ role: "user", content: userText });
      this.deps.history.push({ role: "assistant", content: direct.reply });
      this.trimHistory();
      return direct;
    }

    const memories = await this.deps.memory.search(userText, { workspaceId: workspace.id, limit: 6 });
    // Awaitable retrieval so a model-backed embedder can actually influence ranking;
    // it falls back to lexical scoring when no embedding backend is reachable.
    const knowledge = await this.deps.knowledge.searchAsync(userText, {
      workspaceId: workspace.id,
      limit: 4,
    });
    const snapshot = this.deps.hardware.snapshot();
    const optimizer = await this.deps.optimizer.getStatus().catch(() => null);

    const system = [
      VESPER_SYSTEM_PROMPT,
      `Active workspace: ${workspace.name} (${workspace.id}). ${workspace.description}`,
      `Hardware mode: ${snapshot.mode}. ${snapshot.notes.join(" ")}`,
      `CPU: ${snapshot.cpu.name} ${snapshot.cpu.utilizationPct}% ${snapshot.cpu.tempC ?? "n/a"}°C`,
      snapshot.gpu
        ? `GPU: ${snapshot.gpu.name} ${snapshot.gpu.utilizationPct}% ${snapshot.gpu.tempC ?? "n/a"}°C VRAM ${snapshot.gpu.vramUsedGB}/${snapshot.gpu.vramGB} GB`
        : "GPU: unavailable",
      `RAM: ${snapshot.ram.usedGB}/${snapshot.ram.totalGB} GB`,
      optimizer
        ? `Optimizer: ${optimizer.available ? optimizer.detail : "unavailable"}. Profile ${optimizer.currentProfile ?? "n/a"}.`
        : "Optimizer: could not query.",
      memories.length
        ? `Relevant memory:\n${memories.map((entry) => `- [${entry.category}] ${entry.key}: ${entry.value}`).join("\n")}`
        : "No relevant memory hits.",
      knowledge.length
        ? `Knowledge hits:\n${knowledge.map((hit) => `- ${hit.title}: ${hit.snippet}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const tools = this.deps.tools.list(workspace.id);
    this.deps.history.push({ role: "user", content: userText });
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...historyWindow(this.deps.history, HISTORY_WINDOW),
    ];

    const role = this.deps.models.resolveRole(userText, workspace.defaultModelRole);
    const fitted = fitContext(messages);
    if (fitted.dropped) {
      this.deps.log.info("model", "Trimmed conversation context to fit the budget", {
        dropped: fitted.dropped,
      });
    }
    messages.splice(0, messages.length, ...fitted.messages);
    let completion = await this.deps.models.complete({
      messages,
      tools,
      role,
      maxTokens: 900,
      signal: options?.signal,
      onDelta: options?.onDelta,
    });

    if (completion.aborted) return this.cancelledTurn(userText, toolCalls, at, completion);

    if (completion.unavailable) {
      this.deps.log.warn("model", "Model unavailable; using grounded fallback", {
        error: completion.error ?? "unavailable",
      });
      const fallback = await this.groundedFallback(userText);
      this.deps.history.push({ role: "assistant", content: fallback.reply });
      this.trimHistory();
      return {
        ...fallback,
        model: {
          providerId: completion.providerId,
          model: completion.model,
          role,
          unavailable: true,
        },
      };
    }

    let iterations = 0;
    // A model that keeps asking for the same thing is stuck, not working. Detect it
    // rather than burning the whole iteration budget on identical calls.
    const attempted = new Set<string>();
    let repeated: string | null = null;
    while (completion.toolCalls.length && iterations < this.deps.maxToolIterations) {
      iterations += 1;
      const signature = completion.toolCalls
        .map((call) => `${call.name}:${JSON.stringify(call.arguments ?? {})}`)
        .sort()
        .join("|");
      if (attempted.has(signature)) {
        repeated = completion.toolCalls.map((call) => call.name).join(", ");
        break;
      }
      attempted.add(signature);
      if (options?.signal?.aborted) return this.cancelledTurn(userText, toolCalls, at, completion);
      const toolMessages: ChatMessage[] = [];
      for (const call of completion.toolCalls) {
        const record = await this.deps.tools.invoke({
          name: call.name,
          args: call.arguments,
          workspaceId: workspace.id,
        });
        toolCalls.push(record);
        if (record.decision.requiresConfirmation && !record.result) {
          const queued = [...this.deps.confirmations.values()].find(
            (item) => item.toolName === call.name,
          );
          if (queued) pending.push(queued);
        }
        if (record.result?.epistemic) epistemic.push(record.result.epistemic);
        toolMessages.push({
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: encodeToolResult(
            record.result ?? { pending: true, reason: record.decision.reason },
          ),
        });
      }
      this.deps.history.push({
        role: "assistant",
        content: completion.text,
        toolCalls: completion.toolCalls,
      });
      messages.push({
        role: "assistant",
        content: completion.text,
        toolCalls: completion.toolCalls,
      });
      messages.push(...toolMessages);
      // The results belong in history as well. Without them, history keeps an
      // assistant message whose tool calls are never answered - a protocol violation
      // that makes a real backend reject every later turn, silently degrading the
      // conversation to the offline stub.
      this.deps.history.push(...toolMessages);
      const refitted = fitContext(messages);
      if (refitted.dropped) messages.splice(0, messages.length, ...refitted.messages);
      completion = await this.deps.models.complete({
        messages,
        tools,
        role,
        maxTokens: 900,
        signal: options?.signal,
        onDelta: options?.onDelta,
      });
      if (completion.aborted) return this.cancelledTurn(userText, toolCalls, at, completion);
      if (completion.unavailable) break;
    }

    if (repeated) {
      // Say what happened. Silently returning the last reply would hide a stuck model.
      const reply = [
        completion.text.trim(),
        `I stopped because I was about to repeat the same call to ${repeated} without new information.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      this.deps.history.push({ role: "assistant", content: reply });
      this.trimHistory();
      return this.turn(userText, reply, ["could_not_access"], toolCalls, pending, at, undefined, completion);
    }

    if (iterations >= this.deps.maxToolIterations && completion.toolCalls.length) {
      const reply = [
        completion.text.trim(),
        `I stopped after ${iterations} tool steps, which is the configured limit for one turn. The work may be incomplete - ask me to continue if it looks unfinished.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      this.deps.log.warn("model", "Tool iteration cap reached", { iterations });
      this.deps.history.push({ role: "assistant", content: reply });
      this.trimHistory();
      return this.turn(userText, reply, ["could_not_access"], toolCalls, pending, at, undefined, completion);
    }

    if (pending.length) {
      const reply = `I need confirmation before I continue: ${pending
        .map((item) => `${item.toolName} (${item.reason})`)
        .join("; ")}`;
      return this.turn(userText, reply, ["requested"], toolCalls, pending, at, undefined, completion);
    }

    const reply = completion.text.trim() || "I checked, but I have nothing additional to add.";
    this.deps.history.push({ role: "assistant", content: reply });
    this.trimHistory();
    if (!epistemic.length) epistemic.push("think");
    notes.push(
      this.deps.notifications.recent(1)[0] ??
        null,
    );
    return this.turn(userText, reply, epistemic, toolCalls, pending, at, undefined, completion);
  }

  private async executeIntent(intent: DirectIntent, userText: string): Promise<AgentTurn> {
    const at = nowIso();
    const workspace = this.deps.workspaces.current();
    const toolCalls: ToolCallRecord[] = [];

    const invoke = async (name: string, args: JsonObject, confirmed = false) => {
      const record = await this.deps.tools.invoke({
        name,
        args,
        workspaceId: workspace.id,
        confirmed,
      });
      toolCalls.push(record);
      return record;
    };

    switch (intent.kind) {
      case "status": {
        const info = await invoke("system_info", {});
        const processes = await invoke("process_list", {});
        const opt = await invoke("optimizer_status", {});
        const snapshot = this.deps.hardware.snapshot();
        const running = this.deps.hardware
          .listProcesses()
          .map((proc) => proc.title ?? proc.name)
          .join(", ");
        const recent = this.deps.events
          .recent({ limit: 3 })
          .map((event) => event.title)
          .join("; ");
        const context = inspectWorkload(this.deps.hardware, {
          optimizerActive: opt.result?.ok === true,
        });
        const reply = composeStatusReply({
          simulated: snapshot.mode === "simulated",
          workspace: workspace.name,
          hardwareNotes: snapshot.notes,
          cpu: `CPU ${snapshot.cpu.utilizationPct}%${snapshot.cpu.tempC != null ? ` at ${snapshot.cpu.tempC}°C` : ""}.`,
          gpu: snapshot.gpu
            ? `GPU ${snapshot.gpu.utilizationPct}%${snapshot.gpu.tempC != null ? ` at ${snapshot.gpu.tempC}°C` : ""}, VRAM ${snapshot.gpu.vramUsedGB}/${snapshot.gpu.vramGB} GB.`
            : "GPU telemetry unavailable.",
          ram: `RAM ${snapshot.ram.usedGB} of ${snapshot.ram.totalGB} GB.`,
          optimizer: opt.result?.summary ?? "I could not access the optimizer.",
          processes: running ? `Running: ${running}. ${formatWorkloadContext(context)}` : `No simulated user apps running. ${formatWorkloadContext(context)}`,
          events: recent ? `Recent: ${recent}.` : "",
        });
        return this.turn(
          userText,
          reply,
          ["checked", opt.result?.epistemic === "could_not_access" ? "could_not_access" : "checked"],
          toolCalls,
          [],
          at,
        );
      }
      case "remember": {
        const record = await invoke("memory_remember", {
          key: intent.slots.key,
          value: intent.slots.value,
          category: (intent.slots.category as MemoryCategory) || "fact",
        });
        return this.turn(
          userText,
          record.result?.summary ?? "I could not store that.",
          [record.result?.epistemic ?? "could_not_access"],
          toolCalls,
          [],
          at,
        );
      }
      case "forget": {
        const record = await invoke("memory_forget", { key: intent.slots.key });
        if (record.decision.requiresConfirmation) {
          const pending = [...this.deps.confirmations.values()].filter(
            (item) => item.toolName === "memory_forget",
          );
          return this.turn(
            userText,
            `Forgetting '${intent.slots.key}' needs confirmation.`,
            ["requested"],
            toolCalls,
            pending,
            at,
          );
        }
        return this.turn(
          userText,
          record.result?.summary ?? "I could not forget that.",
          [record.result?.epistemic ?? "could_not_access"],
          toolCalls,
          [],
          at,
        );
      }
      case "recall": {
        const record = await invoke("memory_search", { query: intent.slots.query });
        const hits = Array.isArray(record.result?.data) ? record.result?.data : [];
        const text =
          hits.length === 0
            ? `I checked memory for '${intent.slots.query}' and found nothing.`
            : `I checked memory:\n${(hits as { key: string; value: string; category: string }[])
                .map((hit) => `• ${hit.key}: ${hit.value}`)
                .join("\n")}`;
        return this.turn(userText, text, ["checked"], toolCalls, [], at);
      }
      case "workspace": {
        const record = await invoke("workspace_switch", { name: intent.slots.name });
        return this.turn(
          userText,
          record.result?.summary ?? "I could not switch workspace.",
          [record.result?.epistemic ?? "could_not_access"],
          toolCalls,
          [],
          at,
        );
      }
      case "optimize": {
        const analysis = await invoke("optimizer_analyze", {});
        const request = await invoke("optimizer_request", {
          action: intent.slots.action || "optimize",
          profile: intent.slots.profile || "",
        });
        if (request.decision.requiresConfirmation) {
          const pending = [...this.deps.confirmations.values()].filter(
            (item) => item.toolName === "optimizer_request",
          );
          return this.turn(
            userText,
            `${analysis.result?.summary ?? ""} I requested an optimizer action and need your confirmation.`.trim(),
            ["requested"],
            toolCalls,
            pending,
            at,
          );
        }
        return this.turn(
          userText,
          [analysis.result?.summary, request.result?.summary].filter(Boolean).join(" "),
          ["requested"],
          toolCalls,
          [],
          at,
        );
      }
      case "ready": {
        const target = intent.slots.target;
        const ws = this.deps.workspaces.switchTo(target);
        if (ws) await invoke("workspace_switch", { name: target });
        const apps = READY_APPS[target] ?? [];
        const launched: string[] = [];
        for (const app of apps) {
          const record = await invoke("app_launch", { name: app });
          if (record.result?.ok) launched.push(app);
        }
        await invoke("set_scenario", { scenario: target === "vrchat" ? "vrchat" : target === "streaming" ? "streaming" : "gaming" });
        const reply = launched.length
          ? `I changed the workspace to ${ws?.name ?? target} and launched simulated apps: ${launched.join(", ")}. The physical PC was not contacted.`
          : `I switched context toward ${target}, but I could not launch the usual apps.`;
        return this.turn(userText, reply, ["changed"], toolCalls, [], at);
      }
      case "scenario": {
        const record = await invoke("set_scenario", { scenario: intent.slots.scenario });
        return this.turn(
          userText,
          record.result?.summary ?? "I could not change the simulator.",
          [record.result?.epistemic ?? "could_not_access"],
          toolCalls,
          [],
          at,
        );
      }
      case "diagnostics": {
        const record = await invoke("diagnostics_report", {});
        return this.turn(
          userText,
          record.result?.summary ?? "I could not generate diagnostics.",
          [record.result?.epistemic ?? "could_not_access"],
          toolCalls,
          [],
          at,
        );
      }
      case "gpu": {
        await invoke("system_info", {});
        const context = await invoke("context_status", {});
        const analysis = await invoke("optimizer_analyze", {});
        const snapshot = this.deps.hardware.snapshot();
        const gpu = snapshot.gpu;
        const reply = [
          snapshot.mode === "simulated"
            ? "I checked the simulated snapshot — this is not live AMD telemetry."
            : "I checked the current hardware snapshot.",
          gpu
            ? `GPU ${gpu.name} is at ${gpu.utilizationPct}% (${gpu.vramUsedGB}/${gpu.vramGB} GB VRAM).`
            : "No GPU snapshot is available.",
          context.result?.summary ?? "",
          analysis.result?.summary ?? "",
          "Live GPU-time attribution per process was not measured.",
        ]
          .filter(Boolean)
          .join(" ");
        return this.turn(userText, reply, ["checked"], toolCalls, [], at);
      }
      case "thermal": {
        await invoke("system_info", {});
        const snapshot = this.deps.hardware.snapshot();
        const reply = [
          snapshot.mode === "simulated"
            ? "Fan and thermal numbers here are simulated. Live AMD telemetry was not read."
            : "I checked the current thermal snapshot.",
          `CPU ${snapshot.cpu.tempC ?? "n/a"}°C at ${snapshot.cpu.utilizationPct}%.`,
          snapshot.gpu
            ? `GPU ${snapshot.gpu.tempC ?? "n/a"}°C at ${snapshot.gpu.utilizationPct}%.`
            : "GPU thermal data unavailable.",
          snapshot.cpu.tempC != null && snapshot.cpu.tempC >= 85
            ? "The snapshot shows elevated CPU temperature."
            : "The snapshot does not show a thermal alarm.",
        ].join(" ");
        return this.turn(userText, reply, ["checked"], toolCalls, [], at);
      }
      case "obs": {
        const context = await invoke("context_status", {});
        const analysis = await invoke("optimizer_analyze", {});
        const workload = inspectWorkload(this.deps.hardware);
        const reply = [
          workload.obsRunning
            ? "OBS is running. I observed the process; I did not read OBS WebSocket capture state unless the simulator scenario is streaming."
            : "OBS is not running on the host adapter, so it is not affecting this snapshot.",
          workload.obsRunning && analysis.result?.summary
            ? analysis.result.summary
            : "",
          context.result?.summary ?? "",
        ]
          .filter(Boolean)
          .join(" ");
        return this.turn(userText, reply, ["checked"], toolCalls, [], at);
      }
      default:
        return this.groundedFallback(userText);
    }
  }

  private async groundedFallback(userText: string): Promise<AgentTurn> {
    const snapshot = this.deps.hardware.snapshot();
    const workspace = this.deps.workspaces.current();
    const reply = `No local model is available, so I stayed on grounded tools. ${composeStatusReply({
      simulated: snapshot.mode === "simulated",
      workspace: workspace.name,
      hardwareNotes: snapshot.notes,
      cpu: `CPU ${snapshot.cpu.utilizationPct}%.`,
      gpu: snapshot.gpu ? `GPU ${snapshot.gpu.utilizationPct}%.` : "GPU unavailable.",
      ram: `RAM ${snapshot.ram.usedGB}/${snapshot.ram.totalGB} GB.`,
      optimizer: "I did not call the optimizer for this fallback.",
      processes: "",
      events: "",
    })} You can still ask me to remember things, switch workspaces, inspect status, or coordinate with the optimizer mock.`;
    this.deps.log.info("model", "Used grounded fallback", { preview: userText.slice(0, 80) });
    return this.turn(userText, reply, ["could_not_access", "checked"], [], [], nowIso());
  }

  private trimHistory() {
    if (this.deps.history.length > HISTORY_LIMIT) {
      const kept = historyWindow(this.deps.history, HISTORY_LIMIT);
      this.deps.history.splice(0, this.deps.history.length, ...kept);
    }
  }

  private turn(
    userText: string,
    reply: string,
    epistemic: EpistemicTag[],
    toolCalls: ToolCallRecord[],
    pendingConfirmations: PendingConfirmation[],
    at: string,
    _changed?: string,
    model?: AgentTurn["model"],
  ): AgentTurn {
    return {
      id: createId("turn"),
      userText,
      reply,
      epistemic: [...new Set(epistemic)],
      toolCalls,
      pendingConfirmations,
      workspaceId: this.deps.workspaces.current().id,
      model,
      notifications: this.deps.notifications.recent(5),
      events: this.deps.events.recent({ limit: 8 }),
      at,
    };
  }
}

export function classifyIntent(text: string): DirectIntent | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  const remember = /^(remember(?: that)?|note that)\s+(.+)$/i.exec(trimmed);
  if (remember) {
    const payload = remember[2] ?? "";
    // "remember preference: ..." names a category, exactly as the console's /remember
    // does. Without this the two interfaces disagree and the reply reads as though a
    // category were chosen when only a key was.
    const tagged = /^([a-z]+):\s*(.+)$/i.exec(payload);
    const category =
      tagged && (MEMORY_CATEGORIES as readonly string[]).includes(tagged[1].toLowerCase())
        ? tagged[1].toLowerCase()
        : undefined;
    if (category && tagged) {
      const value = tagged[2].trim();
      return {
        kind: "remember",
        confidence: 0.95,
        slots: { key: value.slice(0, 48), value, category },
      };
    }
    const split = payload.split(/\s+is\s+|\s+as\s+|:\s+/i);
    const key = split.length > 1 ? split[0].trim() : payload.slice(0, 48).trim();
    const value = split.length > 1 ? split.slice(1).join(" ").trim() : payload;
    return { kind: "remember", confidence: 0.95, slots: { key, value } };
  }

  const forget = /^(forget|delete memory)\s+(.+)$/i.exec(trimmed);
  if (forget) return { kind: "forget", confidence: 0.95, slots: { key: forget[2].trim() } };

  if (/what do you (remember|know) about\s+(.+)/i.test(trimmed) || /^recall\s+(.+)/i.test(trimmed)) {
    const query = trimmed.replace(/what do you (remember|know) about\s+/i, "").replace(/^recall\s+/i, "");
    return { kind: "recall", confidence: 0.9, slots: { query } };
  }

  const ws = /^(?:switch to|use|enter|open)\s+(general|gaming|vrchat|streaming|development|mortis)\b/i.exec(
    trimmed,
  );
  if (ws) return { kind: "workspace", confidence: 0.95, slots: { name: ws[1].toLowerCase() } };

  if (/vesper diagnostics|diagnostic(s)? report|^diagnostics\b/i.test(lower)) {
    return { kind: "diagnostics", confidence: 0.96, slots: {} };
  }

  if (/what('?s| is) happening|status|how('?s| is) (the )?(pc|system|box)/i.test(lower)) {
    return { kind: "status", confidence: 0.93, slots: {} };
  }

  if (/what('?s| is) using (my )?gpu|gpu (usage|bound)|what is using the gpu/i.test(lower)) {
    return { kind: "gpu", confidence: 0.94, slots: {} };
  }

  if (/why are (my )?fans|fans ramping|overheat|thermal|why is it hot/i.test(lower)) {
    return { kind: "thermal", confidence: 0.92, slots: {} };
  }

  if (/is obs affecting|obs affecting|is obs (the )?problem/i.test(lower)) {
    return { kind: "obs", confidence: 0.93, slots: {} };
  }

  if (/optimize( this)?|request optimization|rollback (that|optimization)/i.test(lower)) {
    return {
      kind: "optimize",
      confidence: 0.9,
      slots: { action: /rollback/i.test(lower) ? "rollback" : "optimize" },
    };
  }

  const ready = /(?:get me ready for|prep(?:are)?(?: me)? for|ready for)\s+(vrchat|gaming|streaming|development)/i.exec(
    lower,
  );
  if (ready) return { kind: "ready", confidence: 0.92, slots: { target: ready[1] } };

  const scenario = /simulate\s+(idle|gaming|streaming|gpu-bound|cpu-bound|vrchat|thermal)/i.exec(lower);
  if (scenario) return { kind: "scenario", confidence: 0.96, slots: { scenario: scenario[1] } };

  return null;
}
