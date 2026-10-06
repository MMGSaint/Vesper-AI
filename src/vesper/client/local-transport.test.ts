import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

import { LocalCompanionTransport } from "./local-transport.ts";

function connect(endpoint: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint, () => resolve(socket));
    socket.once("error", reject);
  });
}

function request(socket: net.Socket, payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      socket.off("data", onData);
      try {
        resolve(JSON.parse(buffer.slice(0, index)));
      } catch (error) {
        reject(error);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(JSON.stringify(payload) + "\n");
  });
}

describe("LocalCompanionTransport", () => {
  it("serves the versioned gateway over a local socket and writes a session token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vesper-companion-"));
    const socketPath = path.join(root, "companion.sock");
    const tokenPath = path.join(root, "token");

    const gateway = {
      hello: () => ({
        protocol: "vesper.client",
        version: 2,
        core: "test",
        instanceId: "inst-1",
        deviceId: "dev_self",
        hostPosture: "owned",
        started: true,
      }),
      issueSession: async () => ({
        id: "session-1",
        token: "test-token",
        deviceId: "dev_self",
        deviceLabel: "local-companion",
        scopes: ["status", "conversation", "memory.read", "notifications"],
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      status: async () => ({ hello: this, capabilities: [], workspaceId: "general", pendingConfirmations: 0 }),
      converse: async (_token: string | undefined, text: string) => ({ reply: "echo:" + text }),
      confirm: async () => ({ reply: "confirmed" }),
      listMemory: async () => ({ entries: [] }),
      remember: async () => ({ entry: { key: "x" } }),
      searchKnowledge: async () => ({ hits: [] }),
      notifications: async () => ({ items: [] }),
      pending: async () => [],
      forbiddenPowers: () => ["os.filesystem"],
      scopesOf: async () => ["status"],
    };

    const transport = new LocalCompanionTransport(gateway as never, {
      enabled: true,
      dataDir: root,
      socketPath,
      tokenPath,
    });

    try {
      const started = await transport.start();
      assert.equal(started.running, true);
      assert.equal(started.endpoint, socketPath);
      assert.equal((await readFile(tokenPath, "utf8")).trim(), "test-token");

      const socket = await connect(socketPath);
      const hello = await request(socket, {
        v: 2,
        id: "1",
        method: "hello",
      });
      assert.equal(hello.ok, true);
      assert.equal(hello.result.deviceId, "dev_self");

      const conversation = await request(socket, {
        v: 2,
        id: "2",
        method: "converse",
        token: "test-token",
        params: { text: "hello" },
      });
      assert.equal(conversation.ok, true);
      assert.equal(conversation.result.reply, "echo:hello");

      const badVersion = await request(socket, {
        v: 1,
        id: "3",
        method: "hello",
      });
      assert.equal(badVersion.ok, false);

      socket.destroy();
    } finally {
      await transport.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
