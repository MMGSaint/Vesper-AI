import { sanitiseInline } from "../untrusted.ts";
import type { VesperConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import type { SimulatedHardware } from "../hardware/simulated.ts";
import type { KnowledgeIndex } from "../knowledge/rag.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { NotificationHub } from "../notifications.ts";
import type { OptimizerAdapter } from "../specialists/optimizer.ts";
import { explainPerformance, inspectWorkload } from "../specialists/context.ts";
import { gpuConsumers, groundedConclusions } from "../specialists/gaming.ts";
import type { ToolRegistry } from "./registry.ts";
import { correlateAround, explainCorrelations } from "../correlate.ts";
import type { ObsClient } from "../specialists/obs.ts";
import type { DeviceRegistry } from "../distributed/registry.ts";
import type { TaskQueue } from "../distributed/tasks.ts";
import type { DiagnosticReport, JsonObject, MemoryCategory, ToolSpec } from "../types.ts";
import type { WindowsHost } from "../windows/host.ts";
import type { WorkspaceManager } from "../workspaces.ts";
import type { VoiceModule } from "../voice/types.ts";
import type { VoiceSession } from "../voice/session.ts";
import type { BackgroundRuntime } from "../windows/runtime.ts";
import type { ModelRouter } from "../models/router.ts";
import type { IdleScheduler } from "../scheduler.ts";
import type { BenchmarkHarness } from "../models/benchmark.ts";
import type { CheckpointStore } from "../checkpoint.ts";
import { listApproved, readApproved, writeApproved } from "./filesystem.ts";
import { TOOL_CALL_TASK_KIND } from "../tool-executor.ts";
import { mcpBridgeStatus } from "../integrations/mcp.ts";
import { detectApprovedApps } from "../windows/apps.ts";
import { classifyDeviceIntent, resolveTarget } from "../distributed/intent.ts";

function str(args: JsonObject, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function spec(
  name: string,
  description: string,
  permission: ToolSpec["permission"],
  properties: ToolSpec["parameters"]["properties"],
  required: string[] = [],
): ToolSpec {
  return {
    name,
    description,
    permission,
    parameters: { type: "object", properties, required },
  };
}

export function registerBuiltinTools(input: {
  registry: ToolRegistry;
  config: VesperConfig;
  hardware: SimulatedHardware;
  windows: WindowsHost;
  memory: MemoryStore;
  knowledge: KnowledgeIndex;
  optimizer: OptimizerAdapter;
  workspaces: WorkspaceManager;
  events: EventBus;
  notifications: NotificationHub;
  obs?: ObsClient;
  deviceRegistry?: DeviceRegistry;
  tasks?: TaskQueue;
  selfDeviceId?: string;
  voice?: VoiceModule;
  voiceSession?: VoiceSession;
  background?: BackgroundRuntime;
  models?: ModelRouter;
  scheduler?: IdleScheduler;
  benchmark?: BenchmarkHarness;
  getDiagnostics?: () => Promise<DiagnosticReport>;
  checkpointStore?: CheckpointStore;
}) {
  const {
    checkpointStore,
    registry,
    config,
    hardware,
    windows,
    memory,
    knowledge,
    optimizer,
    workspaces,
    events,
    notifications,
    obs,
    deviceRegistry,
    tasks,
    selfDeviceId,
    voice,
    voiceSession,
    background,
    models,
    scheduler,
    benchmark,
    getDiagnostics,
  } = input;

  registry.register(
    spec("system_info", "Read the current hardware snapshot.", "read", {}),
    async () => {
      const snapshot = hardware.snapshot();
      return {
        ok: true,
        epistemic: "checked",
        summary: `${snapshot.mode} snapshot: ${snapshot.cpu.name}, ${snapshot.gpu?.name ?? "no GPU"}, ${snapshot.ram.usedGB}/${snapshot.ram.totalGB} GB RAM.`,
        data: snapshot as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("process_list", "List running processes from the host adapter.", "read", {}),
    async () => {
      const list = windows.listProcesses();
      return {
        ok: true,
        epistemic: "checked",
        summary: `${list.length} running processes.`,
        data: list as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("app_detect", "Detect approved applications on the host adapter.", "read", {}),
    async () => {
      const detected = detectApprovedApps(config.approvedApps, windows.listProcesses());
      const running = detected.filter((item) => item.running).map((item) => item.app.name);
      return {
        ok: true,
        epistemic: "checked",
        summary: running.length
          ? `Approved apps running: ${running.join(", ")}.`
          : "No approved applications are currently running.",
        data: detected.map((item) => ({
          id: item.app.id,
          running: item.running,
          launchable: item.launchable,
          detail: item.detail,
        })) as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec(
      "app_launch",
      "Launch an approved application.",
      "safe",
      { name: { type: "string", description: "Application name or alias" } },
      ["name"],
    ),
    async (args) => {
      const name = str(args, "name");
      const app = config.approvedApps.find(
        (item) =>
          item.id === name.toLowerCase() ||
          item.name.toLowerCase() === name.toLowerCase() ||
          item.aliases.some((alias) => alias.toLowerCase() === name.toLowerCase()),
      );
      if (!app) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary: `'${name}' is not an approved application.`,
        };
      }
      const result = windows.launch(app);
      if (result.ok) {
        events.emit({
          type: "application.started",
          title: `${app.name} launched`,
          severity: "info",
        });
        notifications.push({
          kind: "success",
          title: app.name,
          body: result.summary,
          cooldownKey: `launch:${app.id}`,
        });
      }
      return { ok: result.ok, epistemic: result.ok ? "changed" : "could_not_access", summary: result.summary };
    },
  );

  registry.register(
    spec(
      "app_close",
      "Close a running approved application.",
      "confirm",
      { name: { type: "string", description: "Application name" } },
      ["name"],
    ),
    async (args) => {
      const result = windows.close(str(args, "name"));
      if (result.ok) {
        events.emit({
          type: "application.stopped",
          title: `${str(args, "name")} closed`,
          severity: "info",
        });
      }
      return { ok: result.ok, epistemic: result.ok ? "changed" : "could_not_access", summary: result.summary };
    },
  );

  registry.register(
    spec(
      "notify",
      "Show a user notification.",
      "safe",
      {
        title: { type: "string" },
        body: { type: "string" },
      },
      ["title", "body"],
    ),
    async (args) => {
      // Screened and attributed. `kind: "system"` is the most authoritative class in the
      // hub and is reserved for Vesper's own machinery; a model-written notice is
      // `info`, authored `model`, with its text neutralised the way any other
      // model-chosen string bound for a durable record is.
      const title = sanitiseInline(str(args, "title"), 80);
      const body = sanitiseInline(str(args, "body"), 300);
      try {
        const sent = notifications.push({
          kind: "info",
          author: "model",
          title,
          body,
          cooldownKey: `notify:${title}`,
        });
        const host = windows.notify(title, body);
        return {
          ok: true,
          epistemic: "changed",
          summary: sent ? host.summary : "Notification suppressed by cooldown.",
        };
      } catch (error) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary: `Notification failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  );

  registry.register(
    spec(
      "memory_remember",
      "Store a persistent memory.",
      "safe",
      {
        key: { type: "string" },
        value: { type: "string" },
        category: {
          type: "string",
          enum: ["preference", "fact", "project", "workflow", "routine", "task", "config", "context", "session"],
        },
      },
      ["key", "value"],
    ),
    async (args, context) => {
      const category = (str(args, "category") || "fact") as MemoryCategory;
      const key = str(args, "key");
      const value = str(args, "value");

      // Storing over an existing key destroys what was there, and destroying a memory is
      // what memory_forget needs confirmation for. Leaving this at "safe" made that
      // confirmation decorative: writing an empty value to an existing key deleted it
      // outright, autonomously, and writing any other value replaced it just as
      // permanently. A new key is a genuinely additive act and stays autonomous; a
      // replacement has to go through the tier that governs destruction.
      const existing = (await memory.search(key, { workspaceId: context.workspaceId, scope: "all" }))
        .find((item) => item.key.toLowerCase() === key.toLowerCase());
      if (existing && existing.value !== value) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary:
            `'${key}' already holds a different value. Replacing a memory destroys what was there, ` +
            `so forget it first — which asks you before it does anything.`,
        };
      }

      // Pre-image capture, when a checkpoint store is attached. The store is optional
      // — a runtime without one gets exactly the previous behaviour. A checkpoint
      // makes an unattended remember reversible via the rollback_apply tool.
      const preImage = existing ? { key: existing.key, category: existing.category, value: existing.value, workspaceId: existing.workspaceId ?? null } : null;
      const checkpoint = checkpointStore
        ? await checkpointStore.snapshot({
            tool: "memory_remember",
            target: key,
            before: preImage as JsonObject | null,
            absentBefore: !existing,
            workspaceId: context.workspaceId,
          })
        : null;

      const entry = await memory.remember({
        category,
        key,
        value,
        workspaceId: context.workspaceId,
        source: "agent",
        // The assistant wrote this, and it does not know whether the user stated it.
        // `origin: "user-request", kind: "stated"` claimed both, so a fact the model
        // invented was indistinguishable in the record from one the user actually said —
        // and `attribute()` renders that difference back into the prompt on every later
        // turn, which is how an invented fact becomes a remembered one.
        provenance: { origin: "agent", kind: "inferred" },
      });
      if (checkpoint && checkpointStore) {
        // Record the post-image so a later rollback can detect drift.
        await checkpointStore.verify(checkpoint.id, {
          // `id` lets the reverser anchor drift detection on entry identity rather
          // than value equality — a user who re-created the same text after forgetting
          // it has a different entry, and a rollback must not destroy it.
          id: entry.id,
          key: entry.key,
          category: entry.category,
          value: entry.value,
          workspaceId: entry.workspaceId ?? null,
        } as JsonObject);
      }
      const memData: JsonObject = checkpoint
        ? { id: entry.id, key: entry.key, category: entry.category, checkpointId: checkpoint.id }
        : { id: entry.id, key: entry.key, category: entry.category };
      return { ok: true, epistemic: "changed", summary: `Remembered ${entry.key}.`, data: memData };
    },
  );

  registry.register(
    spec(
      "memory_search",
      "Search persistent memory.",
      "read",
      { query: { type: "string" } },
      ["query"],
    ),
    async (args, context) => {
      const hits = await memory.search(str(args, "query"), { workspaceId: context.workspaceId });
      return {
        ok: true,
        epistemic: "checked",
        summary: hits.length ? `Found ${hits.length} memories.` : "No matching memories.",
        data: hits as unknown as JsonObject,
      };
    },
  );
  registry.register(
    spec(
      "memory_summarize",
      "List everything Vesper remembers in the active workspace, grouped by category. Use this for open-ended questions like 'what do you know about me' — it returns a compact overview rather than searching for a literal token that stopword-filtering would strip.",
      "read",
      {},
    ),
    async (_args, context) => {
      const overview = await memory.summarize(context.workspaceId);
      return {
        ok: true,
        epistemic: "checked",
        summary: overview,
        // `summarize` already returns a formatted string; the data field carries the same
        // information as a compact array so a model can walk it.
        data: (await memory.search("", { workspaceId: context.workspaceId, limit: 50 })) as unknown as JsonObject,
      };
    },
  );



  registry.register(
    spec(
      "memory_forget",
      "Forget a stored memory by key or id.",
      "confirm",
      { key: { type: "string" } },
      ["key"],
    ),
    async (args, context) => {
      // Scoped: a workspace may only forget what it can see. See MemoryStore.forget.
      const ok = await memory.forget(str(args, "key"), { workspaceId: context.workspaceId });
      return {
        ok,
        epistemic: ok ? "changed" : "could_not_access",
        summary: ok ? `Forgot '${str(args, "key")}'.` : `No memory named '${str(args, "key")}'.`,
      };
    },
  );

  registry.register(
    spec(
      "workspace_switch",
      "Switch the active Vesper workspace.",
      "safe",
      { name: { type: "string" } },
      ["name"],
    ),
    async (args) => {
      // CHECKPOINT before APPLY — the documented order in checkpoint.ts. Capturing
      // after the switch left a window where the change had landed but nothing could
      // reverse it: if snapshot() threw, the workspace had already moved with no
      // pre-image recorded. Resolve the target first (without switching), snapshot,
      // then apply.
      const previous = workspaces.current();
      const target = workspaces.get(str(args, "name")) ?? workspaces.list().find(
        (w) => w.name.toLowerCase() === str(args, "name").toLowerCase(),
      );
      if (!target) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary: `Unknown workspace '${str(args, "name")}'.`,
        };
      }
      const checkpoint = checkpointStore
        ? await checkpointStore.snapshot({
            tool: "workspace_switch",
            target: target.id,
            before: previous.id,
            absentBefore: false,
          })
        : null;
      const ws = workspaces.switchTo(str(args, "name"));
      if (!ws) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary: `Unknown workspace '${str(args, "name")}'.`,
        };
      }
      if (checkpoint && checkpointStore) {
        await checkpointStore.verify(checkpoint.id, ws.id);
      }
      events.emit({
        type: "workspace.switch",
        title: `Workspace ${ws.name}`,
        severity: "info",
        workspaceId: ws.id,
      });
      const wsData: JsonObject = checkpoint
        ? { ...(ws as unknown as JsonObject), checkpointId: checkpoint.id }
        : (ws as unknown as JsonObject);
      return { ok: true, epistemic: "changed", summary: `Switched to ${ws.name}.`, data: wsData };
    },
  );

  // Rollback tools: view the recent checkpoints and reverse one by id.
  if (checkpointStore) {
    registry.register(
      spec(
        "rollback_list",
        "List recent Vesper-owned checkpoints that could be reversed.",
        "read",
        { limit: { type: "number", description: "Max records to return" } },
      ),
      async (args) => {
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20;
        const records = await checkpointStore.list({ limit });
        return {
          ok: true,
          epistemic: "checked",
          summary: records.length
            ? records
                .map((r) => `${r.id.slice(-8)} ${r.tool} on '${r.target}' at ${r.at}`)
                .join("; ")
            : "No checkpoints available for rollback.",
          data: { checkpoints: records } as unknown as JsonObject,
        };
      },
    );

    registry.register(
      spec(
        "rollback_apply",
        "Reverse a Vesper-owned change identified by checkpoint id.",
        "confirm",
        { id: { type: "string", description: "The checkpoint id to reverse" } },
        ["id"],
      ),
      async (args) => {
        const id = str(args, "id");
        const result = await checkpointStore.rollback(id);
        if (result.applied) {
          return {
            ok: true,
            epistemic: "changed",
            summary: `Rolled back ${result.record.tool} on '${result.record.target}'.`,
            data: { checkpointId: result.record.id, tool: result.record.tool, target: result.record.target } as JsonObject,
          };
        }
        return {
          ok: false,
          epistemic: "could_not_access",
          summary: `Rollback refused: ${result.reason}`,
        };
      },
    );
  }

  registry.register(
    spec(
      "knowledge_search",
      "Search approved local knowledge sources.",
      "read",
      { query: { type: "string" } },
      ["query"],
    ),
    async (args, context) => {
      const hits = knowledge.search(str(args, "query"), { workspaceId: context.workspaceId });
      return {
        ok: true,
        epistemic: "checked",
        summary: hits.length ? `Found ${hits.length} knowledge hits.` : "No matching knowledge.",
        data: hits as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("knowledge_reindex", "Reindex approved knowledge sources.", "safe", {}),
    async () => {
      const count = await knowledge.reindex();
      return {
        ok: true,
        epistemic: "changed",
        summary: `Reindexed ${count} documents from approved sources.`,
      };
    },
  );

  registry.register(
    spec(
      "knowledge_register",
      "Register an approved knowledge source. Roots must stay inside approved directories.",
      "confirm",
      {
        id: { type: "string" },
        name: { type: "string" },
        root: { type: "string" },
      },
      ["id", "name", "root"],
    ),
    async (args) => {
      const result = knowledge.registerSource({
        id: str(args, "id"),
        name: str(args, "name"),
        roots: [str(args, "root")],
        enabled: true,
      });
      return {
        ok: result.ok,
        epistemic: result.ok ? "changed" : "could_not_access",
        summary: result.summary,
      };
    },
  );

  registry.register(
    spec(
      "knowledge_remove",
      "Remove a knowledge source.",
      "confirm",
      { id: { type: "string" } },
      ["id"],
    ),
    async (args) => {
      const result = knowledge.removeSource(str(args, "id"));
      return {
        ok: result.ok,
        epistemic: result.ok ? "changed" : "could_not_access",
        summary: result.summary,
      };
    },
  );

  registry.register(
    spec(
      "fs_list",
      "List files inside an approved root.",
      "read",
      { path: { type: "string" } },
      ["path"],
    ),
    async (args) => listApproved(config.approvedRoots, str(args, "path")),
  );

  registry.register(
    spec(
      "fs_read",
      "Read a text file inside an approved root.",
      "read",
      { path: { type: "string" } },
      ["path"],
    ),
    async (args) => readApproved(config.approvedRoots, str(args, "path")),
  );

  registry.register(
    spec(
      "fs_write",
      "Write a text file inside an approved root.",
      "confirm",
      { path: { type: "string" }, content: { type: "string" } },
      ["path", "content"],
    ),
    async (args, context) =>
      writeApproved(config.approvedRoots, str(args, "path"), str(args, "content"), context.dryRun, {
        checkpointStore,
        workspaceId: context.workspaceId,
      }),
  );

  registry.register(
    spec("optimizer_status", "Query the PC optimizer adapter.", "read", {}),
    async () => {
      const status = await optimizer.getStatus();
      return {
        ok: status.available,
        epistemic: status.available ? "checked" : "could_not_access",
        summary: status.detail,
        data: status as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec(
      "optimizer_report",
      "Gather everything the PC optimizer currently reports: telemetry, active profile, performance state, its last action and result, and adapter health.",
      "read",
      {},
    ),
    async () => {
      // One call rather than six tools: the model needs the whole picture to say
      // something useful, and a wide tool surface makes a local model worse at picking.
      // Each field is settled independently so one unimplemented endpoint cannot blank
      // the rest of the report.
      const [health, telemetry, profile, performanceState, lastAction, lastResult] =
        await Promise.all([
          optimizer.getHealth().catch(() => null),
          optimizer.getTelemetry().catch(() => null),
          optimizer.getCurrentProfile().catch(() => null),
          optimizer.getPerformanceState().catch(() => null),
          optimizer.getLastAction().catch(() => null),
          optimizer.getOptimizationResult().catch(() => null),
        ]);

      if (!telemetry?.available) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary:
            "The optimizer did not return telemetry, so I have nothing authoritative about the machine from it. I am not guessing values.",
          data: { health, profile, performanceState } as unknown as JsonObject,
        };
      }

      const context = inspectWorkload(hardware, { optimizerActive: true });
      const explanation = explainPerformance({ bound: telemetry.bound, context });
      const parts = [
        `The optimizer reports the machine is ${telemetry.bound}-bound.`,
        explanation,
        profile ? `Active profile: ${profile}.` : "The optimizer did not name an active profile.",
        performanceState ? `Performance state: ${performanceState}.` : null,
        lastAction ? `Its last action was ${lastAction}${lastResult ? ` (${lastResult})` : ""}.` : "It reports no previous action.",
        ...telemetry.notes,
      ].filter(Boolean);

      return {
        ok: true,
        epistemic: "checked",
        summary: parts.join(" "),
        data: {
          telemetry,
          profile,
          performanceState,
          lastAction,
          lastResult,
          health,
          context,
        } as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("optimizer_analyze", "Request analysis from the optimizer adapter.", "read", {}),
    async () => {
      const analysis = await optimizer.analyze();
      const context = inspectWorkload(hardware, { optimizerActive: true });
      const explanation = explainPerformance({ bound: analysis.bound, context });
      return {
        ok: true,
        epistemic: "requested",
        summary: `${analysis.summary} ${explanation}`,
        data: { ...analysis, explanation, context } as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec(
      "optimizer_request",
      "Request an optimization or rollback through the adapter.",
      "confirm",
      {
        action: { type: "string", enum: ["optimize", "rollback"] },
        profile: { type: "string" },
      },
      ["action"],
    ),
    async (args) => {
      const action = str(args, "action");
      const result =
        action === "rollback"
          ? await optimizer.requestRollback()
          : await optimizer.requestOptimization({ profile: str(args, "profile") || undefined });
      if (result.accepted) {
        events.emit({
          type: "optimizer.state",
          title: `Optimizer ${action} confirmed`,
          severity: "info",
        });
      }
      return {
        ok: result.accepted,
        epistemic: result.accepted ? "requested" : "could_not_access",
        summary: result.summary,
      };
    },
  );

  registry.register(
    spec("context_status", "Read VRChat, OBS, and game context from the host adapter.", "read", {}),
    async () => {
      const context = inspectWorkload(hardware);
      const conclusions = groundedConclusions(hardware);
      const gpu = gpuConsumers(hardware);
      return {
        ok: true,
        epistemic: "checked",
        summary: context.notes.join(" "),
        data: { ...context, conclusions, gpu } as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("backend_status", "Probe local inference backends and model router status.", "read", {}),
    async () => {
      const status = models?.status() ?? { active: "auto", available: [] };
      return {
        ok: true,
        epistemic: "checked",
        summary: `Model router active=${status.active}. ${status.available
          .map((item) => `${item.id}:${item.available ? "up" : "down"}`)
          .join(", ")}`,
        data: status as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("benchmark_run", "Run the local model benchmark harness. Refuses to invent numbers.", "safe", {}),
    async () => {
      if (!benchmark) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary: "Benchmark harness is not attached.",
        };
      }
      const report = await benchmark.run();
      return {
        ok: true,
        epistemic: report.ran ? "checked" : "could_not_access",
        summary: report.reason,
        data: report as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("voice_status", "Read optional voice module status.", "read", {}),
    async () => {
      const status = voiceSession?.diagnostics() ?? voice?.status() ?? {
        enabled: false,
        stt: "none",
        tts: "none",
        available: false,
        pushToTalk: false,
        detail: "Voice module not attached.",
      };
      return {
        ok: true,
        epistemic: "checked",
        summary: "detail" in status ? status.detail : "Voice status.",
        data: status as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("diagnostics_report", "Generate a Vesper health and diagnostics report.", "read", {}),
    async () => {
      if (!getDiagnostics) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary: "Diagnostics collector is not attached.",
        };
      }
      const report = await getDiagnostics();
      return {
        ok: true,
        epistemic: "checked",
        summary: report.reportText,
        data: report as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("scheduler_status", "Read idle scheduler status.", "read", {}),
    async () => {
      const status = scheduler?.status() ?? {
        enabled: false,
        paused: false,
        lastTickAt: null,
        ticks: 0,
        skippedForGaming: 0,
        idleIntervalMs: 0,
        gamingThrottle: false,
      };
      return {
        ok: true,
        epistemic: "checked",
        summary: status.enabled
          ? `Idle scheduler on; interval ${status.idleIntervalMs}ms; skipped-for-gaming ${status.skippedForGaming}.`
          : "Idle scheduler is not running.",
        data: status as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("mcp_status", "Read optional MCP bridge status. MCP is never required at runtime.", "read", {}),
    async () => {
      // No config surface exists to attach a server, so this is not a user setting.
      const status = mcpBridgeStatus({ enabled: false, configurable: false });
      return {
        ok: true,
        epistemic: "checked",
        summary: status.detail,
        data: status as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("runtime_pause", "Pause background activity.", "confirm", {}),
    async () => {
      if (!background) {
        return { ok: false, epistemic: "could_not_access", summary: "Background runtime is not attached." };
      }
      await background.pause();
      return { ok: true, epistemic: "changed", summary: `Background state is ${background.state()}.` };
    },
  );

  registry.register(
    spec("runtime_resume", "Resume background activity.", "confirm", {}),
    async () => {
      if (!background) {
        return { ok: false, epistemic: "could_not_access", summary: "Background runtime is not attached." };
      }
      await background.resume();
      return { ok: true, epistemic: "changed", summary: `Background state is ${background.state()}.` };
    },
  );

  registry.register(
    spec("devices_list", "List the Vesper devices enrolled for this user.", "read", {}),
    async () => {
      if (!deviceRegistry) {
        return { ok: false, epistemic: "could_not_access", summary: "No device registry is attached." };
      }
      const records = await deviceRegistry.list();
      const lines = records.map((record) => {
        const presence =
          record.presence.reachability === "online"
            ? `online/${record.presence.activity}`
            : "offline";
        return `${record.identity.name} (${record.identity.deviceType}, ${record.trust}): ${presence}`;
      });
      return {
        ok: true,
        epistemic: "checked",
        summary: lines.length ? lines.join("; ") : "No devices are enrolled yet.",
        data: { devices: records } as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec(
      "device_trust",
      "Change a device's trust state. Trusting a device grants it authority; revoking is permanent until the device is forgotten.",
      "confirm",
      {
        deviceId: { type: "string", description: "The device to change" },
        trust: {
          type: "string",
          description: "New trust state",
          enum: ["trusted", "restricted", "revoked", "pending"],
        },
      },
      ["deviceId", "trust"],
    ),
    async (args) => {
      if (!deviceRegistry) {
        return { ok: false, epistemic: "could_not_access", summary: "No device registry is attached." };
      }
      const result = await deviceRegistry.setTrust(
        str(args, "deviceId"),
        str(args, "trust") as "trusted",
      );
      return {
        ok: result.ok,
        epistemic: result.ok ? "changed" : "could_not_access",
        summary: result.ok
          ? `${result.record?.identity.name ?? "device"} is now '${result.record?.trust}'.`
          : (result.reason ?? "The trust change was refused."),
      };
    },
  );

  registry.register(
    spec(
      "task_create",
      "Queue a task. Vesper routes it to a device that has the capabilities it needs.",
      "safe",
      {
        description: { type: "string", description: "What needs doing" },
        requiredCapabilities: {
          type: "array",
          description: "Capabilities the task needs, e.g. local_llm",
        },
        preferredDevice: { type: "string", description: "Device id to prefer" },
        targetDevice: {
          type: "string",
          description: "The device the user named, e.g. 'my desktop'. Treated as a requirement.",
        },
        tool: {
          type: "string",
          description:
            "Optional. A tool to run when the task comes due. It runs unattended, so it must be one that needs no confirmation.",
        },
        toolArgs: {
          type: "object",
          description: "Optional. Arguments for `tool`, validated against that tool's own schema when it runs.",
        },
      },
      ["description"],
    ),
    async (args) => {
      if (!tasks || !deviceRegistry) {
        return { ok: false, epistemic: "could_not_access", summary: "No task queue is attached." };
      }
      const required = Array.isArray(args.requiredCapabilities)
        ? (args.requiredCapabilities.filter((item) => typeof item === "string") as never[])
        : [];

      // Naming a device is a requirement, not a hint. `preferredDevice` is a soft
      // preference by design: when the preferred machine is offline, routing picks
      // another one. That is right for "run this somewhere sensible" and wrong for
      // "prepare my desktop" — substituting a machine there lands the work on hardware
      // the user did not ask about, and reports success for it.
      const named = str(args, "targetDevice");
      let eligibleDevices: string[] | undefined;
      if (named) {
        const resolved = resolveTarget({
          intent: classifyDeviceIntent(named),
          devices: await deviceRegistry.list(),
          currentDeviceId: selfDeviceId ?? "unknown",
          requiredCapabilities: required,
        });
        if (!resolved.ok || !resolved.device) {
          return {
            ok: false,
            epistemic: "could_not_access",
            summary: resolved.problem ?? `Could not resolve "${named}" to a device.`,
          };
        }
        eligibleDevices = [resolved.device.identity.deviceId];
      }

      // A task that names a tool gets the executor kind; one that does not stays a
      // description-only reminder that no scheduler will start on its own.
      //
      // This does not widen what the caller can do. Whoever can call `task_create` can
      // already call any tool they are permitted; queueing one only defers it, and the
      // deferred call runs under a `scheduled` origin, which reaches strictly LESS than
      // a live request — no confirm-tier tool, nothing that administers trust, nothing
      // on the trusted-only list. The task record is not a stored permission: the whole
      // chain is re-evaluated at execution time against the state that holds then.
      const namedTool = str(args, "tool");
      const toolArgs =
        args.toolArgs && typeof args.toolArgs === "object" && !Array.isArray(args.toolArgs)
          ? (args.toolArgs as JsonObject)
          : {};
      const created = await tasks.create({
        description: str(args, "description"),
        createdBy: selfDeviceId ?? "unknown",
        requiredCapabilities: required,
        preferredDevice: str(args, "preferredDevice") || undefined,
        eligibleDevices,
        kind: namedTool ? TOOL_CALL_TASK_KIND : undefined,
        args: namedTool ? ({ tool: namedTool, args: toolArgs } as JsonObject) : undefined,
      });
      // Route immediately so the reply says where it will run, or honestly that it will not yet.
      const scheduled = await tasks.schedule(await deviceRegistry.list());
      const outcome = scheduled.find((item) => item.task.id === created.id)?.outcome;
      const where =
        outcome?.kind === "assigned"
          ? `Assigned to ${outcome.deviceId}.`
          : `Not assigned yet: ${outcome?.reason ?? "no routing decision was made."}`;
      return {
        ok: true,
        epistemic: "changed",
        summary: `Queued "${created.description}". ${where}`,
        data: { taskId: created.id } as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec("task_list", "List queued and running Vesper tasks.", "read", {}),
    async () => {
      if (!tasks) {
        return { ok: false, epistemic: "could_not_access", summary: "No task queue is attached." };
      }
      const all = await tasks.list();
      const open = all.filter((task) => task.state !== "done" && task.state !== "cancelled");
      return {
        ok: true,
        epistemic: "checked",
        summary: open.length
          ? open.map((task) => `${task.description} [${task.state}${task.assignedTo ? ` -> ${task.assignedTo}` : ""}]`).join("; ")
          : "No open tasks.",
        data: { tasks: all } as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec(
      "obs_status",
      "Ask OBS Studio directly whether it is recording or streaming.",
      "read",
      {},
    ),
    async () => {
      if (!obs) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary: "OBS integration is not configured on this host.",
        };
      }
      const status = obs.isConnected() ? await obs.status() : await obs.connect();
      if (!status.observed) {
        // Falling back to process presence is fine; calling it observed is not.
        return {
          ok: false,
          epistemic: "could_not_access",
          summary: `${status.detail} I can still see whether the OBS process is running, but that does not tell me if it is recording.`,
          data: status as unknown as JsonObject,
        };
      }
      return {
        ok: true,
        epistemic: "checked",
        summary: status.detail,
        data: status as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec(
      "events_recent",
      "List recent events Vesper observed on this host.",
      "read",
      {
        type: { type: "string", description: "Optional event type filter, e.g. obs.state" },
        limit: { type: "number", description: "How many events to return (default 20)" },
      },
    ),
    async (args) => {
      const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
      const type = typeof args.type === "string" && args.type ? args.type : undefined;
      const list = events.recent({ type, limit });
      return {
        ok: true,
        epistemic: "checked",
        summary: list.length
          ? `${list.length} recent event(s): ${list.map((event) => event.title).join("; ")}`
          : "No events have been recorded yet on this host.",
        data: { events: list } as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec(
      "explain_change",
      "Explain what Vesper observed around a moment of interest, such as a performance change reported by the optimizer.",
      "read",
      {
        at: { type: "string", description: "ISO timestamp of the moment. Defaults to now." },
        title: { type: "string", description: "What happened, for the explanation" },
        beforeSeconds: { type: "number", description: "How far back to look (default 120)" },
        afterSeconds: { type: "number", description: "How far forward to look (default 30)" },
      },
    ),
    async (args) => {
      const at = typeof args.at === "string" && args.at ? args.at : new Date().toISOString();
      if (Number.isNaN(Date.parse(at))) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary: `'${at}' is not a timestamp I can read.`,
        };
      }
      const title = typeof args.title === "string" && args.title ? args.title : "that moment";
      const correlations = correlateAround(events.all(), at, {
        beforeMs: Math.min(Math.max(Number(args.beforeSeconds ?? 120) || 120, 1), 3600) * 1000,
        afterMs: Math.min(Math.max(Number(args.afterSeconds ?? 30) || 30, 0), 3600) * 1000,
      });
      return {
        ok: true,
        epistemic: "checked",
        summary: explainCorrelations(title, correlations),
        data: {
          anchor: at,
          correlations: correlations.map((item) => ({
            type: item.event.type,
            title: item.event.title,
            at: item.event.at,
            offsetMs: item.offsetMs,
            relation: item.relation,
          })),
        } as unknown as JsonObject,
      };
    },
  );

  registry.register(
    spec(
      "set_scenario",
      "Change the hardware simulator scenario (development only).",
      "safe",
      {
        scenario: {
          type: "string",
          enum: ["idle", "gaming", "streaming", "gpu-bound", "cpu-bound", "vrchat", "thermal"],
        },
      },
      ["scenario"],
    ),
    async (args) => {
      const scenario = str(args, "scenario") as Parameters<SimulatedHardware["setScenario"]>[0];
      hardware.setScenario(scenario);
      events.emit({
        type: "system.state",
        title: `Simulator scenario ${scenario}`,
        severity: "info",
      });
      if (scenario === "vrchat") {
        events.emit({ type: "game.started", title: "VRChat scenario started", severity: "info" });
      }
      if (scenario === "streaming") {
        events.emit({ type: "obs.state", title: "OBS streaming scenario started", severity: "info" });
      }
      return { ok: true, epistemic: "changed", summary: `Simulator scenario is now '${scenario}'.` };
    },
  );

  registry.register(
    spec("disk_wipe", "High-risk disk operation. Must never run autonomously.", "never", {}),
    async () => ({
      ok: false,
      epistemic: "could_not_access",
      summary: "Refused.",
    }),
  );

  registry.register(
    spec("credential_extract", "Credential access. Must never run autonomously.", "never", {}),
    async () => ({
      ok: false,
      epistemic: "could_not_access",
      summary: "Refused.",
    }),
  );
}
