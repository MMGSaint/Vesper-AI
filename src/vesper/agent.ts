import { createId, nowIso } from "./id.ts";
import type { Logger } from "./logging.ts";
import type { MemoryStore } from "./memory/store.ts";
import { attribute } from "./memory/scopes.ts";
import { decideRemoteToolRequest, type RequestOrigin } from "./tools/remote.ts";
import type { TrustState } from "./distributed/identity.ts";
import { capScopesForTrust, type ClientScope } from "./client/protocol.ts";
import type { CapabilityManifest } from "./distributed/capabilities.ts";
import type { KnowledgeIndex } from "./knowledge/rag.ts";
import type { ModelRouter } from "./models/router.ts";
import type { NotificationHub } from "./notifications.ts";
import type { EventBus } from "./events.ts";
import type { EventJournal } from "./event-journal.ts";
import type { TaskQueue } from "./distributed/tasks.ts";
import type { CorrectionStore } from "./corrections.ts";
import type { ToolRegistry } from "./tools/registry.ts";
import type { WorkspaceManager } from "./workspaces.ts";
import type { SimulatedHardware } from "./hardware/simulated.ts";
import type { OptimizerAdapter } from "./specialists/optimizer.ts";
import { VESPER_SYSTEM_PROMPT, composeStatusReply } from "./personality.ts";
import { formatWorkloadContext, inspectWorkload } from "./specialists/context.ts";
import { MEMORY_CATEGORIES } from "./types.ts";
import {
  decideUntrusted,
  sanitiseInline,
  type UntrustedPolicyOptions,
  type UntrustedProvenance,
} from "./untrusted.ts";
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
  /**
   * One compact snapshot of the device ecosystem, folded into the prompt each turn.
   * A callback rather than the objects themselves, so the agent does not grow a
   * dependency on the registry, the task queue, and presence separately.
   */
  describeNow?: () => Promise<string> | string;
  /**
   * This machine's device id, used to attribute device-scoped memory. Optional because
   * a Vesper that cannot identify itself must still run locally — it simply declines to
   * claim which device a fact belongs to rather than guessing.
   */
  deviceId?: string;
  /**
   * Resolve a device's trust *now*. A confirmation can outlive the turn that queued it
   * and even the process, so its record stores who asked, never what they were allowed
   * — authority is re-read at the moment it is exercised.
   */
  deviceTrust?: (deviceId: string) => Promise<TrustState>;
  /** This device's capability manifest, for deciding what a peer may ask of it. */
  selfManifest?: () => Promise<CapabilityManifest | null>;
  models: ModelRouter;
  tools: ToolRegistry;
  workspaces: WorkspaceManager;
  events: EventBus;
  notifications: NotificationHub;
  hardware: SimulatedHardware;
  optimizer: OptimizerAdapter;
  confirmations: Map<string, PendingConfirmation>;
  /**
   * Unfinished work, for catch-up.
   *
   * Read from the QUEUE rather than counted from events, because the two answer
   * different questions. Events say what happened while the ring held them; the queue
   * says what is still outstanding right now — which is what someone coming back to
   * their machine is actually asking about, and which survives a restart that the ring
   * does not.
   */
  tasks?: TaskQueue;
  /**
   * Durable events, for looking back further than the 500-entry ring.
   *
   * Optional throughout: a runtime without a journal reports on the ring alone rather
   * than failing, and says nothing about the period it cannot see.
   */
  journal?: EventJournal;
  /** Decision history — where an expectation met contrary evidence. */
  corrections?: CorrectionStore;
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
    | "obs"
    | "catchup"
    | "capabilities";
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
 * Retrieved memory and knowledge are pasted into the system prompt, and `fitContext`
 * treats the system prompt as untrimmable — it can only drop conversation. So an
 * unbounded retrieval envelope does not merely crowd the history, it starves it with no
 * way to recover. Tool results are already capped by `encodeToolResult`; these are the
 * two paths where the text is arbitrary-length and caller-controlled.
 */
const MAX_RETRIEVAL_CHARS = 3_000;

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

/**
 * The widest a single round of tool calls may be.
 *
 * Eight is already more than any legitimate turn needs — the model gets another round if
 * it needs one. See the truncation site in `handle` for why a bound exists at all.
 */
export const MAX_TOOL_CALLS_PER_ROUND = 8;

/**
 * A turn that failed after doing some of its work.
 *
 * The tool records accumulated inside a turn were local to it and went out with the
 * exception, so the runtime's recovery synthesised a turn asserting `could_not_access`
 * with zero tool calls — while a memory write had really happened, the owner's workspace
 * had really been switched, and a confirmation was really sitting in the live queue.
 * The record said nothing happened; the machine disagreed.
 *
 * Carrying the partial records out with the error is what lets the recovery say what did
 * happen. It mirrors `cancelledTurn`, which already reports the tools that ran before a
 * cancellation.
 */
export class TurnFailure extends Error {
  readonly toolCalls: ToolCallRecord[];
  constructor(cause: unknown, toolCalls: ToolCallRecord[]) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TurnFailure";
    this.cause = cause;
    this.toolCalls = toolCalls;
  }
}

/**
 * The most of a message that is used as a retrieval query.
 *
 * Retrieval ranks stored items by similarity to what was asked; the first two thousand
 * characters carry the question. Beyond that the extra tokens add cost, not relevance.
 */
export const MAX_RETRIEVAL_QUERY_CHARS = 2000;

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
      /** Who is driving this turn. Absent means the person at this machine. */
      origin?: RequestOrigin;
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
      /** Who is driving this turn. Absent means the person at this machine. */
      origin?: RequestOrigin;
    },
  ): Promise<AgentTurn> {
    // The accumulator lives out here so a throw from anywhere inside the turn still
    // carries what already ran. See TurnFailure.
    const toolCalls: ToolCallRecord[] = [];
    try {
      return await this.runTurn(userText, toolCalls, options);
    } catch (error) {
      throw error instanceof TurnFailure ? error : new TurnFailure(error, toolCalls);
    }
  }

  private async runTurn(
    userText: string,
    toolCalls: ToolCallRecord[],
    options?: {
      confirmId?: string;
      approve?: boolean;
      signal?: AbortSignal;
      onDelta?: (delta: string) => void;
      origin?: RequestOrigin;
    },
  ): Promise<AgentTurn> {
    const at = nowIso();
    const origin = options?.origin;
    const workspace = this.deps.workspaces.current();
    const epistemic: EpistemicTag[] = [];
    const pending: PendingConfirmation[] = [];
    const notes = [];

    if (options?.confirmId) {
      const confirmation = this.deps.confirmations.get(options.confirmId);
      if (!confirmation) {
        return this.turn(userText, "That confirmation is no longer pending.", ["could_not_access"], [], [], at);
      }
      if (options.approve === false) {
        this.deps.confirmations.delete(options.confirmId);
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

      // An approval can never grant more authority than the request carried. Checked
      // here as well as at queue time because a confirmation outlives the turn that
      // created it: a record restored from disk is not a live origin, and treating a
      // stored "local" as proof of local authority would make the queue file a way to
      // ask for anything.
      // Both sides are checked, because an approval is a second exercise of authority
      // rather than a rubber stamp on the first: the request cannot carry more than the
      // asker held, and it cannot gain more from whoever approves it.
      const requester = await this.resolveOrigin(confirmation.requestedBy);
      const approver = origin ?? { kind: "local" as const };
      const checks = [
        decideRemoteToolRequest({ toolName: confirmation.toolName, origin: requester }),
        decideRemoteToolRequest({ toolName: confirmation.toolName, origin: approver }),
      ];
      const allowedForRequester = checks.find((check) => !check.allowed) ?? checks[0];
      if (!allowedForRequester.allowed) {
        // Deliberately not consumed. A refusal on authority grounds must not destroy a
        // confirmation the owner may still legitimately approve at the machine —
        // otherwise anyone who can attempt an approval can cancel one.
        this.deps.log.warn("permission", allowedForRequester.reason, {
          tool: confirmation.toolName,
          id: options.confirmId,
        });
        return this.turn(
          userText,
          `I did not run ${confirmation.toolName}. ${allowedForRequester.reason} It is still waiting for approval here.`,
          ["could_not_access"],
          [],
          [confirmation],
          at,
        );
      }

      const record = await this.deps.tools.invoke({
        origin: approver,
        name: confirmation.toolName,
        args: confirmation.args,
        workspaceId: confirmation.workspaceId,
        confirmed: true,
      });
      toolCalls.push(record);
      // Authorized and attempted, so it is spent — whether the tool then succeeded or
      // failed on its own terms. Only an authority refusal above leaves it pending.
      this.deps.confirmations.delete(options.confirmId);
      const subsystem = this.subsystemFor(confirmation.toolName);
      const reply = record.result?.ok
        ? subsystem
          ? this.quoteSubsystem(record.result.summary, subsystem)
          : record.result.summary
        : `I could not complete ${confirmation.toolName}: ${
            subsystem
              ? this.quoteSubsystem(record.result?.summary, subsystem) || record.decision.reason
              : (record.result?.summary ?? record.decision.reason)
          }`;
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
      const direct = await this.executeIntent(intent, userText, origin);
      this.deps.history.push({ role: "user", content: userText });
      this.deps.history.push({ role: "assistant", content: direct.reply });
      this.trimHistory();
      return direct;
    }

    // Retrieval is a channel in its own right. A remote session that may not *call*
    // memory_search must not have the same records handed to a model it is talking to —
    // the tool gate would otherwise be the front door on a building with no back wall.
    const mayRead = (scope: ClientScope): boolean =>
      !origin || origin.kind !== "remote" || (origin.scopes ?? []).includes(scope);
    const memoryWithheld = !mayRead("memory.read");
    const knowledgeWithheld = !mayRead("knowledge.read");

    // Retrieval is a relevance heuristic, so it does not need the whole message — and
    // giving it the whole message makes its cost the sender's choice. Both stores score
    // every stored item against every query token, so an unbounded query is unbounded
    // work on a single-threaded host. The gateway refuses very long messages outright;
    // this bounds the local path too, where there is no gateway to refuse anything.
    const retrievalQuery = userText.length > MAX_RETRIEVAL_QUERY_CHARS
      ? userText.slice(0, MAX_RETRIEVAL_QUERY_CHARS)
      : userText;

    const memories = memoryWithheld
      ? []
      : await this.deps.memory.search(retrievalQuery, { workspaceId: workspace.id, limit: 6 });
    // Awaitable retrieval so a model-backed embedder can actually influence ranking;
    // it falls back to lexical scoring when no embedding backend is reachable.
    const knowledge = knowledgeWithheld
      ? []
      : await this.deps.knowledge.searchAsync(retrievalQuery, {
          workspaceId: workspace.id,
          limit: 4,
        });
    const snapshot = this.deps.hardware.snapshot();
    const optimizer = await this.deps.optimizer.getStatus().catch(() => null);

    const nowContext = this.deps.describeNow ? await this.deps.describeNow() : null;
    const system = [
      VESPER_SYSTEM_PROMPT,
      nowContext,
      `Active workspace: ${sanitiseInline(workspace.name, 60)} (${workspace.id}). ${sanitiseInline(workspace.description)}`,
      `Hardware mode: ${snapshot.mode}. ${sanitiseInline(snapshot.notes.join(" "))}`,
      `CPU: ${snapshot.cpu.name} ${snapshot.cpu.utilizationPct}% ${snapshot.cpu.tempC ?? "n/a"}°C`,
      snapshot.gpu
        ? `GPU: ${snapshot.gpu.name} ${snapshot.gpu.utilizationPct}% ${snapshot.gpu.tempC ?? "n/a"}°C VRAM ${snapshot.gpu.vramUsedGB}/${snapshot.gpu.vramGB} GB`
        : "GPU: unavailable",
      `RAM: ${snapshot.ram.usedGB}/${snapshot.ram.totalGB} GB`,
      optimizer
        ? // The optimizer is a separate subsystem reached over HTTP, so its status text
          // is free-form output from another program. Vesper's own words here are the
          // profile and the availability; the subsystem's words get the same envelope as
          // any other external content rather than a place in Vesper's voice.
          [
            `Optimizer profile ${sanitiseInline(optimizer.currentProfile ?? "n/a", 40)}, ${optimizer.available ? "available" : "unavailable"}.`,
            optimizer.available && optimizer.detail
              ? `Status reported by the optimizer:\n${this.screenUntrusted(optimizer.detail, { source: "tool", origin: "optimizer" }, { maxChars: 1_000 })}`
              : "",
          ]
            .filter(Boolean)
            .join("\n")
        : "Optimizer: could not query.",
      memories.length
        ? `Relevant memory:\n${
            this.screenUntrusted(
              memories
                .map(
                  (entry) =>
                    `- [${entry.category}] ${entry.key}: ${attribute(entry, { deviceId: this.deps.deviceId })}`,
                )
                .join("\n"),
              { source: "memory", origin: `${memories.length} stored memor(y|ies)` },
              { maxChars: MAX_RETRIEVAL_CHARS },
            )
          }`
        : memoryWithheld
          ? "Stored memory is not readable by this session. Say it is unavailable rather than guessing at it."
          : "No relevant memory hits.",
      knowledge.length
        ? `Knowledge hits:\n${
            this.screenUntrusted(
              knowledge.map((hit) => `- ${hit.title}: ${hit.snippet}`).join("\n"),
              { source: "knowledge", origin: `${knowledge.length} approved source hit(s)` },
              { maxChars: MAX_RETRIEVAL_CHARS },
            )
          }`
        : knowledgeWithheld
          ? "Indexed documents are not readable by this session. Say so rather than guessing at them."
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
      // How many tool calls one round may contain.
      //
      // `maxToolIterations` bounds the number of *rounds*, and nothing bounded the width
      // of a round, so a steered model multiplied its own reach by asking for hundreds of
      // calls at once. A model asking for more than this in a single round is either
      // malfunctioning or hostile; the extras are dropped and the model is told so on the
      // next round rather than silently.
      if (completion.toolCalls.length > MAX_TOOL_CALLS_PER_ROUND) {
        this.deps.log.warn("tool", "Truncated an oversized tool-call round", {
          asked: completion.toolCalls.length,
          kept: MAX_TOOL_CALLS_PER_ROUND,
        });
        completion = {
          ...completion,
          toolCalls: completion.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND),
        };
      }
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
          origin,
          name: call.name,
          args: call.arguments,
          workspaceId: workspace.id,
        });
        toolCalls.push(record);
        if (record.decision.requiresConfirmation && !record.result) {
          // Exactly the confirmation this call produced. Searching the queue by tool
          // name surfaced whichever one happened to be first, so the prompt could
          // describe one action while approving another.
          const queued = record.confirmationId
            ? this.deps.confirmations.get(record.confirmationId)
            : undefined;
          if (queued) pending.push(queued);
        }
        if (record.result?.epistemic) epistemic.push(record.result.epistemic);
        toolMessages.push({
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: this.screenUntrusted(
            encodeToolResult(record.result ?? { pending: true, reason: record.decision.reason }),
            { source: "tool", origin: call.name },
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

  private async executeIntent(
    intent: DirectIntent,
    userText: string,
    origin?: RequestOrigin,
  ): Promise<AgentTurn> {
    const at = nowIso();
    const workspace = this.deps.workspaces.current();
    const toolCalls: ToolCallRecord[] = [];

    const invoke = async (name: string, args: JsonObject, confirmed = false) => {
      const record = await this.deps.tools.invoke({
        origin,
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
          optimizer:
            this.quoteSubsystem(opt.result?.summary, "The optimizer") || "I could not access the optimizer.",
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
          // The one this call queued, not every memory_forget anyone ever queued.
          const queued = record.confirmationId
            ? this.deps.confirmations.get(record.confirmationId)
            : undefined;
          const pending = queued ? [queued] : [];
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
        // An empty query is the summarise path — the user asked what Vesper knows
        // in general, not for a specific fact.
        const q = intent.slots.query.trim();
        if (q === "") {
          const record = await invoke("memory_summarize", {});
          const hits = Array.isArray(record.result?.data) ? record.result?.data : [];
          const text = hits.length === 0
            ? "I have not been told anything to remember yet."
            : `I remember ${hits.length} thing${hits.length === 1 ? "" : "s"}:\n${(hits as { key: string; value: string; category: string }[])
                .map((hit) => `• [${hit.category}] ${hit.key}: ${hit.value}`)
                .join("\n")}`;
          return this.turn(userText, text, ["checked"], toolCalls, [], at);
        }
        const record = await invoke("memory_search", { query: q });
        const hits = Array.isArray(record.result?.data) ? record.result?.data : [];
        const text =
          hits.length === 0
            ? `I checked memory for '${q}' and found nothing.`
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
          // The one this call queued, not every optimizer_request anyone ever queued.
          const queued = request.confirmationId
            ? this.deps.confirmations.get(request.confirmationId)
            : undefined;
          const pending = queued ? [queued] : [];
          return this.turn(
            userText,
            `${this.quoteSubsystem(analysis.result?.summary, "The optimizer")} I requested an optimizer action and need your confirmation.`.trim(),
            ["requested"],
            toolCalls,
            pending,
            at,
          );
        }
        return this.turn(
          userText,
          [
            this.quoteSubsystem(analysis.result?.summary, "The optimizer"),
            this.quoteSubsystem(request.result?.summary, "The optimizer"),
          ]
            .filter(Boolean)
            .join(" "),
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
          this.quoteSubsystem(analysis.result?.summary, "The optimizer"),
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
      case "catchup":
        return this.catchupReply(userText, toolCalls, at);
      case "capabilities":
        return this.capabilitiesReply(userText, toolCalls, at);
      default:
        return this.groundedFallback(userText);
    }
  }

  /**
   * "Catch me up" — the mission's own example question. What happened while I was away?
   *
   * Composed deterministically from things the runtime already knows: recent events, the
   * count of pending confirmations, the current workspace, and the count of remembered
   * facts. Nothing is fabricated; nothing is asked of the model. Categories are ordered
   * by how much a user is likely to want them first — security first, then anything
   * requiring the user's attention, then lifecycle and applications, then everything
   * else. `lifecycle.idle_tick` is dropped because it is background noise, not news.
   */
  private async catchupReply(
    userText: string,
    toolCalls: ToolCallRecord[],
    at: string,
  ): Promise<AgentTurn> {
    const events = this.deps.events.recent({ limit: 60 });
    const pending = this.deps.confirmations.size;
    const workspace = this.deps.workspaces.current();
    const stats = await this.deps.memory.stats();

    // A crash-recovered event on this boot is worth its own line, above the digest.
    const crashRecovered = events.find((event) => event.type === "lifecycle.crash_recovered");

    const security = events.filter((event) => event.type.startsWith("security."));
    const applications = events.filter(
      (event) =>
        event.type === "application.started" ||
        event.type === "application.stopped" ||
        event.type === "game.started",
    );
    const workspaceChanges = events.filter((event) => event.type === "workspace.switch");
    const optimizer = events.filter((event) => event.type === "optimizer.state");
    const system = events.filter(
      (event) => event.type === "system.state" || event.type === "obs.state",
    );
    // The idle_tick exclusion is defence-in-depth. The digest below only counts
    // start / background_stop / pause, so an idle_tick would be dropped anyway;
    // mutation-removing this filter does not fail any named test. Kept so that if a
    // future author counts `lifecycle.length` directly, or adds a new lifecycle badge,
    // background heartbeat noise does not immediately leak into the reply.
    const lifecycle = events.filter(
      (event) => event.type.startsWith("lifecycle.") && event.type !== "lifecycle.idle_tick",
    );
    const tasks = events.filter((event) => event.type.startsWith("task."));

    const lines: string[] = [];

    if (pending > 0) {
      lines.push(
        `${pending} action${pending === 1 ? "" : "s"} waiting for your confirmation. ` +
          `Type '/status' in the console to see them, or answer the next \`--ask\`.`,
      );
    }
    if (crashRecovered) {
      lines.push(
        `Recovered from an unclean shutdown at some point: ${crashRecovered.title}`,
      );
    }
    if (security.length > 0) {
      lines.push(
        `Security notices (${security.length}): ${security
          .slice(-3)
          .map((event) => event.title)
          .join(" · ")}`,
      );
    }
    if (workspaceChanges.length > 0) {
      const last = workspaceChanges[workspaceChanges.length - 1];
      lines.push(`Workspace changes (${workspaceChanges.length}), most recent: ${last.title}`);
    }
    if (applications.length > 0) {
      const summary = applications.slice(-5).map((event) => event.title).join(" · ");
      lines.push(`Applications (${applications.length}): ${summary}`);
    }
    if (optimizer.length > 0) {
      lines.push(
        `Optimizer state changes (${optimizer.length}): ${optimizer.slice(-2).map((event) => event.title).join(" · ")}`,
      );
    }
    if (tasks.length > 0) {
      const created = tasks.filter((event) => event.type === "task.created").length;
      const completed = tasks.filter((event) => event.type === "task.completed").length;
      const failedFinal = tasks.filter(
        (event) => event.type === "task.failed" && /failed after/.test(event.title),
      ).length;
      const cancelled = tasks.filter((event) => event.type === "task.cancelled").length;
      const parts: string[] = [];
      if (created) parts.push(`${created} queued`);
      if (completed) parts.push(`${completed} completed`);
      if (failedFinal) parts.push(`${failedFinal} failed`);
      if (cancelled) parts.push(`${cancelled} cancelled`);
      if (parts.length) lines.push(`Tasks: ${parts.join(", ")}.`);
    }
    if (system.length > 0) {
      lines.push(`System/OBS state changes (${system.length}).`);
    }

    // Outstanding work, read from the queue rather than counted from events.
    //
    // Event counts answer "what happened while the ring held it"; the queue answers
    // "what is still waiting", which is the question someone returning to their machine
    // is actually asking, and which survives a restart the ring does not. A task that
    // was queued three boots ago and is still blocked appears here and appears nowhere
    // in the ring.
    if (this.deps.tasks) {
      const open = (await this.deps.tasks.list()).filter(
        (task) => task.state === "queued" || task.state === "assigned" || task.state === "blocked",
      );
      if (open.length > 0) {
        const byState = new Map<string, number>();
        for (const task of open) byState.set(task.state, (byState.get(task.state) ?? 0) + 1);
        const breakdown = [...byState.entries()].map(([state, n]) => `${n} ${state}`).join(", ");
        const examples = open
          .slice(0, 2)
          .map((task) => sanitiseInline(task.description, 60))
          .join(" · ");
        lines.push(`Still outstanding (${open.length}): ${breakdown}. ${examples}`);
      }
    }

    // Decisions Vesper made while nobody was watching.
    //
    // Only autonomous ones are worth a catch-up line. A decision the user was present
    // for is not news to them, and listing it turns the digest into a transcript of
    // their own session.
    const autonomous = events.filter(
      (event) => event.type === "autonomy.decision" || event.type === "autonomy.no_action",
    );
    if (autonomous.length > 0) {
      const noAction = autonomous.filter((event) => event.type === "autonomy.no_action").length;
      const acted = autonomous.length - noAction;
      const parts: string[] = [];
      if (acted) parts.push(`${acted} acted on`);
      // "Considered and did nothing" is a real decision and reporting it is the point of
      // recording it. A digest that only ever shows action makes restraint invisible.
      if (noAction) parts.push(`${noAction} deliberately left alone`);
      lines.push(`Autonomy decisions: ${parts.join(", ")}.`);
    }

    // Corrections — where an expectation met contrary evidence.
    if (this.deps.corrections) {
      const recent = await this.deps.corrections.list({ limit: 3 });
      if (recent.length > 0) {
        const wrong = recent.filter((record) => record.outcome === "assumption_wrong");
        // Lead with the ones where Vesper was wrong: those are what the user most needs
        // to know, and burying them under a tally would be a way of not saying it.
        const headline = (wrong[0] ?? recent[recent.length - 1])!;
        lines.push(
          `Corrections (${recent.length} recent): ${sanitiseInline(headline.correction, 140)}` +
            ` — from ${headline.source.origin}.`,
        );
      }
    }

    // How far back this digest can actually see.
    //
    // The ring holds 500 events and is lost on restart. Saying "nothing happened" when
    // the truth is "nothing I still have a record of" is the kind of quiet overclaim the
    // honesty rules exist to prevent, so the horizon is stated whenever there is a
    // journal to state it from.
    if (this.deps.journal && events.length > 0) {
      const oldestInRing = events[0]!.at;
      const durable = await this.deps.journal
        .query({ since: oldestInRing, limit: 1 })
        .catch(() => []);
      if (durable.length === 0) {
        lines.push(`This covers what is still in memory since ${oldestInRing}.`);
      }
    }
    if (lifecycle.length > 0) {
      const started = lifecycle.filter((event) => event.type === "lifecycle.start").length;
      const stopped = lifecycle.filter((event) => event.type === "lifecycle.background_stop").length;
      const paused = lifecycle.filter((event) => event.type === "lifecycle.pause").length;
      const parts: string[] = [];
      if (started) parts.push(`${started} start${started === 1 ? "" : "s"}`);
      if (stopped) parts.push(`${stopped} stop${stopped === 1 ? "" : "s"}`);
      if (paused) parts.push(`${paused} pause${paused === 1 ? "" : "s"}`);
      if (parts.length) lines.push(`Lifecycle: ${parts.join(", ")}.`);
    }

    const context = `Current: workspace ${workspace.name}, ${stats.persistent} remembered fact${stats.persistent === 1 ? "" : "s"}.`;
    lines.push(context);

    // If the only line is the "current" summary, nothing has actually happened worth
    // reporting since Vesper woke up. Say so plainly.
    const reply = lines.length === 1
      ? `Nothing to report — Vesper has been quiet. ${context}`
      : lines.join("\n");

    return this.turn(userText, reply, ["checked"], toolCalls, [], at);
  }

  /**
   * "What can you do?" — answered from the live registry, never from a hand-written list.
   *
   * A static answer would drift the moment a tool is added or removed. Composing the
   * reply from `deps.tools.list(workspaceId)` means it always reflects what is actually
   * loaded for the *current* workspace. Tools are grouped by their permission tier so a
   * user sees the safety picture at a glance: what runs freely versus what needs their
   * OK versus what will never run autonomously. Providers and workspaces come from the
   * router and the workspace manager, so both mirror real state too.
   */
  private async capabilitiesReply(
    userText: string,
    toolCalls: ToolCallRecord[],
    at: string,
  ): Promise<AgentTurn> {
    const workspace = this.deps.workspaces.current();
    const tools = this.deps.tools.list(workspace.id);
    const byTier: Record<string, string[]> = { read: [], safe: [], confirm: [], trusted: [], never: [] };
    for (const spec of tools) {
      const bucket = byTier[spec.permission];
      if (bucket) bucket.push(spec.name);
    }

    const modelStatus = this.deps.models.status();
    // Advertise only real backends to the user. The `echo` provider exists so tests
    // can drive the agent without a model; announcing it as "a model backend" would
    // dilute the truthful "no backend reachable" reply that the mission depends on.
    const reachable = modelStatus.available
      .filter((entry) => entry.available && entry.kind !== "test")
      .map((entry) => entry.id);
    const workspaces = this.deps.workspaces.list().map((entry) => entry.name);
    const stats = await this.deps.memory.stats();

    const lines: string[] = [];
    lines.push(
      `Vesper has ${tools.length} tool${tools.length === 1 ? "" : "s"} in the ${workspace.name} workspace.`,
    );
    if (byTier.read.length > 0) {
      lines.push(`  read (no approval): ${byTier.read.length} — ${sample(byTier.read)}`);
    }
    if (byTier.safe.length > 0) {
      lines.push(`  safe side effects (no approval): ${byTier.safe.length} — ${sample(byTier.safe)}`);
    }
    if (byTier.confirm.length > 0) {
      lines.push(`  needs your confirmation: ${byTier.confirm.length} — ${sample(byTier.confirm)}`);
    }
    if (byTier.trusted.length > 0) {
      lines.push(`  trusted-only: ${byTier.trusted.length} — ${sample(byTier.trusted)}`);
    }
    if (byTier.never.length > 0) {
      lines.push(`  never autonomous: ${byTier.never.length} — ${sample(byTier.never)}`);
    }

    if (reachable.length > 0) {
      lines.push(`Local model backends reachable: ${reachable.join(", ")}.`);
    } else {
      lines.push(
        `No local model backend is reachable. Deterministic intents (status, catch-up, memory, workspace) still work.`,
      );
    }
    lines.push(
      `Workspaces available: ${workspaces.join(", ")}. Say "switch to <name>" to change.`,
    );
    lines.push(
      `Memory: ${stats.persistent} remembered fact${stats.persistent === 1 ? "" : "s"}. Ask "what do you know about me?" for a summary.`,
    );
    lines.push(`Try: "catch me up" · "what is happening" · "remember that ..." · "optimize this".`);

    return this.turn(userText, lines.join("\n"), ["checked"], toolCalls, [], at);
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

  /**
   * The single door every byte of external text walks through before the model sees it.
   *
   * Screening is evidence, not enforcement: the boundary and the escaping are what
   * actually contain an attack, and they apply to clean content too. What this adds is
   * the decision — high-scoring content is withheld outright rather than merely sealed —
   * and the disclosure, because content Vesper refused to read or silently truncated is
   * something the user is owed a record of. Only Vesper-authored labels reach the event
   * log; the attacker's own text never does.
   */
  private screenUntrusted(
    content: string,
    provenance: UntrustedProvenance,
    options: UntrustedPolicyOptions = {},
  ): string {
    const decision = decideUntrusted(content, provenance, options);
    const origin = provenance.origin ?? "an unnamed source";
    const lostData = decision.action === "refuse" || decision.wrapped?.truncated === true;
    if (decision.notice && (decision.action !== "wrap" || lostData)) {
      this.deps.events.emit({
        type: "security.untrusted_content",
        title:
          decision.action === "refuse"
            ? `Withheld ${provenance.source} content from ${origin}`
            : `Screened ${provenance.source} content from ${origin}`,
        detail: decision.notice,
        severity: decision.action === "wrap" ? "info" : "warn",
        workspaceId: this.deps.workspaces.current().id,
        data: {
          action: decision.action,
          source: provenance.source,
          origin,
          score: decision.verdict.score,
          severity: decision.verdict.severity,
          signals: decision.verdict.signals.map((signal) => signal.id),
        },
      });
    }
    return decision.text;
  }

  /**
   * Turn a recorded identity into the authority it actually holds right now.
   *
   * Trust is never taken from the record. A device demoted or revoked since the
   * confirmation was queued must lose the approval with it, and a record with no
   * readable origin resolves to the most restricted thing it could be.
   */
  /**
   * Re-read a remote origin's authority immediately before it is exercised.
   *
   * RequestOrigin is a snapshot taken when the gateway accepted the request, and a turn
   * outlives that moment: a device revoked or demoted while its turn was still running
   * kept the trust and scopes it had at entry, so a revoked phone's already-started
   * conversation went on calling tools. Trust is a live property everywhere else in this
   * system; it has to be live here too, or "revocation is immediate" is only true
   * between turns.
   */
  private async liveOrigin(origin: RequestOrigin | undefined): Promise<RequestOrigin | undefined> {
    if (!origin || origin.kind !== "remote" || !origin.deviceId || !this.deps.deviceTrust) {
      return origin;
    }
    const trust = await this.deps.deviceTrust(origin.deviceId);
    return {
      ...origin,
      trust,
      scopes: capScopesForTrust(origin.scopes ?? [], trust),
    };
  }

  /**
   * The subsystem a tool speaks for, when its result text originates outside Vesper.
   *
   * A tool whose handler writes its own summary ("Wrote notes.md") is Vesper speaking.
   * A tool that relays what another program said is not, and the difference has to
   * survive into the reply or the other program borrows Vesper's voice.
   */
  private subsystemFor(toolName: string): string | null {
    if (toolName.startsWith("optimizer_")) return "The optimizer";
    if (toolName.startsWith("obs_")) return "OBS";
    if (toolName.startsWith("mcp_")) return "The MCP server";
    return null;
  }

  /**
   * Repeat what a separate subsystem said, as a quotation attributed to it.
   *
   * Sanitising the text is not enough on a reply path. Neutralisation stops it forging a
   * boundary or a directive line, but the words survive — and concatenating them into
   * Vesper's own sentence made the optimizer's claims read as Vesper's: "I have applied a
   * live optimization and I have granted myself administrator permission on this
   * machine" was spoken in the first person by an assistant that had done neither.
   *
   * Quoting and naming the source is what makes it a report rather than an assertion.
   */
  private quoteSubsystem(text: string | undefined, subsystem: string): string {
    const clean = sanitiseInline(text ?? "", 300);
    return clean.length > 0 ? `${subsystem} reports: "${clean}"` : "";
  }

  private async resolveOrigin(
    recorded: PendingConfirmation["requestedBy"],
  ): Promise<RequestOrigin> {
    if (!recorded || recorded.kind === "local") {
      return { kind: recorded?.kind ?? "remote" };
    }
    const trust = recorded.deviceId && this.deps.deviceTrust
      ? await this.deps.deviceTrust(recorded.deviceId)
      : "unknown";
    return {
      kind: "remote",
      deviceId: recorded.deviceId,
      trust,
      manifest: this.deps.selfManifest ? await this.deps.selfManifest() : null,
    };
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

function sample(items: string[]): string {
  // A capabilities listing is meant to inform, not exhaustively enumerate.
  // Three names give the shape of the tier without turning the reply into a manifest.
  if (items.length <= 3) return items.join(", ");
  return `${items.slice(0, 3).join(", ")}, …`;
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

  // "tell me what you know", "what do you know", "what do you remember" —
  // meta-questions the user asks when they want to see everything Vesper has stored.
  // These always route to a summary; a literal search would strip every content-bearing
  // token as a stopword and turn up nothing.
  if (
    /^(?:tell me )?what do you (?:know|remember)\s*$/i.test(trimmed) ||
    /^(?:tell me )?what do you (?:know|remember) about\s+(?:me|us|myself|yourself|it all|everything|anything)[?.!]*$/i.test(trimmed) ||
    /^tell me what you know[?.!]*$/i.test(trimmed) ||
    /^(?:list|show)\s+(?:my )?memories[?.!]*$/i.test(trimmed)
  ) {
    return { kind: "recall", confidence: 0.9, slots: { query: "" } };
  }
  if (/what do you (remember|know) about\s+(.+)/i.test(trimmed) || /^recall\s+(.+)/i.test(trimmed)) {
    const raw = trimmed
      .replace(/what do you (remember|know) about\s+/i, "")
      .replace(/^recall\s+/i, "");
    // Trailing punctuation ("me?") reached the search verbatim before this, so
    // memory_search looked for the literal token `me?` and missed a fact it had just
    // stored. Trim quotation and terminal punctuation once at the intent boundary.
    const query = raw.replace(/^["'`]|["'`.!?…,]+$/g, "").trim();
    // If the cleaned query is a self-referential stopword, treat it as "summarise".
    // Adding "me?" to a stopword set does not help — the punctuation must be gone first.
    if (query === "" || /^(?:me|us|myself|yourself|everything|anything|it all)$/i.test(query)) {
      return { kind: "recall", confidence: 0.9, slots: { query: "" } };
    }
    return { kind: "recall", confidence: 0.9, slots: { query } };
  }

  const ws = /^(?:switch to|use|enter|open)\s+(general|gaming|vrchat|streaming|development|mortis)\b/i.exec(
    trimmed,
  );
  if (ws) return { kind: "workspace", confidence: 0.95, slots: { name: ws[1].toLowerCase() } };

  if (/vesper diagnostics|diagnostic(s)? report|^diagnostics\b/i.test(lower)) {
    return { kind: "diagnostics", confidence: 0.96, slots: {} };
  }

  if (
    /^(?:catch me up|what did i miss|what happened while i was away|what'?s new)\b/i.test(trimmed) ||
    /^(?:what happened)$/i.test(trimmed)
  ) {
    return { kind: "catchup", confidence: 0.94, slots: {} };
  }
  if (
    /^(?:help|help me)[?.!]*$/i.test(trimmed) ||
    /^(?:what can you do|what are you (?:able to|capable of))[?.!]*$/i.test(trimmed) ||
    /^(?:list|show)\s+(?:your\s+)?(?:commands|capabilities|tools|abilities|skills)[?.!]*$/i.test(trimmed) ||
    /^(?:tell me )?what (?:you can do|your capabilities are)[?.!]*$/i.test(trimmed) ||
    /^(?:what tools|which tools) (?:do you have|are available)[?.!]*$/i.test(trimmed)
  ) {
    return { kind: "capabilities", confidence: 0.94, slots: {} };
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
