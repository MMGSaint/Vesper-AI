import { dirname, join } from "node:path";
import { defaultConfig, parseConfig, type VesperConfig } from "./config.ts";
import { registerOwnPaths } from "./security.ts";
import { createLogger, type Logger } from "./logging.ts";
import { MemoryStorage, type StorageAdapter } from "./storage.ts";
import { createPermissionGate } from "./permissions.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { registerBuiltinTools } from "./tools/builtin.ts";
import { TOOL_CALL_TASK_KIND, createToolCallExecutor } from "./tool-executor.ts";
import { CorrectionStore } from "./corrections.ts";
import { HardwareProbeRegistry, registerPlaceholderProbes } from "./hardware/probes.ts";
import { ReadinessMonitor } from "./host/readiness.ts";
import { OptimizerCorrectionProducer } from "./correction-producer.ts";
import {
  FS_WRITE_CHECKPOINT_TOOL,
  deleteApproved,
  readApprovedExact,
  writeApproved,
} from "./tools/filesystem.ts";
import { MemoryStore } from "./memory/store.ts";
import { KnowledgeIndex } from "./knowledge/rag.ts";
import {
  createFallbackEmbeddings,
  createHashEmbeddings,
  createProviderEmbeddings,
} from "./knowledge/embeddings.ts";
import { WorkspaceManager } from "./workspaces.ts";
import { EventBus } from "./events.ts";
import { EventJournal } from "./event-journal.ts";
import { TaskExecutorRegistry, TaskScheduler, registerBuiltinExecutors } from "./task-scheduler.ts";
import { AutonomyGovernor, defaultAutonomyPolicy } from "./autonomy.ts";
import { CheckpointStore } from "./checkpoint.ts";
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
import { Agent, TurnFailure } from "./agent.ts";
import { conservativeModelPlan, runFirstBootAutomation } from "./bootstrap.ts";
import { coercePreview } from "./preview.ts";
import { buildDiagnostics } from "./diagnostics.ts";
import { createId } from "./id.ts";
import { createObsClient, type ObsClient } from "./specialists/obs.ts";
import { VESPER_VERSION } from "./version.ts";
import { loadDeviceIdentity, type DeviceIdentity, type HostPosture } from "./distributed/identity.ts";
import { DeviceRegistry } from "./distributed/registry.ts";
import { TaskQueue } from "./distributed/tasks.ts";
import { buildNow, renderNow } from "./distributed/now.ts";
import {
  discoverCapabilities,
  grantsRespectForbiddenPowers,
  type CapabilityManifest,
} from "./distributed/capabilities.ts";
import { buildDiscoveryProbes } from "./distributed/discovery.ts";
import type { RequestOrigin } from "./tools/remote.ts";
import { describeStartupRegistration } from "./windows/startup.ts";
import { MEMORY_CATEGORIES } from "./types.ts";
import type {
  AgentTurn,
  CapabilityProfile,
  ChatMessage,
  DiagnosticReport,
  EpistemicTag,
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
  /**
   * Where Vesper's own files live.
   *
   * `data` is where the device keypair goes; absent (as in tests) the identity is kept
   * in the storage adapter instead, so a test never writes a key to the developer's
   * disk. The rest are declared so Vesper's own tools and indexer refuse them — the
   * config file and the audit log are Vesper's business, not documents.
   */
  dirs?: { data: string; config?: string; logs?: string; models?: string; root?: string };
  /**
   * Where the device revocation list is kept, when it must outlive the state file.
   *
   * Absent it shares `storage`. Production passes a separate file so a corrupt state
   * file cannot resurrect a revoked device.
   */
  revocationStorage?: StorageAdapter;
  /** How much the machine underneath is trusted. Portable sessions pass `foreign`. */
  hostPosture?: HostPosture;
}

export class VesperRuntime {
  readonly config: VesperConfig;
  readonly log: Logger;
  readonly storage: StorageAdapter;
  readonly memory: MemoryStore;
  readonly knowledge: KnowledgeIndex;
  readonly workspaces: WorkspaceManager;
  readonly events: EventBus;
  readonly journal: EventJournal;
  readonly taskExecutors: TaskExecutorRegistry;
  readonly taskScheduler: TaskScheduler;
  readonly autonomy: AutonomyGovernor;
  readonly checkpoints: CheckpointStore;
  readonly corrections: CorrectionStore;
  /** Hardware probes consulted by first boot. Placeholders until the target PC exists. */
  readonly probes: HardwareProbeRegistry;
  readonly correctionProducer: OptimizerCorrectionProducer;
  readonly notifications: NotificationHub;
  readonly hardware: SimulatedHardware;
  readonly optimizer: OptimizerAdapter;
  readonly obs: ObsClient;
  readonly deviceIdentity: DeviceIdentity;
  readonly devices: DeviceRegistry;
  readonly taskQueue: TaskQueue;
  readonly hostPosture: HostPosture;
  readonly tools: ToolRegistry;
  readonly models: ModelRouter;
  readonly agent: Agent;
  readonly confirmations: Map<string, PendingConfirmation>;
  readonly instanceId = createId("runtime");
  readonly background: BackgroundRuntime;
  readonly readiness: ReadinessMonitor;
  readonly voice: VoiceModule;
  readonly voiceSession: VoiceSession;
  readonly scheduler: IdleScheduler;
  readonly benchmark: BenchmarkHarness;
  capability: CapabilityProfile | null = null;
  firstBootReport: FirstBootReport | null = null;
  private discoveryPromise: Promise<void> | null = null;
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
      journal: EventJournal;
      taskExecutors: TaskExecutorRegistry;
      taskScheduler: TaskScheduler;
      autonomy: AutonomyGovernor;
      checkpoints: CheckpointStore;
      corrections: CorrectionStore;
      probes: HardwareProbeRegistry;
      readiness: ReadinessMonitor;
      correctionProducer: OptimizerCorrectionProducer;
      notifications: NotificationHub;
      hardware: SimulatedHardware;
      optimizer: OptimizerAdapter;
      obs: ObsClient;
      deviceIdentity: DeviceIdentity;
      devices: DeviceRegistry;
      taskQueue: TaskQueue;
      hostPosture: HostPosture;
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
    this.journal = parts.journal;
    this.taskExecutors = parts.taskExecutors;
    this.taskScheduler = parts.taskScheduler;
    this.autonomy = parts.autonomy;
    this.checkpoints = parts.checkpoints;
    this.corrections = parts.corrections;
    this.probes = parts.probes;
    this.readiness = parts.readiness;
    this.correctionProducer = parts.correctionProducer;
    this.notifications = parts.notifications;
    this.hardware = parts.hardware;
    this.optimizer = parts.optimizer;
    this.obs = parts.obs;
    this.deviceIdentity = parts.deviceIdentity;
    this.devices = parts.devices;
    this.taskQueue = parts.taskQueue;
    this.hostPosture = parts.hostPosture;
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
    const restoredEvents = await this.events.hydrate();
    // A journal never grows unbounded: prune day-partitions older than the retention
    // window before doing anything else that would consume storage bandwidth.
    await this.journal.purgeOldPartitions();
    if (restoredEvents) {
      this.log.info("lifecycle", "Restored the event log", { events: restoredEvents });
    }
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
    if (this.config.obs.enabled) {
      // Fire and forget: OBS being down must never delay or fail startup.
      void this.obs.connect().then((status) => {
        this.log.info("event", "OBS connection attempt finished", {
          connected: status.connected,
          observed: status.observed,
        });
      });
    }
    if (!this.skipDiscovery) {
      this.discoveryPromise = this.discoverInBackground();
    } else {
      // Discovery was skipped, so nothing else in this run is going to probe backends
      // or mark the manifest ready. Mark them settled honestly now — degraded on the
      // manifest side is the right reading because refreshCapabilities happens below
      // regardless, but the backends component would otherwise stay pending forever
      // and hold the aggregate at CORE_READY on tests that never intended to.
      this.readiness.markComponent("backends", "degraded", "discovery skipped for this run");
    }

    // Knowledge reindex used to be AWAITED here, and directly blocked start() on the
    // largest optional subsystem the runtime has. On a fresh install with a full
    // knowledge root that could add tens of seconds to logon time, on the one OS
    // Vesper targets. It runs in the background now, and reports through the readiness
    // monitor when it finishes — the same shape the rest of the discovery path uses.
    void (async () => {
      try {
        await this.knowledge.reindex();
        this.readiness.markComponent("knowledge", "ready", "reindex complete");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.log.warn("lifecycle", "Knowledge reindex failed", { error: detail });
        // Degraded, not failed: the assistant is still useful without an index. FAILED
        // is reserved for a runtime that cannot serve any request.
        this.readiness.markComponent("knowledge", "degraded", `reindex failed: ${detail}`);
      }
    })();
    // Stored state that could not be read is a security event, not a footnote.
    //
    // The registry treats a corrupt file as "costs knowledge of peers, never the ability
    // to run locally", which is the right call for availability — but it held no logger,
    // so a *revocation* could disappear in silence and the device it named could enrol
    // again as a fresh `pending` peer awaiting approval. Losing a decision the owner made
    // about who may reach their machine has to be visible, whatever else is done about it.
    const storage = this.storage as unknown as { wasCorrupted?: () => boolean };
    if (typeof storage.wasCorrupted === "function") {
      if (storage.wasCorrupted()) {
        this.log.error("lifecycle", "Stored state was unreadable and has been reset", {});
        this.events.emit({
          type: "security.state_unreadable",
          title: "Stored state could not be read and was reset",
          detail:
            "Device trust, revocations, pending confirmations and memories are restored from that file. " +
            "Anything it held is gone: check the device list, because a revoked device can enrol again as pending.",
          severity: "error",
        });
        this.notifications.push({
          title: "Vesper's saved state could not be read",
          body: "Device trust and revocations may have been lost. Review your device list before approving anything.",
          kind: "error",
        });
      }
    }

    // A grant table that names a forbidden power would hand remote devices exactly what
    // the forbidden list exists to withhold. Checked at startup, not only in tests: the
    // tables are edited by hand and this is the assertion that catches a bad edit on a
    // real machine rather than in CI.
    if (!grantsRespectForbiddenPowers()) {
      this.log.error("permission", "A capability grant names a forbidden remote power", {});
      this.events.emit({
        type: "security.grant_table_invalid",
        title: "Capability grants name a forbidden remote power",
        detail:
          "Remote capability grants overlap the forbidden-powers list. Remote requests are refused until this is corrected.",
        severity: "error",
      });
    }

    // Record what this device can actually do. Until this runs, the registry holds a
    // device with no manifest, and routing correctly refuses to send it work — which
    // looks exactly like a machine that cannot do anything.
    const manifest = await this.refreshCapabilities();
    this.readiness.markComponent(
      "manifest",
      manifest ? "ready" : "degraded",
      manifest ? "refreshed at start" : "refresh returned null; using previous manifest",
    );

    // Core is up. Deterministic intents, tools, memory, permissions and the manifest
    // are all live. Optional subsystems (model probes, knowledge index) are still
    // catching up — the monitor advances to READY or DEGRADED when they answer.
    this.readiness.advanceTo("CORE_READY");
    return this.capability;
  }

  /**
   * Re-probe this device and store the result in the registry.
   *
   * Called at startup and again once backend discovery finishes, because a capability
   * that depends on a reachable backend is not knowable before that backend answers.
   * Never fatal: a device that cannot describe itself must still run locally.
   */
  async refreshCapabilities(): Promise<CapabilityManifest | null> {
    try {
      const manifest = await discoverCapabilities({
        deviceId: this.deviceIdentity.deviceId,
        probes: buildDiscoveryProbes({
          models: this.models,
          voice: this.voice,
          optimizer: this.optimizer,
          obs: this.obs,
          tools: this.tools,
          hostPosture: this.hostPosture,
        }),
      });
      await this.devices.setCapabilities(this.deviceIdentity.deviceId, manifest);
      return manifest;
    } catch (error) {
      this.log.warn("lifecycle", "Could not build this device's capability manifest", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async discoverInBackground() {
    try {
      this.firstBootReport = await runFirstBootAutomation(this.config, this.log, {
        storage: this.storage,
        probes: this.probes,
      });
      this.capability = this.firstBootReport.profile;
      await this.models.probeAll();
      const anyLocal = this.models.status().available.some((p) => p.available && p.kind === "local");
      this.readiness.markComponent(
        "backends",
        anyLocal ? "ready" : "degraded",
        anyLocal ? "at least one local backend answered" : "no local backend answered",
      );
      // The manifest built at startup predates this probe, so redo it now that the
      // backends have actually answered.
      await this.refreshCapabilities();
    } catch (error) {
      this.log.error("lifecycle", "First-boot discovery failed; continuing degraded", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Await the background discovery pass and return its report, or null if discovery
   * was skipped or has not started yet. Callers who need the report for a one-shot
   * command (--first-boot-report, --diagnostics with a --wait flag) use this instead
   * of racing the background job.
   */
  async waitForFirstBoot(): Promise<FirstBootReport | null> {
    if (this.discoveryPromise) {
      try {
        await this.discoveryPromise;
      } catch {
        // discoverInBackground already logged the error and left the report null.
      }
    }
    return this.firstBootReport;
  }

  async stop() {
    this.readiness.advanceTo("STOPPING");
    this.started = false;
    this.memory.clearSession();
    this.scheduler.stop();
    // Stop the TASK scheduler too. Until an executor could do real work this was
    // harmless; now that one can invoke tools, an in-flight executor needs the abort
    // signal on the way down rather than being left running against a runtime that has
    // released its subsystems.
    this.taskScheduler.stop();
    await this.persistConfirmations();
    this.obs.disconnect();
    await this.events.flush();
    await this.background.stop();
    this.readiness.advanceTo("STOPPED");
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
      /** Who is driving this turn. Absent means the person at this machine. */
      origin?: RequestOrigin;
    },
  ): Promise<AgentTurn> {
    if (!this.started) await this.start();
    let completed: AgentTurn | null = null;
    try {
      completed = await this.agent.handle(text, options);
      // Persisting the queue is bookkeeping that happens *after* the turn is done. A
      // failure here used to discard the whole successful turn and replace it with one
      // asserting `could_not_access` and no tool calls — the turn had run, its side
      // effects had landed, and the account of it was thrown away.
      await this.persistConfirmations();
      return completed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("error", "Agent turn failed", { error: message });
      await this.recordLastError(message, text);

      // Report what actually happened, not what would be convenient.
      //
      // This used to synthesise a turn with no tool calls and no pending confirmations,
      // which is a false claim in the direction nobody checks: a memory write that had
      // already landed, a workspace the owner's next turn would run in, an app that had
      // been launched — all absent from the only structured account of the turn, while
      // the turn asserted `could_not_access`.
      //
      // The confirmations are the sharper half. The queue is live and the entry is still
      // approvable, but the console only walks `turn.pendingConfirmations`, so a
      // confirmation raised during a failed turn was invisible to the person who is
      // supposed to answer it — and could not be declined.
      // Three cases, in order of how much is known: the turn finished and only the
      // bookkeeping after it failed; the turn threw partway and carried its records out;
      // or something failed before any record existed.
      const ran = completed?.toolCalls ?? (error instanceof TurnFailure ? error.toolCalls : []);
      if (completed) {
        return {
          ...completed,
          reply:
            `${completed.reply}\n\n[I could not save my record of this turn: ${message}. ` +
            `What is described above did happen.]`,
          epistemic: completed.epistemic.includes("could_not_access")
            ? completed.epistemic
            : [...completed.epistemic, "could_not_access"],
          pendingConfirmations: [...this.confirmations.values()],
        };
      }
      const queued = [...this.confirmations.values()];
      const epistemic: EpistemicTag[] = ["could_not_access"];
      for (const record of ran) {
        const tag = record.result?.epistemic;
        if (tag && !epistemic.includes(tag)) epistemic.push(tag);
      }
      const ranNote =
        ran.length > 0
          ? ` ${ran.length} step${ran.length === 1 ? "" : "s"} had already run before it failed: ` +
            `${ran.map((record) => record.toolName).join(", ")}.`
          : "";
      const queuedNote =
        queued.length > 0
          ? ` ${queued.length} action${queued.length === 1 ? " is" : "s are"} still waiting for your confirmation.`
          : "";
      return {
        id: createId("turn"),
        userText: text,
        reply: `I hit an internal error and recovered: ${message}.${ranNote}${queuedNote}`,
        epistemic,
        toolCalls: ran,
        pendingConfirmations: queued,
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
      knowledge: {
        sources: this.knowledge.listSources().length,
        embeddingProvider: this.knowledge.embeddingStatus().providerId,
        indexedWith: this.knowledge.embeddingStatus().indexedWith,
        detail: this.knowledge.embeddingStatus().detail,
      },
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
      knowledge: {
        sources: this.knowledge.listSources().length,
        embeddingProvider: this.knowledge.embeddingStatus().providerId,
        indexedWith: this.knowledge.embeddingStatus().indexedWith,
        detail: this.knowledge.embeddingStatus().detail,
      },
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
        // An unreadable or absent origin is treated as remote-unknown, not as local.
        // A restored confirmation is the one case where we cannot ask who queued it,
        // and guessing "local" there would hand a persisted record local authority.
        requestedBy: readRequestedBy(rec.requestedBy),
        preview: coercePreview(rec.preview),
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
  // Declare where Vesper's own files live before anything can be asked to read them.
  // Every directory Vesper owns, not just the data one. paths.ts puts config, logs and
  // models in *sibling* directories of data, so registering data alone left the config
  // file and the audit log readable by an autonomous fs_read — the audit log being the
  // record of what Vesper has been asked to do.
  registerOwnPaths([
    options.dirs?.data,
    options.dirs?.config,
    options.dirs?.logs,
    options.dirs?.models,
    options.dirs?.root,
    // The siblings, derived when they were not given.
    //
    // `resolveVesperDirs` nests `data` inside the Vesper root and puts config, logs and
    // models beside it, so a caller passing only `{ data }` — which every embedder and
    // the production host did until this campaign — left the config file and the audit
    // log as ordinary readable documents.
    //
    // The *names* are derived, not the parent itself. Registering `dirname(data)` would
    // be simpler and wrong: a root that legitimately contains the user's notes next to
    // `data/` would stop being readable at all. paths.ts owns this layout, so these are
    // exactly the directories it creates and nothing else.
    ...(options.dirs?.data && !options.dirs?.root
      ? ["config", "logs", "models"].map((name) => join(dirname(options.dirs!.data), name))
      : []),
  ]);

  // Device identity, the registry, and the task queue are constructed before anything
  // that might want to know which machine this is.
  const identityIo = options.dirs
    ? undefined
    : {
        // No dirs means no filesystem: keep the key in the storage adapter so tests and
        // in-memory runs never leave a private key on disk.
        read: async (key: string) => {
          const value = await storage.get(key);
          if (typeof value !== "string") {
            throw Object.assign(new Error("not found"), { code: "ENOENT" });
          }
          return value;
        },
        write: async (key: string, contents: string) => {
          await storage.set(key, contents);
        },
      };
  const loadedIdentity = await loadDeviceIdentity({
    dirs: options.dirs ?? { data: "identity" },
    vesperVersion: VESPER_VERSION,
    io: identityIo,
  });
  const deviceIdentity = loadedIdentity.identity;
  const hostPosture: HostPosture = options.hostPosture ?? "owned";
  const devices = new DeviceRegistry({
    storage,
    revocations: options.revocationStorage,
    self: deviceIdentity.publicIdentity(),
  });
  const taskQueue = new TaskQueue({ storage });
  // Task lifecycle → event bus. Wired after the bus is constructed further down;
  // the callback captures `events` by reference so the bus need not exist yet.
  let eventBusRef: { emit: (e: Omit<import("./types.ts").VesperEvent, "id" | "at"> & { at?: string }) => unknown } | null = null;
  taskQueue.setOnLifecycle((event) => {
    if (!eventBusRef) return;
    const shortId = event.task.id.slice(-8);
    const title = (() => {
      switch (event.kind) {
        case "created":
          return `Task queued: ${event.task.description}`;
        case "assigned":
          return `Task assigned to ${event.deviceId}: ${event.task.description}`;
        case "blocked":
          return `Task blocked (${event.reason}): ${event.task.description}`;
        case "requeued":
          return `Task requeued (${event.reason}): ${event.task.description}`;
        case "started":
          return `Task started (attempt ${event.task.retry.attempts}/${event.task.retry.maxAttempts}): ${event.task.description}`;
        case "completed":
          return `Task done: ${event.task.description}`;
        case "failed":
          return event.final
            ? `Task failed after ${event.task.retry.attempts} attempt(s): ${event.task.description}`
            : `Task failed, will retry: ${event.task.description}`;
        case "cancelled":
          return `Task cancelled: ${event.task.description}`;
      }
    })();
    const severity: import("./types.ts").VesperEvent["severity"] =
      event.kind === "failed" && event.final ? "warn" : "info";
    eventBusRef.emit({
      type: `task.${event.kind}`,
      title,
      severity,
      data: { taskId: event.task.id, shortId } as import("./types.ts").JsonObject,
    });
  });

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
  // OBS is asked directly when enabled, so recording state becomes observed rather than
  // inferred from process presence. Its state changes are emitted as events, which is
  // what lets `explain_change` say "OBS started recording 40s before".
  const obs = createObsClient({
    url: config.obs.url,
    password: config.obs.password,
    timeoutMs: config.obs.timeoutMs,
    onStateChange: (change) => {
      events.emit({
        type: "obs.state",
        title: change.detail,
        severity: "info",
        data: { kind: change.kind, active: change.active },
      });
    },
  });
  const workspaces = new WorkspaceManager(config, { storage, log });
  // Load-on-start rather than lazy-load per current(). current() is called on every
  // tool decision and every reply; a synchronous cache miss surfaced only by an await
  // there would surprise every caller.
  const workspaceLoad = await workspaces.load();
  // The event log is persisted so correlation still works after a restart or crash,
  // which is exactly when 'what happened just before this?' matters most.
  const events = new EventBus(log, 500, storage);
  const journal = new EventJournal({
    storage,
    log,
    retentionDays: config.agent.journalRetentionDays,
    maxPerDay: config.agent.journalMaxPerDay,
    onWriteFailure: (error) => {
      // Losing history is not availability loss, but the mission's "loss must be loud"
      // rule still applies. Emit once per session; the flag inside EventJournal already
      // debounces the callback, so we do not need to debounce here.
      events.emit({
        type: "security.journal_write_failed",
        title: "Vesper could not write to its durable event journal",
        detail: error instanceof Error ? error.message : String(error),
        severity: "warn",
        retention: "durable",
        provenance: { author: "subsystem", source: "event-journal" },
      });
    },
    onCorruptPartition: (key, error) => {
      events.emit({
        type: "security.journal_partition_corrupt",
        title: `Corrupt event-journal partition: ${key}`,
        detail: error instanceof Error ? error.message : String(error),
        severity: "warn",
        retention: "durable",
        provenance: { author: "subsystem", source: "event-journal" },
      });
    },
  });
  events.setJournal(journal);
  // Task lifecycle callback (installed above) now has a real bus to publish through.
  eventBusRef = events;
  // Two branches of workspace load must be visible, not silent, per round-2's
  // "loss must be loud" rule: a stored id the config no longer knows about (a workspace
  // was removed and the user is now silently reset to the default), and a store that
  // could not be read at all. Both are informational for a lifecycle event; only the
  // unreadable case gets an error-level notification because the user's saved choice
  // was lost.
  if (workspaceLoad.kind === "unknown_id") {
    events.emit({
      type: "workspace.reset_to_default",
      title: `Workspace '${workspaceLoad.storedId}' is no longer configured; reset to ${workspaces.current().name}`,
      severity: "info",
    });
  } else if (workspaceLoad.kind === "unreadable") {
    events.emit({
      type: "workspace.state_unreadable",
      title: "Stored workspace choice was unreadable; using the configured default",
      detail: workspaceLoad.error,
      severity: "warn",
    });
  }
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
        sttModel: config.voice.sttModel,
        ttsModel: config.voice.ttsModel,
        sttLanguage: config.voice.sttLanguage,
        sttArgs: config.voice.sttArgs,
        ttsArgs: config.voice.ttsArgs,
      })
    : createDisabledVoice();
  const voiceSession = createVoiceSession(voice);
  const background = createBackgroundRuntime({
    events,
    log,
    startOnLogin: config.windows.startOnLogin,
  });
  const taskExecutors = new TaskExecutorRegistry();
  registerBuiltinExecutors(taskExecutors);
  const taskScheduler = new TaskScheduler({
    taskQueue,
    registry: taskExecutors,
    events,
    log,
    deviceId: deviceIdentity.deviceId,
    devices: () => devices.list(),
    enabled: config.agent.driveTasksOnIdle,
    maxPerTick: config.agent.tasksPerTick,
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
      // The task scheduler runs BELOW the idle tick's own gating (gaming throttle,
      // background paused). Its .tick() is a no-op when disabled — the flag guards
      // the whole feature so a runtime with no executors registered stays silent.
      try {
        await taskScheduler.tick();
      } catch (error) {
        // A scheduler failure must not crash the idle loop. The scheduler emits its
        // own events for executor errors; a throw from tick() itself is unexpected.
        log.warn("lifecycle", "task scheduler tick threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
  const gate = createPermissionGate(config.permissions, log);
  const confirmations = new Map<string, PendingConfirmation>();
  const tools = new ToolRegistry(gate, log, confirmations, async (id) =>
    (await devices.get(id))?.trust ?? "unknown",
  );
  const autonomy = new AutonomyGovernor({
    policy: defaultAutonomyPolicy(),
    events,
    log,
  });
  tools.setAutonomyGovernor(autonomy);
  // Register the tool-running executor HERE and not beside `registerBuiltinExecutors`
  // above: `tools` and `autonomy` do not exist yet at that point, and an executor that
  // could not reach the authorization chain would have to reach around it. The
  // scheduler resolves a task's kind at execution time, not at construction, so a late
  // registration is picked up normally.
  taskExecutors.register(
    TOOL_CALL_TASK_KIND,
    createToolCallExecutor({
      tools,
      workspaceId: () => workspaces.current().id,
    }),
  );
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

  // Vesper-owned rollback: snapshots kept in `rollback.checkpoints` with per-record TTL.
  const checkpoints = new CheckpointStore({ storage, log, events });
  // Decision history: what Vesper expected, what the evidence said. Learning signal
  // only — nothing here can change a permission, a trust state or an autonomy level.
  const corrections = new CorrectionStore({ storage, log, events });
  // The probe registry first boot consults. Only the honest placeholders are registered
  // here; a Windows-only module registers real probes on the target PC, and they outrank
  // these because the placeholders are marked `fallback`.
  const probes = new HardwareProbeRegistry();
  registerPlaceholderProbes(probes);
  // The producer sits between the optimizer adapter and the store: Vesper records what
  // it expected when it asked, and files the comparison when an observation arrives.
  const correctionProducer = new OptimizerCorrectionProducer({ optimizer, corrections });
  // Register reversers for the write paths that participate. Each reverser is a small
  // shim over the underlying store; the checkpoint layer never knows the store's
  // internals, only how to ask it to restore a value it once had.
  checkpoints.registerReverser("memory_remember", {
    async verify(record) {
      // An absent post-image means the write never completed its verify() step — the
      // process crashed between snapshot and verify, or apply threw. We do NOT know
      // what the state should look like, so we cannot tell whether it has drifted.
      // The safe reading of "unknown" is REFUSE, not "no drift": treating an unknown
      // post-image as a match would let a rollback overwrite whatever the user did
      // since. (Attack finding: drift detection was a no-op on every un-verified
      // checkpoint.)
      const after = record.after as { value?: string; id?: string } | undefined;
      if (!after || typeof after.value !== "string") return false;
      const results = await memory.search(record.target, { workspaceId: record.workspaceId, scope: "all" });
      const current = results.find((entry) => entry.key === record.target);
      if (!current) return false;
      // Anchor on entry IDENTITY where we have it, not just value equality. A user who
      // forgot this memory and re-created it with the same text has a different entry;
      // rolling back would destroy their new one while the value check happily passed.
      if (typeof after.id === "string") return current.id === after.id;
      return current.value === after.value;
    },
    async restore(record) {
      if (record.absentBefore) {
        // The key did not exist before; forget the entry we created. `forget` returns
        // false when nothing matched — reporting success then would claim a reversal
        // that did not happen, which the mission's honesty rule forbids.
        const forgotten = await memory.forget(record.target, { workspaceId: record.workspaceId });
        if (!forgotten) {
          throw new Error(`Nothing to forget for '${record.target}'; the memory was already gone.`);
        }
        return;
      }
      const before = record.before as
        | { key?: unknown; category?: unknown; value?: unknown; workspaceId?: unknown }
        | null;
      if (!before || typeof before !== "object") {
        throw new Error("memory_remember checkpoint has no `before` value");
      }
      // Validate the pre-image before feeding it back into the store. A hostile or
      // corrupted `rollback.checkpoints` blob could otherwise plant an arbitrary
      // key/value pair and have restore() write it as if Vesper had recorded it.
      // The key must match the checkpoint's own target — a rollback restores the
      // thing it snapshotted, nothing else.
      if (typeof before.key !== "string" || typeof before.value !== "string" || typeof before.category !== "string") {
        throw new Error("memory_remember checkpoint `before` is malformed; refusing to restore");
      }
      if (before.key !== record.target) {
        throw new Error(
          `memory_remember checkpoint targets '${record.target}' but its pre-image names '${before.key}'; refusing to restore`,
        );
      }
      if (!(MEMORY_CATEGORIES as readonly string[]).includes(before.category)) {
        throw new Error(`memory_remember checkpoint has an unknown category '${before.category}'; refusing to restore`);
      }
      const workspaceId = typeof before.workspaceId === "string" ? before.workspaceId : undefined;
      await memory.remember({
        category: before.category as never,
        key: before.key,
        value: before.value,
        workspaceId,
        source: "agent",
        provenance: { origin: "agent", kind: "inferred" },
      });
    },
  });
  checkpoints.registerReverser("workspace_switch", {
    async verify(record) {
      // Same rule as memory_remember: an absent post-image means we cannot know
      // whether the state drifted, so refuse rather than assume it matches.
      const after = typeof record.after === "string" ? record.after : null;
      if (!after) return false;
      return workspaces.current().id === after;
    },
    async restore(record) {
      const before = typeof record.before === "string" ? record.before : null;
      if (!before) throw new Error("workspace_switch checkpoint has no `before` value");
      const restored = workspaces.switchTo(before);
      if (!restored) throw new Error(`Cannot restore workspace '${before}': not configured`);
    },
  });

  checkpoints.registerReverser(FS_WRITE_CHECKPOINT_TOOL, {
    async verify(record) {
      // Same rule as the other two reversers: an absent post-image means we never
      // learned what the write produced, so we cannot tell a match from drift. Refuse.
      const after = typeof record.after === "string" ? record.after : null;
      if (after === null) return false;
      // Read through the SAME contained read path a tool would use, against the roots
      // in force NOW. If the file has left the approved set since the write, the answer
      // to "has it drifted" is not "no" — it is "we may no longer look", which is a
      // refusal either way.
      const current = await readApprovedExact(config.approvedRoots, record.target);
      // `absentBefore` does not change the drift question, only what restoring means.
      // Either way the file must still hold exactly what Vesper wrote: if it does not,
      // someone has edited it since, and a rollback would throw their work away —
      // whether by overwriting it or by deleting the file outright.
      return current.ok && current.present && current.content === after;
    },
    async restore(record) {
      // Everything below re-derives authority from the CURRENT configuration, because
      // the pre-image arrives from `rollback.checkpoints` in the shared state file and
      // is therefore persisted, attacker-influenceable data.
      //
      // Honest labelling: this containment is DEFENCE IN DEPTH, not the load-bearing
      // check. `CheckpointStore.rollbackInner` always calls verify() first, and verify()
      // reads through `readApprovedExact` — so a target outside the approved roots is
      // already refused as drift before restore() is ever entered. Mutation confirms it:
      // replacing both branches below with a raw `writeFile`/`unlink` fails no test.
      // It is kept because verify() and restore() read the roots at two different
      // moments and the two are not one atomic act, and because a future reverser change
      // that relaxed verify() would otherwise silently turn this into an
      // arbitrary-file-write primitive. Recorded as unexercised rather than presented as
      // proven.
      if (typeof record.target !== "string" || record.target.length === 0) {
        throw new Error("fs_write checkpoint has no target; refusing to restore");
      }
      if (record.absentBefore) {
        const removed = await deleteApproved(config.approvedRoots, record.target);
        if (!removed.ok) {
          // `restore` must THROW on failure — a promise that merely resolves is taken as
          // success and the checkpoint is stamped rolledBackAt, claiming a reversal that
          // did not happen.
          throw new Error(`Could not remove the file Vesper created: ${removed.summary}`);
        }
        return;
      }
      const before = record.before;
      if (typeof before !== "string") {
        throw new Error("fs_write checkpoint `before` is not text; refusing to restore");
      }
      // Restore through `writeApproved` rather than through the filesystem directly, so
      // the reversal passes every containment check the original write passed:
      // traversal, dangerous roots, Vesper's own paths, approved roots, symlink refusal
      // at the final component, and the hard-link refusal.
      //
      // No checkpointStore is passed. A rollback is not itself a checkpointable write —
      // recording one would let rollbacks of rollbacks accumulate, and the record being
      // reversed already holds the state needed to describe what happened.
      const restored = await writeApproved(config.approvedRoots, record.target, before);
      if (!restored.ok) {
        throw new Error(`Could not restore the previous contents: ${restored.summary}`);
      }
    },
  });

  registerBuiltinTools({
    checkpointStore: checkpoints,
    corrections,
    correctionProducer,
    registry: tools,
    obs,
    deviceRegistry: devices,
    tasks: taskQueue,
    selfDeviceId: deviceIdentity.deviceId,
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
    journal,
    governor: autonomy,
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
    // Catch-up sources. Outstanding work comes from the queue rather than from event
    // counts, and the journal lets the digest say honestly how far back it can see.
    tasks: taskQueue,
    journal,
    corrections,
    history,
    maxToolIterations: config.agent.maxToolIterations,
    deviceId: deviceIdentity.deviceId,
    deviceTrust: async (id: string) => (await devices.get(id))?.trust ?? "unknown",
    selfManifest: async () =>
      (await devices.get(deviceIdentity.deviceId))?.capabilities ?? null,
    describeNow: async () => {
      const [records, tasks] = await Promise.all([devices.list(), taskQueue.list()]);
      const self =
        records.find((record) => record.identity.deviceId === deviceIdentity.deviceId) ?? records[0];
      if (!self) return "";
      return renderNow(
        buildNow({
          self,
          hostPosture,
          workspace: workspaces.current().name,
          devices: records,
          tasks,
          models: {
            active: models.status().active,
            available: models.status().available.map((item) => ({
              id: item.id,
              available: item.available,
            })),
          },
          voice: voice.status().available ? "available" : "unavailable",
          optimizer: config.optimizer.mode,
        }),
      );
    },
  });
  const readiness = new ReadinessMonitor({
    events,
    log,
    components: [
      { id: "manifest", description: "capability manifest", optional: false, detail: "not yet refreshed" },
      { id: "backends", description: "local model backends", optional: config.models.roles !== undefined, detail: "not yet probed" },
      { id: "knowledge", description: "knowledge index", optional: true, detail: "not yet indexed" },
    ],
  });
  const runtime = new VesperRuntime(config, {
    log,
    probes,
    readiness,
    storage,
    memory,
    knowledge,
    workspaces,
    events,
    journal,
    taskExecutors,
    taskScheduler,
    autonomy,
    checkpoints,
    corrections,
    correctionProducer,
    notifications,
    hardware,
    optimizer,
    obs,
    deviceIdentity,
    devices,
    taskQueue,
    hostPosture,
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
    preferredBackend: null,
    models: [],
    telemetry: "mocked_simulated",
    audio: "documented_not_implemented",
    windowsIntegration: "mocked_simulated",
    optimizer: "mocked_simulated",
    voice: "documented_not_implemented",
    notes: [],
  };
}

/**
 * Read a persisted confirmation's origin without trusting the file.
 *
 * Absent or malformed means "we cannot tell", and the safe reading of that is *not*
 * "local". A record on disk is attacker-influenceable in a way a live in-process origin
 * is not, so an unreadable origin resolves to a remote device with no id — the most
 * restricted thing it could be.
 */
function readRequestedBy(value: unknown): { kind: "local" | "remote"; deviceId?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "remote" };
  }
  const record = value as { kind?: unknown; deviceId?: unknown };
  const kind = record.kind === "local" ? "local" : "remote";
  return {
    kind,
    deviceId: typeof record.deviceId === "string" ? record.deviceId : undefined,
  };
}
