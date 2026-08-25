import { defaultConfig, parseConfig, type VesperConfig } from "./config.ts";
import { createLogger, type Logger } from "./logging.ts";
import { MemoryStorage, type StorageAdapter } from "./storage.ts";
import { createPermissionGate } from "./permissions.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { registerBuiltinTools } from "./tools/builtin.ts";
import { MemoryStore } from "./memory/store.ts";
import { KnowledgeIndex } from "./knowledge/rag.ts";
import { WorkspaceManager } from "./workspaces.ts";
import { EventBus } from "./events.ts";
import { NotificationHub } from "./notifications.ts";
import { createSimulatedHardware, type SimulatedHardware } from "./hardware/simulated.ts";
import {
  createMockOptimizer,
  createHttpOptimizerAdapter,
  type OptimizerAdapter,
} from "./specialists/optimizer.ts";
import { createSimulatedWindowsHost } from "./windows/host.ts";
import { createDisabledVoice } from "./voice/types.ts";
import { createModelRouter, type ModelRouter } from "./models/router.ts";
import { Agent } from "./agent.ts";
import { firstBoot, conservativeModelPlan } from "./bootstrap.ts";
import { createId } from "./id.ts";
import type { AgentTurn, CapabilityProfile, ChatMessage, PendingConfirmation } from "./types.ts";

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
  capability: CapabilityProfile | null = null;
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
  }

  async start() {
    if (this.started) return this.capability;
    this.log.info("lifecycle", "Vesper starting", { instanceId: this.instanceId });
    await this.seedMemories();
    this.started = true;
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
      this.capability = await firstBoot(this.config, this.log);
      await this.models.probeAll();
    } catch (error) {
      this.log.error("lifecycle", "First-boot discovery failed; continuing degraded", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async stop() {
    this.started = false;
    this.log.info("lifecycle", "Vesper stopped");
  }

  async chat(text: string, options?: { confirmId?: string; approve?: boolean }): Promise<AgentTurn> {
    if (!this.started) await this.start();
    try {
      return await this.agent.handle(text, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("error", "Agent turn failed", { error: message });
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

  snapshot() {
    const hardware = this.hardware.snapshot();
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
      await this.memory.remember({ ...seed, source: "seed" });
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
  const knowledge = new KnowledgeIndex(config.knowledgeSources, [
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
  ]);
  const workspaces = new WorkspaceManager(config);
  const events = new EventBus(log);
  const notifications = new NotificationHub(
    config.notifications.enabled,
    config.notifications.cooldownMs,
  );
  const hardware = createSimulatedHardware(config);
  const optimizer: OptimizerAdapter =
    config.optimizer.mode === "live" && config.optimizer.endpoint
      ? createHttpOptimizerAdapter(config.optimizer.endpoint)
      : createMockOptimizer(hardware);
  const windows = createSimulatedWindowsHost(hardware);
  createDisabledVoice();
  const gate = createPermissionGate(config.permissions, log);
  const confirmations = new Map<string, PendingConfirmation>();
  const tools = new ToolRegistry(gate, log, confirmations);
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
  });
  const models = createModelRouter({
    config,
    providers: options.providers,
    xaiKey: options.xaiKey,
  });
  const history: ChatMessage[] = [];
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
  return new VesperRuntime(config, {
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
  });
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
