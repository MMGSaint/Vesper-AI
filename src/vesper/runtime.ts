import { defaultConfig, parseConfig, type VesperConfig } from "./config.ts";
import { createLogger, type Logger } from "./logging.ts";
import { MemoryStorage, type StorageAdapter } from "./storage.ts";
import { createPermissionGate } from "./permissions.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { registerBuiltinTools } from "./tools/builtin.ts";
import { MemoryStore } from "./memory/store.ts";
import { KnowledgeIndex } from "./knowledge/rag.ts";
import {
  createFallbackEmbeddings,
  createHashEmbeddings,
  createProviderEmbeddings,
} from "./knowledge/embeddings.ts";
import { WorkspaceManager } from "./workspaces.ts";
import { EventBus } from "./events.ts";
import { NotificationHub } from "./notifications.ts";
import { createSimulatedHardware, type SimulatedHardware } from "./hardware/simulated.ts";
import {
  createMockOptimizer,
  createHttpOptimizerAdapter,
  type OptimizerAdapter,
} from "./specialists/optimizer.ts";
import { inspectWorkload } from "./specialists/context.ts";
import { createSimulatedWindowsHost } from "./windows/host.ts";
import { createBackgroundRuntime, createTrayMenu, type BackgroundRuntime } from "./windows/runtime.ts";
import { createDisabledVoice, type VoiceModule } from "./voice/types.ts";
import { createVoiceModule } from "./voice/providers.ts";
import { createVoiceSession, type VoiceSession } from "./voice/session.ts";
import { createModelRouter, type ModelRouter } from "./models/router.ts";
import { createBenchmarkHarness, type BenchmarkHarness } from "./models/benchmark.ts";
import { createIdleScheduler, type IdleScheduler } from "./scheduler.ts";
import { Agent } from "./agent.ts";
import { conservativeModelPlan, runFirstBootAutomation } from "./bootstrap.ts";
import { buildDiagnostics } from "./diagnostics.ts";
import { createId } from "./id.ts";
import { describeStartupRegistration } from "./windows/startup.ts";
import type {
  AgentTurn,
  CapabilityProfile,
  ChatMessage,
  DiagnosticReport,
  FirstBootReport,
  JsonObject,
  JsonValue,
  PendingConfirmation,
} from "./types.ts";

export interface RuntimeOptions {
  config?: Partial<VesperConfig> | Record<string, unknown>;
  storage?: StorageAdapter;
  logger?: Logger;
  allowOptionalCloud?: boolean;
  xaiKey?: string;
  providers?: Parameters<typeof createModelRouter>[0]["providers"];
  skipDiscovery?: boolean;
}

export class VesperRuntime {
  readonly config: VesperConfig;
  readonly log: Logger;
  readonly storage: StorageAdapter;
  readonly memory: MemoryStore;
  readonly knowledge: KnowledgeIndex;
  readonly workspaces: WorkspaceManager;
  readonly events: EventBus;
  readonly notifications: NotificationHub;
  readonly hardware: SimulatedHardware;
  readonly optimizer: OptimizerAdapter;
  readonly tools: ToolRegistry;
  readonly models: ModelRouter;
  readonly agent: Agent;
  readonly confirmations: Map<string, PendingConfirmation>;
  readonly instanceId = createId("runtime");
  readonly background: BackgroundRuntime;
  readonly voice: VoiceModule;
  readonly voiceSession: VoiceSession;
  readonly scheduler: IdleScheduler;
  readonly benchmark: BenchmarkHarness;
  capability: CapabilityProfile | null = null;
  firstBootReport: FirstBootReport | null = null;
  started = false;
  private readonly skipDiscovery: boolean;

  constructor(
    config: VesperConfig,
    parts: {
      log: Logger;
      storage: StorageAdapter;
      memory: MemoryStore;
      knowledge: KnowledgeIndex;
      workspaces: WorkspaceManager;
      events: EventBus;
      notifications: NotificationHub;
      hardware: SimulatedHardware;
      optimizer: OptimizerAdapter;
      tools: ToolRegistry;
      models: ModelRouter;
      agent: Agent;
      confirmations: Map<string, PendingConfirmation>;
      skipDiscovery: boolean;
      background: BackgroundRuntime;
      voice: VoiceModule;
      voiceSession: VoiceSession;
      scheduler: IdleScheduler;
      benchmark: BenchmarkHarness;
    },
  ) {
    this.config = config;
    this.log = parts.log;
    this.storage = parts.storage;
    this.memory = parts.memory;
    this.knowledge = parts.knowledge;
    this.workspaces = parts.workspaces;
    this.events = parts.events;
    this.notifications = parts.notifications;
    this.hardware = parts.hardware;
    this.optimizer = parts.optimizer;
    this.tools = parts.tools;
    this.models = parts.models;
    this.agent = parts.agent;
    this.confirmations = parts.confirmations;
    this.skipDiscovery = parts.skipDiscovery;
    this.background = parts.background;
    this.voice = parts.voice;
    this.voiceSession = parts.voiceSession;
    this.scheduler = parts.scheduler;
    this.benchmark = parts.benchmark;
  }

  async start() {
    if (this.started) return this.capability;
    this.log.info("lifecycle", "Vesper starting", { instanceId: this.instanceId });
    await this.restoreConfirmations();
    await this.seedMemories();
    this.started = true;
    await this.background.start();
    if (this.config.agent.idleEventDriven) {
      this.scheduler.start();
    }
    this.events.emit({
      type: "lifecycle.start",
      title: "Vesper is awake",
      severity: "info",
    });
    if (!this.skipDiscovery) {
      void this.discoverInBackground();
    }
    try {
      await this.knowledge.reindex();
    } catch (error) {
      this.log.warn("lifecycle", "Knowledge reindex failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.capability;
  }

  private async discoverInBackground() {
    try {
      this.firstBootReport = await runFirstBootAutomation(this.config, this.log, {
        storage: this.storage,
      });
      this.capability = this.firstBootReport.profile;
      await this.models.probeAll();
    } catch (error) {
      this.log.error("lifecycle", "First-boot discovery failed; continuing degraded", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async stop() {
    this.started = false;
    this.memory.clearSession();
    this.scheduler.stop();
    await this.persistConfirmations();
    await this.background.stop();
    this.log.info("lifecycle", "Vesper stopped");
  }

  async pause() {
    await this.background.pause();
  }

  async resume() {
    await this.background.resume();
  }

  async chat(
    text: string,
    options?: {
      confirmId?: string;
      approve?: boolean;
      /** Cancels this turn without stopping the host. */
      signal?: AbortSignal;
      /** Receives reply text as it is generated, when the backend can stream. */
      onDelta?: (delta: string) => void;
    },
  ): Promise<AgentTurn> {
    if (!this.started) await this.start();
    try {
      const turn = await this.agent.handle(text, options);
      await this.persistConfirmations();
      return turn;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("error", "Agent turn failed", { error: message });
      await this.recordLastError(message, text);
      return {
        id: createId("turn"),
        userText: text,
        reply: `I hit an internal error and recovered: ${message}`,
        epistemic: ["could_not_access"],
        toolCalls: [],
        pendingConfirmations: [],
        workspaceId: this.workspaces.current().id,
        notifications: this.notifications.recent(5),
        events: this.events.recent({ limit: 8 }),
        at: new Date().toISOString(),
      };
    }
  }

  async diagnostics(): Promise<DiagnosticReport> {
    const optimizer = await this.optimizer.getStatus().catch(() => ({
      available: false,
      mode: "unavailable" as const,
      currentProfile: null,
      lastAction: null,
      lastResult: null,
      performanceState: null,
      detail: "Optimizer status failed.",
    }));
    const memory = await this.memory.stats();
    const errors = this.log
      .recent(50)
      .filter((entry) => entry.level === "error")
      .slice(-5)
      .map((entry) => ({ at: entry.at, message: entry.message }));
    return buildDiagnostics({
      instanceId: this.instanceId,
      started: this.started,
      health: this.background.state(),
      models: this.models.status(),
      memory,
      tools: { count: this.tools.list().length },
      permissions: { neverAllowAutonomous: this.config.permissions.neverAllowAutonomous },
      optimizer,
      windows: {
        platform: process.platform,
        simulated: true,
        trayAvailable: this.config.windows.enableTray,
        notificationsAvailable: this.config.notifications.enabled,
        startOnLogin: this.background.startOnLogin(),
      },
      voice: this.voice.status(),
      context: inspectWorkload(this.hardware, { optimizerActive: optimizer.available }),
      capability: this.capability,
      recentErrors: errors,
    });
  }

  snapshot() {
    const hardware = this.hardware.snapshot();
    const health = this.background.health();
    const startup = describeStartupRegistration({
      enabled: health.startOnLogin,
      platform: process.platform,
    });
    return {
      instanceId: this.instanceId,
      started: this.started,
      workspace: this.workspaces.current(),
      workspaces: this.workspaces.list(),
      hardware,
      scenario: this.hardware.getScenario(),
      processes: this.hardware.listProcesses(),
      models: this.models.status(),
      memoryPlan: conservativeModelPlan(this.capability ?? emptyProfile(this.config)),
      capability: this.capability,
      events: this.events.recent({ limit: 12 }),
      notifications: this.notifications.recent(8),
      pendingConfirmations: [...this.confirmations.values()],
      memoriesPreview: [] as { key: string; value: string; category: string }[],
      tools: this.tools.list(this.workspaces.current().id).map((tool) => ({
        name: tool.name,
        permission: tool.permission,
        description: tool.description,
      })),
      audit: this.log.recent(30),
      health,
      tray: createTrayMenu(health),
      voice: this.voice.status(),
      context: inspectWorkload(this.hardware),
      startup,
      scheduler: this.scheduler.status(),
      firstBoot: this.firstBootReport
        ? {
            finishedAt: this.firstBootReport.finishedAt,
            persisted: this.firstBootReport.persisted,
            preferredBackend: this.firstBootReport.defaults.preferredBackend,
            steps: this.firstBootReport.steps.map((step) => ({
              id: step.id,
              ok: step.ok,
              title: step.title,
            })),
          }
        : null,
    };
  }

  async snapshotWithMemory() {
    const snap = this.snapshot();
    const memories = await this.memory.all();
    snap.memoriesPreview = memories.slice(-12).map((entry) => ({
      key: entry.key,
      value: entry.value,
      category: entry.category,
    }));
    return snap;
  }

  async memories() {
    return this.memory.all();
  }

  setOptimizerAvailable(value: boolean) {
    this.optimizer.setAvailable?.(value);
  }

  async lastError(): Promise<{ at: string; message: string; userText?: string } | null> {
    const raw = await this.storage.get("runtime.lastError");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const rec = raw as JsonObject;
    if (typeof rec.message !== "string" || typeof rec.at !== "string") return null;
    return {
      at: rec.at,
      message: rec.message,
      userText: typeof rec.userText === "string" ? rec.userText : undefined,
    };
  }

  private async restoreConfirmations() {
    const raw = await this.storage.get("runtime.confirmations");
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as JsonObject;
      if (typeof rec.id !== "string" || typeof rec.toolName !== "string") continue;
      this.confirmations.set(rec.id, {
        id: rec.id,
        toolName: rec.toolName,
        args: rec.args && typeof rec.args === "object" && !Array.isArray(rec.args) ? (rec.args as JsonObject) : {},
        reason: typeof rec.reason === "string" ? rec.reason : "confirmation required",
        createdAt: typeof rec.createdAt === "string" ? rec.createdAt : new Date().toISOString(),
        workspaceId: typeof rec.workspaceId === "string" ? rec.workspaceId : "general",
      });
    }
    if (this.confirmations.size > 0) {
      this.log.info("permission", "Restored pending confirmations", { count: this.confirmations.size });
    }
  }

  private async persistConfirmations() {
    const list = [...this.confirmations.values()] as unknown as JsonValue;
    await this.storage.set("runtime.confirmations", list);
  }

  private async recordLastError(message: string, userText: string) {
    const payload: JsonObject = {
      at: new Date().toISOString(),
      message,
      userText,
    };
    try {
      await this.storage.set("runtime.lastError", payload);
    } catch {
      // Persistence is best-effort during crash recovery.
    }
  }

  private async seedMemories() {
    const existing = await this.memory.all();
    if (existing.length > 0) return;
    const seeds = [
      {
        category: "preference" as const,
        key: "communication",
        value: "Prefer direct, honest answers. Distinguish checked vs inferred.",
      },
      {
        category: "fact" as const,
        key: "primary-workloads",
        value:
          "Gaming (Squad, Where Winds Meet, VRChat), OBS streaming, coding, research, local AI, Mortis work.",
      },
      {
        category: "project" as const,
        key: "mortis-boundary",
        value: "Mortis is a separate RP/world/project. Do not absorb canon. Use approved sources only.",
      },
      {
        category: "project" as const,
        key: "optimizer-boundary",
        value: "PC Optimizer is a separate specialist. Coordinate through the adapter; do not replace it.",
      },
    ];
    for (const seed of seeds) {
      await this.memory.remember({ ...seed, source: "seed", provenance: { origin: "seed", kind: "stated" } });
    }
  }
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<VesperRuntime> {
  const parsed = parseConfig({ ...defaultConfig(), ...(options.config ?? {}) });
  const config: VesperConfig = {
    ...parsed.config,
    models: {
      ...parsed.config.models,
      allowOptionalCloud: options.allowOptionalCloud ?? parsed.config.models.allowOptionalCloud,
    },
  };
  const log = options.logger ?? createLogger();
  if (!parsed.ok) {
    log.warn("lifecycle", "Config invalid; using defaults", { errors: parsed.errors.join("; ") });
  }
  const storage = options.storage ?? new MemoryStorage();
  const memory = new MemoryStore(storage);
  // The knowledge index is constructed before the model router, so the embedding
  // backend is resolved lazily through this reference rather than by reordering
  // startup. Retrieval degrades to lexical scoring whenever it stays unset.
  const embeddingBackend: {
    current: { isAvailable: () => boolean; embed?: (texts: string[], model: string) => Promise<number[][] | null> } | null;
  } = { current: null };
  const knowledgeEmbeddings = config.embeddings.enabled
    ? createFallbackEmbeddings(
        createProviderEmbeddings({
          id: `${config.embeddings.provider}-embed`,
          model: config.embeddings.model,
          isAvailable: () =>
            Boolean(embeddingBackend.current?.isAvailable() && embeddingBackend.current?.embed),
          embed: async (texts, model) =>
            (await embeddingBackend.current?.embed?.(texts, model)) ?? null,
        }),
      )
    : createHashEmbeddings();
  const knowledge = new KnowledgeIndex(
    config.knowledgeSources,
    [
      {
        sourceId: "vesper-docs",
        path: "docs/architecture.md",
        title: "Architecture",
        text: "Vesper is a local-first personal assistant. Mortis is separate. The PC optimizer is a specialist adapter.",
      },
      {
        sourceId: "mortis-approved",
        path: "knowledge/mortis/boundary.md",
        title: "Mortis boundary",
        text: "Mortis remains an independent codebase. Vesper may use approved notes only when the Mortis workspace is active.",
      },
    ],
    { approvedRoots: config.approvedRoots, embeddings: knowledgeEmbeddings },
  );
  const workspaces = new WorkspaceManager(config);
  const events = new EventBus(log);
  const notifications = new NotificationHub(
    config.notifications.enabled,
    config.notifications.cooldownMs,
  );
  const hardware = createSimulatedHardware(config);
  const optimizer: OptimizerAdapter =
    config.optimizer.mode === "live" && config.optimizer.endpoint
      ? createHttpOptimizerAdapter(config.optimizer.endpoint, {
          timeoutMs: config.optimizer.timeoutMs,
          retries: config.optimizer.retries,
          log,
        })
      : createMockOptimizer(hardware);
  if (config.optimizer.mode === "off") optimizer.setAvailable?.(false);
  const windows = createSimulatedWindowsHost(hardware, {
    nativeNotifications: config.windows.nativeNotifications,
  });
  const voice = config.voice.enabled
    ? await createVoiceModule({
        enabled: true,
        stt: config.voice.stt,
        tts: config.voice.tts,
        pushToTalk: config.voice.pushToTalk,
      })
    : createDisabledVoice();
  const voiceSession = createVoiceSession(voice);
  const background = createBackgroundRuntime({
    events,
    log,
    startOnLogin: config.windows.startOnLogin,
  });
  const scheduler = createIdleScheduler({
    events,
    log,
    intervalMs: config.agent.idleIntervalMs,
    state: () => background.state(),
    isGamingHeavy: () => {
      const snap = hardware.snapshot();
      const scenario = hardware.getScenario();
      return (
        scenario === "gaming" ||
        scenario === "vrchat" ||
        scenario === "gpu-bound" ||
        (snap.gpu?.utilizationPct ?? 0) >= 85
      );
    },
    onTick: async () => {
      events.emit({
        type: "lifecycle.idle_tick",
        title: "Idle maintenance tick",
        severity: "info",
      });
    },
  });
  const gate = createPermissionGate(config.permissions, log);
  const confirmations = new Map<string, PendingConfirmation>();
  const tools = new ToolRegistry(gate, log, confirmations);
  const models = createModelRouter({
    config,
    providers: options.providers,
    xaiKey: options.xaiKey,
  });
  // Now that providers exist, point knowledge embeddings at the configured backend.
  embeddingBackend.current =
    models.providers().find((provider) => provider.id === config.embeddings.provider) ?? null;
  const benchmark = createBenchmarkHarness({ providers: models.providers() });
  const history: ChatMessage[] = [];

  const runtimeRef: { current: VesperRuntime | null } = { current: null };
  registerBuiltinTools({
    registry: tools,
    config,
    hardware,
    windows,
    memory,
    knowledge,
    optimizer,
    workspaces,
    events,
    notifications,
    voice,
    voiceSession,
    background,
    models,
    scheduler,
    benchmark,
    getDiagnostics: async () => {
      if (!runtimeRef.current) throw new Error("Runtime not ready");
      return runtimeRef.current.diagnostics();
    },
  });
  const agent = new Agent({
    log,
    memory,
    knowledge,
    models,
    tools,
    workspaces,
    events,
    notifications,
    hardware,
    optimizer,
    confirmations,
    history,
    maxToolIterations: config.agent.maxToolIterations,
  });
  const runtime = new VesperRuntime(config, {
    log,
    storage,
    memory,
    knowledge,
    workspaces,
    events,
    notifications,
    hardware,
    optimizer,
    tools,
    models,
    agent,
    confirmations,
    skipDiscovery: options.skipDiscovery ?? false,
    background,
    voice,
    voiceSession,
    scheduler,
    benchmark,
  });
  runtimeRef.current = runtime;
  return runtime;
}

function emptyProfile(config: VesperConfig): CapabilityProfile {
  return {
    generatedAt: new Date().toISOString(),
    currentMachine: { os: "unknown", arch: "unknown" },
    targetProfile: config.hardware.target,
    backends: [],
    models: [],
    telemetry: "mocked_simulated",
    audio: "documented_not_implemented",
    windowsIntegration: "mocked_simulated",
    optimizer: "mocked_simulated",
    voice: "documented_not_implemented",
    notes: [],
  };
}
