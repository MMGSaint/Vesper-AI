import type { VesperConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import type { SimulatedHardware } from "../hardware/simulated.ts";
import type { KnowledgeIndex } from "../knowledge/rag.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { NotificationHub } from "../notifications.ts";
import type { OptimizerAdapter } from "../specialists/optimizer.ts";
import type { ToolRegistry } from "./registry.ts";
import type { JsonObject, MemoryCategory, ToolSpec } from "../types.ts";
import type { WindowsHost } from "../windows/host.ts";
import type { WorkspaceManager } from "../workspaces.ts";

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
}) {
  const { registry, config, hardware, windows, memory, knowledge, optimizer, workspaces, events, notifications } =
    input;

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
          type: "application.launch",
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
          type: "application.exit",
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
      const title = str(args, "title");
      const body = str(args, "body");
      const sent = notifications.push({ kind: "system", title, body, cooldownKey: `notify:${title}` });
      const host = windows.notify(title, body);
      return {
        ok: true,
        epistemic: "changed",
        summary: sent ? host.summary : "Notification suppressed by cooldown.",
      };
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
      const entry = await memory.remember({
        category,
        key: str(args, "key"),
        value: str(args, "value"),
        workspaceId: context.workspaceId,
        source: "agent",
      });
      return { ok: true, epistemic: "changed", summary: `Remembered ${entry.key}.`, data: entry as unknown as JsonObject };
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
      "memory_forget",
      "Forget a stored memory by key or id.",
      "confirm",
      { key: { type: "string" } },
      ["key"],
    ),
    async (args) => {
      const ok = await memory.forget(str(args, "key"));
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
      const ws = workspaces.switchTo(str(args, "name"));
      if (!ws) {
        return {
          ok: false,
          epistemic: "could_not_access",
          summary: `Unknown workspace '${str(args, "name")}'.`,
        };
      }
      events.emit({
        type: "workspace.switch",
        title: `Workspace ${ws.name}`,
        severity: "info",
        workspaceId: ws.id,
      });
      return { ok: true, epistemic: "changed", summary: `Switched to ${ws.name}.`, data: ws as unknown as JsonObject };
    },
  );

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
    spec("optimizer_analyze", "Request analysis from the optimizer adapter.", "read", {}),
    async () => {
      const analysis = await optimizer.analyze();
      return {
        ok: true,
        epistemic: "requested",
        summary: analysis.summary,
        data: analysis as unknown as JsonObject,
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
      return {
        ok: result.accepted,
        epistemic: result.accepted ? "requested" : "could_not_access",
        summary: result.summary,
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
