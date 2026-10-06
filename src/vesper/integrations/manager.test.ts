import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpManager } from "./manager.ts";

describe("McpManager", () => {
  it("starts configured servers and registers namespaced confirm-tier tools", async () => {
    const registered: Array<{ name: string; permission: string; handler: (args: Record<string, unknown>) => Promise<unknown> }> = [];
    const registry = {
      register(spec: { name: string; permission: string }, handler: (args: Record<string, unknown>) => Promise<unknown>) {
        registered.push({ name: spec.name, permission: spec.permission, handler });
      },
    } as never;

    const fakeTransport = {
      send(line: string) {
        const request = JSON.parse(line) as { id?: number; method?: string };
        const response =
          request.method === "initialize"
            ? { jsonrpc: "2.0", id: request.id, result: {} }
            : request.method === "tools/list"
              ? {
                  jsonrpc: "2.0",
                  id: request.id,
                  result: {
                    tools: [
                      {
                        name: "echo",
                        description: "Echo input",
                        inputSchema: {
                          type: "object",
                          properties: { text: { type: "string" } },
                          required: ["text"],
                        },
                      },
                    ],
                  },
                }
              : request.method === "tools/call"
                ? {
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                      content: [{ type: "text", text: "mcp-ok" }],
                    },
                  }
                : { jsonrpc: "2.0", id: request.id, result: {} };
        queueMicrotask(() => this._line?.(JSON.stringify(response)));
      },
      _line: undefined as ((line: string) => void) | undefined,
      onLine(handler: (line: string) => void) {
        this._line = handler;
      },
      onExit(_handler: (code: number | null) => void) {},
      stop() {},
    };

    const manager = new McpManager(
      {
        enabled: true,
        servers: [{ id: "demo", command: "demo-server" }],
        permission: "confirm",
        transportFactory: () => fakeTransport as never,
      },
      registry,
    );

    const started = await manager.start();
    assert.equal(started.running[0], "demo");
    assert.deepEqual(started.tools, ["mcp_demo_echo"]);
    assert.equal(registered[0]?.name, "mcp_demo_echo");
    assert.equal(registered[0]?.permission, "confirm");
    const result = await registered[0]?.handler({ text: "hello" });
    assert.equal((result as { summary?: string }).summary, "mcp-ok");
    manager.stop();
  });
});
