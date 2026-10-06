
import type { ToolRegistry } from "../tools/registry.ts";
import type { JsonObject, PermissionLevel, ToolExecutionResult } from "../types.ts";
import {
  createMcpClient,
  namespacedToolName,
  toToolSpec,
  type McpClient,
  type McpServerConfig,
} from "./mcp.ts";

export interface McpManagerOptions {
  enabled: boolean;
  servers: readonly McpServerConfig[];
  timeoutMs?: number;
  permission?: PermissionLevel;
}

export interface McpManagerStatus {
  enabled: boolean;
  running: string[];
  configured: string[];
  tools: string[];
  failures: string[];
}

export class McpManager {
  private readonly options: McpManagerOptions;
  private readonly registry: ToolRegistry;
  private readonly clients = new Map<string, McpClient>();
  private readonly failures: string[] = [];

  constructor(options: McpManagerOptions, registry: ToolRegistry) {
    this.options = options;
    this.registry = registry;
  }

  async start(): Promise<McpManagerStatus> {
    this.failures.length = 0;
    if (!this.options.enabled) return this.status();

    for (const server of this.options.servers) {
      if (server.enabled === false) continue;
      if (this.clients.has(server.id)) continue;

      const client = createMcpClient({
        server,
        timeoutMs: this.options.timeoutMs ?? 10_000,
      });
      const started = await client.start();
      if (!started.ok) {
        this.failures.push(server.id + ": " + started.detail);
        continue;
      }

      this.clients.set(server.id, client);
      for (const tool of started.tools) {
        const permission = this.options.permission ?? "confirm";
        const spec = toToolSpec(server.id, tool, permission);
        const name = namespacedToolName(server.id, tool.name);

        try {
          this.registry.register(spec, async (args): Promise<ToolExecutionResult> => {
            const result = await client.callTool(tool.name, args as JsonObject);
            return {
              ok: result.ok,
              summary: result.text,
              data: result.text,
              epistemic: result.ok ? "observed" : "could_not_access",
              changed: false,
            };
          });
        } catch (error) {
          this.failures.push(
            name + ": could not register discovered tool (" +
              (error instanceof Error ? error.message : String(error)) +
              ")",
          );
        }
      }
    }

    return this.status();
  }

  stop(): void {
    for (const client of this.clients.values()) client.stop();
    this.clients.clear();
  }

  status(): McpManagerStatus {
    const tools: string[] = [];
    for (const client of this.clients.values()) {
      for (const tool of client.listTools()) {
        tools.push(namespacedToolName(client.id, tool.name));
      }
    }
    return {
      enabled: this.options.enabled,
      running: [...this.clients.keys()],
      configured: this.options.servers
        .filter((server) => server.enabled !== false)
        .map((server) => server.id),
      tools,
      failures: this.failures.slice(),
    };
  }
}
