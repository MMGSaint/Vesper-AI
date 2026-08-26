/**
 * Model Context Protocol client (stdio transport).
 *
 * This file used to report configuration status and nothing else. It is now a real
 * client, because MCP is the standard way to attach a specialist that Vesper does not
 * implement itself — which is exactly the architecture the project is built around:
 * Vesper coordinates, specialists stay specialists.
 *
 * Transport is newline-delimited JSON-RPC 2.0 over the server's stdin/stdout, per the
 * MCP stdio specification. No dependency.
 *
 * Boundaries that must not move:
 *
 *   - The server command comes from **config**, never from the model. A model cannot
 *     cause a new process to be launched.
 *   - Discovered tools are registered through the normal tool registry, so they pass
 *     the permission gate like every other tool. They default to `confirm`.
 *   - Tool names are namespaced. A server must never be able to shadow a built-in tool,
 *     least of all a never-autonomous one.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { JsonObject, PermissionLevel, ToolSpec } from "../types.ts";

export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  enabled?: boolean;
}

export interface McpTransport {
  send(line: string): void;
  onLine(handler: (line: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  stop(): void;
}

export type McpTransportFactory = (server: McpServerConfig) => McpTransport;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface McpClient {
  id: string;
  start(): Promise<{ ok: boolean; detail: string; tools: McpTool[] }>;
  listTools(): McpTool[];
  callTool(name: string, args: JsonObject): Promise<{ ok: boolean; text: string }>;
  stop(): void;
  isRunning(): boolean;
}

/** The protocol revision this client implements. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Vesper's own tools always win a name collision. */
export function namespacedToolName(serverId: string, toolName: string): string {
  return `mcp_${serverId}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

function defaultTransport(server: McpServerConfig): McpTransport {
  const child = nodeSpawn(server.command, server.args ?? [], {
    cwd: server.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let lineHandler: (line: string) => void = () => {};

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) lineHandler(line);
      newline = buffer.indexOf("\n");
    }
  });
  // The spec allows servers to log freely on stderr; it is not protocol traffic.
  child.stderr?.resume();

  return {
    send: (line) => {
      try {
        child.stdin?.write(`${line}\n`);
      } catch {
        // The server died between the check and the write; onExit reports it.
      }
    },
    onLine: (handler) => {
      lineHandler = handler;
    },
    onExit: (handler) => {
      child.on("close", (code) => handler(code));
      // A missing or unexecutable binary surfaces here, asynchronously. Unhandled, it
      // is an uncaught exception that takes the whole assistant down.
      child.on("error", () => handler(null));
    },
    stop: () => {
      try {
        child.stdin?.end();
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

export function createMcpClient(options: {
  server: McpServerConfig;
  transportFactory?: McpTransportFactory;
  timeoutMs?: number;
}): McpClient {
  const { server } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const factory = options.transportFactory ?? defaultTransport;

  let transport: McpTransport | null = null;
  let nextId = 0;
  let tools: McpTool[] = [];
  const pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void }>();

  function handle(line: string): void {
    let message: { id?: number; result?: JsonObject; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return; // a server that logs to stdout must not break the session
    }
    if (typeof message.id !== "number") return; // a notification or a server request
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "MCP error"));
    else waiter.resolve(message.result ?? {});
  }

  function request(method: string, params?: JsonObject): Promise<JsonObject> {
    if (!transport) return Promise.reject(new Error("MCP server is not running."));
    nextId += 1;
    const id = nextId;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${server.id} did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      transport?.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
    });
  }

  function notify(method: string, params?: JsonObject): void {
    transport?.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }));
  }

  function shutdown(reason: string): void {
    for (const [, waiter] of pending) waiter.reject(new Error(reason));
    pending.clear();
    const current = transport;
    transport = null;
    tools = [];
    try {
      current?.stop();
    } catch {
      /* already gone */
    }
  }

  return {
    id: server.id,
    isRunning: () => transport !== null,
    listTools: () => tools.slice(),
    stop: () => shutdown("Stopped."),

    async start() {
      if (transport) return { ok: true, detail: `${server.id} is already running.`, tools: tools.slice() };
      if (!server.command) {
        return { ok: false, detail: `${server.id} has no command configured.`, tools: [] };
      }
      try {
        transport = factory(server);
      } catch (error) {
        transport = null;
        return {
          ok: false,
          detail: `Could not start ${server.id}: ${errorText(error)}`,
          tools: [],
        };
      }
      transport.onLine(handle);
      transport.onExit(() => shutdown(`${server.id} exited.`));

      try {
        await request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "vesper", version: "1" },
        });
        notify("notifications/initialized");
        const listed = await request("tools/list");
        const raw = Array.isArray(listed.tools) ? listed.tools : [];
        tools = raw
          .map((entry) => {
            const item = entry as { name?: unknown; description?: unknown; inputSchema?: unknown };
            if (typeof item.name !== "string" || !item.name) return null;
            return {
              name: item.name,
              description: typeof item.description === "string" ? item.description : item.name,
              inputSchema:
                item.inputSchema && typeof item.inputSchema === "object" && !Array.isArray(item.inputSchema)
                  ? (item.inputSchema as JsonObject)
                  : ({ type: "object", properties: {} } as JsonObject),
            } satisfies McpTool;
          })
          .filter((item): item is McpTool => item !== null);
        return {
          ok: true,
          detail: `${server.id} is running with ${tools.length} tool(s).`,
          tools: tools.slice(),
        };
      } catch (error) {
        const detail = `Handshake with ${server.id} failed: ${errorText(error)}`;
        shutdown(detail);
        return { ok: false, detail, tools: [] };
      }
    },

    async callTool(name: string, args: JsonObject) {
      try {
        const result = await request("tools/call", { name, arguments: args });
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content
          .map((part) => {
            const item = part as { type?: unknown; text?: unknown };
            return item.type === "text" && typeof item.text === "string" ? item.text : "";
          })
          .filter(Boolean)
          .join("\n")
          .trim();
        // `isError` is the server reporting a tool-level failure, not a transport fault.
        const ok = result.isError !== true;
        return { ok, text: text || (ok ? "The tool returned no text." : "The tool reported an error.") };
      } catch (error) {
        return { ok: false, text: errorText(error) };
      }
    },
  };
}

/**
 * Convert an MCP tool into a Vesper ToolSpec.
 *
 * The schema is narrowed to the shapes Vesper's validator understands; anything it does
 * not recognise is dropped rather than passed through unchecked, because the registry
 * enforces exactly what a spec declares.
 */
export function toToolSpec(
  serverId: string,
  tool: McpTool,
  permission: PermissionLevel = "confirm",
): ToolSpec {
  const schema = tool.inputSchema as {
    properties?: Record<string, { type?: unknown; description?: unknown; enum?: unknown }>;
    required?: unknown;
  };
  const properties: ToolSpec["parameters"]["properties"] = {};
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    const type = value?.type;
    if (
      type !== "string" &&
      type !== "number" &&
      type !== "boolean" &&
      type !== "array" &&
      type !== "object"
    ) {
      continue;
    }
    properties[key] = {
      type,
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      ...(Array.isArray(value.enum) ? { enum: value.enum.map((item) => String(item)) } : {}),
    };
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string" && item in properties)
    : [];

  return {
    name: namespacedToolName(serverId, tool.name),
    description: `[${serverId}] ${tool.description}`,
    permission,
    parameters: { type: "object", properties, required },
    specialist: serverId,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface McpBridgeStatus {
  enabled: boolean;
  required: boolean;
  servers: string[];
  detail: string;
}

export function mcpBridgeStatus(input?: { enabled?: boolean; servers?: string[] }): McpBridgeStatus {
  const enabled = Boolean(input?.enabled);
  const servers = input?.servers ?? [];
  return {
    enabled,
    required: false,
    servers,
    detail: enabled
      ? servers.length
        ? `MCP is enabled with ${servers.length} configured server(s): ${servers.join(", ")}. Their tools pass the permission gate like any other.`
        : "MCP is enabled but no servers are configured."
      : "MCP integrations are optional and disabled. Vesper stays local-first.",
  };
}

export function mcpToolPermission(_spec: ToolSpec): PermissionLevel {
  return "confirm";
}
