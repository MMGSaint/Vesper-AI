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
import { filterForSync } from "../distributed/sync.ts";
import type { RequestOrigin } from "../tools/remote.ts";

export interface ClientStatus {
  hello: ClientHello;
  capabilities: CapabilityReport[];
  workspaceId: string;
  pendingConfirmations: number;
}

export class VesperClientGateway {
  readonly sessions: ClientSessionStore;
  private readonly runtime: VesperRuntime;

  constructor(runtime: VesperRuntime) {
    this.runtime = runtime;
    // The registry is the single source of truth for whether a device may talk to this
    // Vesper, and it is asked on every request rather than copied into the session.
    this.sessions = new ClientSessionStore(async (deviceId) => {
      const record = await this.runtime.devices.get(deviceId);
      return record?.trust ?? "unknown";
    });
  }

  async issueSession(input: IssueSessionInput): Promise<ClientSession | ClientError> {
    return this.sessions.issue(input);
  }

  /**
   * The authority a remote device is exercising, read fresh.
   *
   * Trust is the requester's; the manifest is this device's. The question being asked
   * is "may a device of that trust class ask *this* machine to do X", so the capability
   * has to be looked up on the machine that would perform the work.
   */
  private async remoteOrigin(
    deviceId: string,
    scopes: readonly ClientScope[],
  ): Promise<RequestOrigin> {
    const [requester, self] = await Promise.all([
      this.runtime.devices.get(deviceId),
      this.runtime.devices.get(this.runtime.deviceIdentity.deviceId),
    ]);
    return {
      kind: "remote",
      deviceId,
      trust: requester?.trust ?? "unknown",
      manifest: self?.capabilities ?? null,
      scopes,
    };
  }

  hello(): ClientHello {
    return {
      protocol: CLIENT_PROTOCOL_ID,
      version: CLIENT_PROTOCOL_VERSION,
      core: VESPER_VERSION,
      instanceId: this.runtime.instanceId,
      deviceId: this.runtime.deviceIdentity.deviceId,
      hostPosture: this.runtime.hostPosture,
      started: this.runtime.started,
    };
  }

  async status(token?: string): Promise<ClientStatus | ClientError> {
    const session = await this.sessions.require(token, "status");
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

  /**
   * Trim a turn to what this session is allowed to see.
   *
   * The envelope carries the host's recent notifications and events for the benefit of a
   * local UI, and gateway.converse handed the whole thing to whoever was talking — so a
   * device refused the `notifications` scope on the method of that name received them
   * anyway, attached to its own reply.
   */
  private project(turn: AgentTurn, session: ClientSession): AgentTurn {
    return {
      ...turn,
      notifications: session.scopes.includes("notifications") ? turn.notifications : [],
      // Events describe what the host has been doing, which is the owner's business and
      // not a companion's. `status` is the scope for "how is the machine", and it has
      // its own method that decides what to say.
      events: [],
    };
  }

  async converse(token: string | undefined, text: string): Promise<AgentTurn | ClientError> {
    const session = await this.sessions.require(token, "conversation");
    if ("ok" in session) return session;
    const trimmed = text.trim();
    if (!trimmed) return clientError("INVALID", "Empty message.");
    // A conversation is a tool-calling loop, so a remote turn must carry who is asking
    // all the way to the point tools run. Without this, "may converse" silently means
    // "may call anything the agent decides to call" on the host's own machine.
    const turn = await this.runtime.chat(trimmed, {
      origin: await this.remoteOrigin(session.deviceId, session.scopes),
    });
    return this.project(turn, session);
  }

  async confirm(
    token: string | undefined,
    confirmationId: string,
    approve: boolean,
  ): Promise<AgentTurn | ClientError> {
    const session = await this.sessions.require(token, "operator.confirm");
    if ("ok" in session) return session;
    const pending = this.runtime.confirmations.get(confirmationId);
    if (!pending) return clientError("NOT_FOUND", "No pending confirmation with that id.");
    if (!approve) {
      // Declining is the safe direction for the *action*, but it is not a safe act
      // against the person waiting on it: any session holding operator.confirm could
      // delete a confirmation the owner had queued and was about to approve, silently
      // and repeatedly. Deciding the fate of a held request is authority over it either
      // way, so a remote device may only decline what its own device asked for.
      const requester = pending.requestedBy;
      const ownsIt = requester?.kind === "remote" && requester.deviceId === session.deviceId;
      if (!ownsIt) {
        return clientError(
          "PERMISSION_DENIED",
          "Only the device that requested an action, or the person at the machine, can decline it.",
        );
      }
      this.runtime.confirmations.delete(confirmationId);
      return this.project(await this.runtime.chat("Operator denied the pending action."), session);
    }

    // The approval carries the approver's own authority into the deferred tool call.
    //
    // Without this the confirmation queue was an authority launderer: a device that is
    // absolutely forbidden the filesystem could approve a held fs_write and it would
    // execute as though the person at the machine had run it. Approving is exercising
    // authority, not merely acknowledging a prompt, so the same limits apply to it as
    // to asking directly.
    const origin = await this.remoteOrigin(session.deviceId, session.scopes);
    this.runtime.events.emit({
      type: "security.remote_confirmation",
      title: `Remote device approved ${pending.toolName}`,
      detail: `Device ${session.deviceId} approved a held ${pending.toolName} requested by ${pending.requestedBy?.kind ?? "an unrecorded origin"}.`,
      severity: "warn",
      workspaceId: pending.workspaceId,
    });
    const turn = await this.runtime.chat("Operator approved the pending action.", {
      confirmId: confirmationId,
      approve: true,
      origin,
    });
    return this.project(turn, session);
  }

  async listMemory(token: string | undefined): Promise<{ entries: MemoryEntry[] } | ClientError> {
    const session = await this.sessions.require(token, "memory.read");
    if ("ok" in session) return session;
    // The whole persistent store went over the wire: every workspace, and anything that
    // looked like a credential. The agent's own retrieval is workspace-scoped and the
    // sync path refuses credential-shaped values; this route had neither.
    const scoped = await this.runtime.memory.search("", {
      workspaceId: this.runtime.workspaces.current().id,
      scope: "workspace",
      limit: 200,
    });
    return { entries: filterForSync(scoped).send };
  }

  async remember(
    token: string | undefined,
    input: { key: string; value: string; category?: MemoryEntry["category"] },
  ): Promise<{ entry: MemoryEntry } | ClientError> {
    const session = await this.sessions.require(token, "memory.write");
    if ("ok" in session) return session;
    if (!input.key.trim() || !input.value.trim()) {
      return clientError("INVALID", "Memory key and value are required.");
    }
    // Recorded as what it is: a companion device asserting something, not the person at
    // the machine saying it. Labelling it "user" gave a remote write the store's most
    // protected eviction rank, so a flood of them pushed out the owner's own memories
    // instead of being pruned first — and it told any UI reading the store back that the
    // owner had said it.
    const entry = await this.runtime.memory.remember({
      category: input.category ?? "preference",
      key: input.key.trim(),
      value: input.value.trim(),
      workspaceId: this.runtime.workspaces.current().id,
      source: "agent",
      provenance: { origin: `client:${session.deviceId}`, kind: "stated" },
    });
    return { entry };
  }

  async searchKnowledge(
    token: string | undefined,
    query: string,
  ): Promise<{ hits: { path: string; snippet: string; score: number }[] } | ClientError> {
    const session = await this.sessions.require(token, "knowledge.read");
    if ("ok" in session) return session;
    // Workspace scoping is enforced by rank() only when it is given a workspaceId, and
    // this was the one retrieval path that passed none — so a companion read documents
    // belonging to workspaces it was not in, while the agent and the knowledge_search
    // tool both scoped correctly.
    const hits = await this.runtime.knowledge.search(query, {
      limit: 8,
      workspaceId: this.runtime.workspaces.current().id,
    });
    return {
      hits: hits.map((hit) => ({ path: hit.path, snippet: hit.snippet, score: hit.score })),
    };
  }

  async notifications(token: string | undefined): Promise<{ items: VesperNotification[] } | ClientError> {
    const session = await this.sessions.require(token, "notifications");
    if ("ok" in session) return session;
    return { items: this.runtime.notifications.recent(20) };
  }

  async pending(token: string | undefined): Promise<PendingConfirmation[] | ClientError> {
    const session = await this.sessions.require(token, "operator.confirm");
    if ("ok" in session) return session;
    return [...this.runtime.confirmations.values()];
  }

  forbiddenPowers(): readonly string[] {
    return FORBIDDEN_REMOTE_POWERS;
  }

  async scopesOf(token: string | undefined): Promise<ClientScope[] | ClientError> {
    const session = await this.sessions.authenticate(token);
    if ("ok" in session) return session;
    return session.scopes;
  }
}

export function createClientGateway(runtime: VesperRuntime): VesperClientGateway {
  return new VesperClientGateway(runtime);
}
