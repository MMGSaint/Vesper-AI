import type { VesperRuntime } from "../runtime.ts";
import type { AgentTurn, MemoryEntry, PendingConfirmation, VesperNotification } from "../types.ts";
import { VESPER_VERSION } from "../version.ts";
import {
  CLIENT_PROTOCOL_ID,
  CLIENT_PROTOCOL_VERSION,
  FORBIDDEN_REMOTE_POWERS,
  clientError,
  type CapabilityReport,
  type ClientError,
  type ClientHello,
  type ClientScope,
} from "./protocol.ts";
import { ClientSessionStore, type ClientSession, type IssueSessionInput } from "./session.ts";

export interface ClientStatus {
  hello: ClientHello;
  capabilities: CapabilityReport[];
  workspaceId: string;
  pendingConfirmations: number;
}

export class VesperClientGateway {
  readonly sessions = new ClientSessionStore();
  private readonly runtime: VesperRuntime;

  constructor(runtime: VesperRuntime) {
    this.runtime = runtime;
  }

  issueSession(input: IssueSessionInput): ClientSession {
    return this.sessions.issue(input);
  }

  hello(): ClientHello {
    return {
      protocol: CLIENT_PROTOCOL_ID,
      version: CLIENT_PROTOCOL_VERSION,
      core: VESPER_VERSION,
      instanceId: this.runtime.instanceId,
      started: this.runtime.started,
    };
  }

  async status(token?: string): Promise<ClientStatus | ClientError> {
    const session = this.sessions.require(token, "status");
    if ("ok" in session) return session;
    const diagnostics = await this.runtime.diagnostics();
    const optimizerState =
      diagnostics.optimizer.mode === "live" && diagnostics.optimizer.available
        ? "AVAILABLE"
        : diagnostics.optimizer.mode === "mock"
          ? "DEGRADED"
          : "UNAVAILABLE";
    const voiceState = diagnostics.voice.available ? "AVAILABLE" : "UNAVAILABLE";
    const localModels = diagnostics.models.available.some((item) => item.available && item.kind === "local");
    const mortis = this.runtime.workspaces.get("mortis");
    return {
      hello: this.hello(),
      workspaceId: this.runtime.workspaces.current().id,
      pendingConfirmations: this.runtime.confirmations.size,
      capabilities: [
        {
          id: "assistant",
          state: this.runtime.started ? "AVAILABLE" : "UNAVAILABLE",
          detail: this.runtime.started ? "Local Vesper core is running." : "Host is stopped.",
        },
        {
          id: "local-model",
          state: localModels ? "AVAILABLE" : "NOT_CONFIGURED",
          detail: localModels
            ? "A local generation backend answered probe."
            : "No local Ollama/llama.cpp backend is configured. Echo/scripted providers are not live models.",
        },
        {
          id: "optimizer",
          state: optimizerState,
          detail:
            optimizerState === "AVAILABLE"
              ? diagnostics.optimizer.detail
              : optimizerState === "DEGRADED"
                ? "Mock optimizer adapter only. Live optimizer API is unpublished."
                : diagnostics.optimizer.detail || "Optimizer unavailable. Assistant continues.",
        },
        {
          id: "voice",
          state: voiceState,
          detail: diagnostics.voice.available
            ? `${diagnostics.voice.stt}/${diagnostics.voice.tts}`
            : "Voice interfaces exist. Microphone/speaker are not validated on this host.",
        },
        {
          id: "mortis",
          state: mortis ? "AVAILABLE" : "NOT_CONFIGURED",
          detail: mortis
            ? "Mortis is a scoped workspace, not canon authority."
            : "No Mortis workspace is registered.",
        },
        {
          id: "remote-os",
          state: "UNAVAILABLE",
          detail: `Remote clients cannot use ${FORBIDDEN_REMOTE_POWERS.join(", ")}.`,
        },
      ],
    };
  }

  async converse(token: string | undefined, text: string): Promise<AgentTurn | ClientError> {
    const session = this.sessions.require(token, "conversation");
    if ("ok" in session) return session;
    const trimmed = text.trim();
    if (!trimmed) return clientError("INVALID", "Empty message.");
    return this.runtime.chat(trimmed);
  }

  async confirm(
    token: string | undefined,
    confirmationId: string,
    approve: boolean,
  ): Promise<AgentTurn | ClientError> {
    const session = this.sessions.require(token, "operator.confirm");
    if ("ok" in session) return session;
    const pending = this.runtime.confirmations.get(confirmationId);
    if (!pending) return clientError("NOT_FOUND", "No pending confirmation with that id.");
    if (!approve) {
      this.runtime.confirmations.delete(confirmationId);
      return this.runtime.chat("Operator denied the pending action.");
    }
    return this.runtime.chat("Operator approved the pending action.", {
      confirmId: confirmationId,
      approve: true,
    });
  }

  async listMemory(token: string | undefined): Promise<{ entries: MemoryEntry[] } | ClientError> {
    const session = this.sessions.require(token, "memory.read");
    if ("ok" in session) return session;
    const entries = await this.runtime.memory.exportPersistent();
    return { entries };
  }

  async remember(
    token: string | undefined,
    input: { key: string; value: string; category?: MemoryEntry["category"] },
  ): Promise<{ entry: MemoryEntry } | ClientError> {
    const session = this.sessions.require(token, "memory.write");
    if ("ok" in session) return session;
    if (!input.key.trim() || !input.value.trim()) {
      return clientError("INVALID", "Memory key and value are required.");
    }
    const entry = await this.runtime.memory.remember({
      category: input.category ?? "preference",
      key: input.key.trim(),
      value: input.value.trim(),
      source: "user",
      provenance: { origin: "client", kind: "stated" },
    });
    return { entry };
  }

  async searchKnowledge(
    token: string | undefined,
    query: string,
  ): Promise<{ hits: { path: string; snippet: string; score: number }[] } | ClientError> {
    const session = this.sessions.require(token, "knowledge.read");
    if ("ok" in session) return session;
    const hits = await this.runtime.knowledge.search(query, { limit: 8 });
    return {
      hits: hits.map((hit) => ({ path: hit.path, snippet: hit.snippet, score: hit.score })),
    };
  }

  async notifications(token: string | undefined): Promise<{ items: VesperNotification[] } | ClientError> {
    const session = this.sessions.require(token, "notifications");
    if ("ok" in session) return session;
    return { items: this.runtime.notifications.recent(20) };
  }

  pending(token: string | undefined): PendingConfirmation[] | ClientError {
    const session = this.sessions.require(token, "operator.confirm");
    if ("ok" in session) return session;
    return [...this.runtime.confirmations.values()];
  }

  forbiddenPowers(): readonly string[] {
    return FORBIDDEN_REMOTE_POWERS;
  }

  scopesOf(token: string | undefined): ClientScope[] | ClientError {
    const session = this.sessions.authenticate(token);
    if ("ok" in session) return session;
    return session.scopes;
  }
}

export function createClientGateway(runtime: VesperRuntime): VesperClientGateway {
  return new VesperClientGateway(runtime);
}
