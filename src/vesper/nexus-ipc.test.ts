/**
 * NEXUS IPC adapter tests against a local mock socket server that speaks the real
 * NDJSON contract. No real NEXUS process is required.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseConfig, defaultConfig } from "./config.ts";
import { classifyOptimizerCapability } from "./specialists/optimizer.ts";
import {
  createNexusIpcOptimizerAdapter,
  createNexusIpcClient,
  resolveNexusIpcEndpoint,
  isNexusIpcConfigured,
  isSafeLocalPath,
  isSafePipeName,
  NEXUS_CONTRACT_VERSION,
  type NexusFidelity,
} from "./specialists/nexus-ipc.ts";

const TOKEN = "test-token-that-is-long-enough-1234567890";

/**
 * Mock transport endpoint for the current host.
 * Windows cannot listen on a filesystem `*.sock` path (CI fails with EACCES);
 * use a local named pipe instead — the same shape NEXUS speaks in production.
 */
function mockIpcEndpoint(home: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\vesper-nexus-ipc-${randomBytes(4).toString("hex")}`;
  }
  return join(home, "runtime", "vesper.sock");
}

function missingIpcEndpoint(home: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\vesper-nexus-missing-${randomBytes(4).toString("hex")}`;
  }
  return join(home, "runtime", "no-such.sock");
}

type Handler = (params: Record<string, unknown> | undefined) => {
  ok: boolean;
  fidelity: NexusFidelity;
  result?: unknown;
  error?: { code: string; message: string };
};

class MockNexusServer {
  server: Server | null = null;
  endpoint = "";
  handlers: Record<string, Handler> = {};
  lastToken: string | null = null;
  requests: { method: string; params?: Record<string, unknown> }[] = [];

  async start(endpoint: string): Promise<void> {
    this.endpoint = endpoint;
    this.server = createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen({ path: endpoint }, () => resolve());
    });
    // Named pipes have no filesystem inode to chmod; unix sockets get 0600.
    if (!endpoint.toLowerCase().startsWith("\\\\.\\pipe\\")) {
      await chmod(endpoint, 0o600).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private onConnection(socket: Socket): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) this.handleLine(socket, line);
        index = buffer.indexOf("\n");
      }
    });
  }

  private handleLine(socket: Socket, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      socket.write(
        `${JSON.stringify({
          v: NEXUS_CONTRACT_VERSION,
          id: "unknown",
          ok: false,
          fidelity: "unavailable",
          error: { code: "E_INVALID_INPUT", message: "not json" },
        })}\n`,
      );
      return;
    }
    const req = parsed as {
      v?: string;
      id?: string;
      method?: string;
      token?: string;
      params?: Record<string, unknown>;
    };
    const id = typeof req.id === "string" ? req.id : "unknown";
    this.lastToken = typeof req.token === "string" ? req.token : null;

    if (req.token !== TOKEN) {
      socket.write(
        `${JSON.stringify({
          v: NEXUS_CONTRACT_VERSION,
          id,
          ok: false,
          fidelity: "unavailable",
          error: { code: "E_AUTH", message: "authentication failed" },
        })}\n`,
      );
      socket.destroy();
      return;
    }

    const method = typeof req.method === "string" ? req.method : "";
    this.requests.push({ method, params: req.params });
    const handler = this.handlers[method];
    if (!handler) {
      socket.write(
        `${JSON.stringify({
          v: NEXUS_CONTRACT_VERSION,
          id,
          ok: false,
          fidelity: "unavailable",
          error: { code: "E_INVALID_INPUT", message: `unknown method ${method}` },
        })}\n`,
      );
      return;
    }
    const outcome = handler(req.params);
    if (outcome.ok) {
      socket.write(
        `${JSON.stringify({
          v: NEXUS_CONTRACT_VERSION,
          id,
          ok: true,
          fidelity: outcome.fidelity,
          result: outcome.result,
        })}\n`,
      );
    } else {
      socket.write(
        `${JSON.stringify({
          v: NEXUS_CONTRACT_VERSION,
          id,
          ok: false,
          fidelity: outcome.fidelity,
          error: outcome.error ?? { code: "E_UNKNOWN", message: "failed" },
        })}\n`,
      );
    }
  }
}

describe("NEXUS IPC path resolution", () => {
  it("resolves POSIX home to runtime/vesper.sock and token", () => {
    const resolved = resolveNexusIpcEndpoint({
      home: "/tmp/nexus-home-test",
      platform: "linux",
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.value.endpoint, "/tmp/nexus-home-test/runtime/vesper.sock");
    assert.equal(resolved.value.tokenPath, "/tmp/nexus-home-test/runtime/vesper-token");
    assert.equal(resolved.value.transport, "unix-socket");
  });

  it("resolves Windows home to a local named pipe", () => {
    const resolved = resolveNexusIpcEndpoint({
      home: "C:\\Users\\me\\AppData\\Local\\NEXUS",
      platform: "win32",
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.match(resolved.value.endpoint, /^\\\\\.\\pipe\\nexus-[0-9a-f]{8}$/);
    assert.equal(resolved.value.transport, "named-pipe");
  });

  it("refuses remote hosts and URLs", () => {
    assert.equal(isSafeLocalPath("http://127.0.0.1:9"), false);
    assert.equal(isSafeLocalPath("127.0.0.1:9"), false);
    assert.equal(isSafeLocalPath("\\\\otherhost\\pipe\\nexus"), false);
    assert.equal(isSafePipeName("\\\\otherhost\\pipe\\nexus"), false);
    assert.equal(isSafePipeName("\\\\.\\pipe\\nexus-abcd1234"), true);
  });

  it("isNexusIpcConfigured prefers path-based live config", () => {
    assert.equal(
      isNexusIpcConfigured({ mode: "live", home: "/tmp/nexus", endpoint: null }),
      true,
    );
    assert.equal(
      isNexusIpcConfigured({ mode: "live", transport: "http", endpoint: "http://127.0.0.1:9" }),
      false,
    );
    assert.equal(isNexusIpcConfigured({ mode: "mock", home: "/tmp/nexus" }), false);
  });
});

describe("NEXUS IPC config schema", () => {
  it("accepts ipc transport with home", () => {
    const parsed = parseConfig({
      ...defaultConfig(),
      optimizer: { mode: "live", transport: "ipc", home: "/tmp/nexus-home" },
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.config.optimizer.transport, "ipc");
    assert.equal(parsed.config.optimizer.home, "/tmp/nexus-home");
  });

  it("rejects ipc transport without a path target", () => {
    const parsed = parseConfig({
      ...defaultConfig(),
      optimizer: { mode: "live", transport: "ipc" },
    });
    // Recovery may drop the bad setting; either way transport ipc without path must not stick as valid ipc-ready config.
    assert.ok(
      !parsed.ok ||
        parsed.config.optimizer.transport !== "ipc" ||
        Boolean(parsed.config.optimizer.home || parsed.config.optimizer.socketPath),
    );
  });

  it("rejects a host:port socketPath", () => {
    const parsed = parseConfig({
      ...defaultConfig(),
      optimizer: { mode: "live", transport: "ipc", socketPath: "127.0.0.1:9999" },
    });
    assert.ok(!parsed.ok || parsed.config.optimizer.socketPath === null);
  });
});

describe("NEXUS IPC adapter against a mock socket server", () => {
  let home = "";
  let server: MockNexusServer;
  let adapter: ReturnType<typeof createNexusIpcOptimizerAdapter>;
  const entries: { level: string; message: string; data?: Record<string, unknown> }[] = [];

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "vesper-nexus-ipc-"));
    await mkdir(join(home, "runtime"), { recursive: true });
    await writeFile(join(home, "runtime", "vesper-token"), `${TOKEN}\n`, { mode: 0o600 });
    const endpoint = mockIpcEndpoint(home);
    server = new MockNexusServer();
    server.handlers = {
      getStatus: () => ({
        ok: true,
        fidelity: "live",
        result: {
          runState: "ready",
          activeProfileId: "balanced",
          degraded: false,
        },
      }),
      getCurrentProfile: () => ({
        ok: true,
        fidelity: "live",
        result: { profile: { id: "balanced", name: "Balanced" }, appliedAtMs: 1 },
      }),
      getTelemetrySummary: () => ({
        ok: true,
        fidelity: "live",
        result: {
          fromMs: 0,
          toMs: 1,
          sampleCount: 2,
          metrics: [
            { metric: "cpu.utilization", last: 90, mean: 88 },
            { metric: "gpu.utilization", last: 20, mean: 18 },
          ],
        },
      }),
      analyzeWorkload: () => ({
        ok: true,
        fidelity: "live",
        result: {
          workload: "cpu_bound",
          confidence: 0.9,
          explanation: "CPU is saturated.",
          missingSignals: [],
          contextConflict: false,
        },
      }),
      optimize: () => ({
        ok: true,
        fidelity: "live",
        result: {
          id: "opt_live_1",
          status: "applied_kept",
          summary: "Applied performance profile.",
          checkpointId: "ckpt_1",
          fidelity: "live",
        },
      }),
      rollback: () => ({
        ok: true,
        fidelity: "live",
        result: { checkpointId: "ckpt_1", complete: true, fidelity: "live" },
      }),
      getOptimizationResult: () => ({
        ok: true,
        fidelity: "live",
        result: {
          id: "opt_live_1",
          status: "applied_kept",
          summary: "Applied performance profile.",
          fidelity: "live",
        },
      }),
    };
    await server.start(endpoint);

    const log = {
      info: (_c: string, message: string, data?: Record<string, unknown>) =>
        entries.push({ level: "info", message, data }),
      warn: (_c: string, message: string, data?: Record<string, unknown>) =>
        entries.push({ level: "warn", message, data }),
      error: (_c: string, message: string, data?: Record<string, unknown>) =>
        entries.push({ level: "error", message, data }),
    } as unknown as NonNullable<Parameters<typeof createNexusIpcOptimizerAdapter>[0]["log"]>;

    adapter = createNexusIpcOptimizerAdapter({
      endpoint,
      tokenPath: join(home, "runtime", "vesper-token"),
      timeoutMs: 1000,
      log,
    });
  });

  after(async () => {
    await server.stop();
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    entries.length = 0;
    server.requests = [];
  });

  it("reports live mode from Vesper provenance, not from NEXUS", async () => {
    // Even if we later change the mock to claim otherwise, mode is ours.
    const status = await adapter.getStatus();
    assert.equal(status.available, true);
    assert.equal(status.mode, "live");
    assert.equal(status.currentProfile, "balanced");
    assert.equal(classifyOptimizerCapability(status), "AVAILABLE");
  });

  it("maps telemetry and analysis through the contract", async () => {
    const telemetry = await adapter.getTelemetry();
    assert.equal(telemetry.available, true);
    assert.equal(telemetry.bound, "cpu");

    const analysis = await adapter.analyze();
    assert.equal(analysis.bound, "cpu");
    assert.match(analysis.summary, /CPU is saturated/i);
  });

  it("optimizes with profileId and records a live confirmation", async () => {
    const result = await adapter.requestOptimization({ profile: "performance", reason: "user" });
    assert.equal(result.accepted, true);
    assert.match(result.summary, /Applied performance/i);
    const optimizeReq = server.requests.find((r) => r.method === "optimize");
    assert.equal(optimizeReq?.params?.profileId, "performance");
    const confirmed = entries.find((e) => e.message === "Optimizer confirmed an optimization");
    assert.equal(confirmed?.data?.machineStateChanged, true);
    assert.equal(confirmed?.data?.fidelity, "live");
  });

  it("rolls back using the checkpoint from optimize", async () => {
    await adapter.requestOptimization({ profile: "performance" });
    const rolled = await adapter.requestRollback();
    assert.equal(rolled.accepted, true);
    const rollbackReq = server.requests.find((r) => r.method === "rollback");
    assert.equal(rollbackReq?.params?.checkpointId, "ckpt_1");
  });

  it("never logs the token", async () => {
    await adapter.getStatus();
    const blob = JSON.stringify(entries);
    assert.equal(blob.includes(TOKEN), false);
    assert.equal(server.lastToken, TOKEN);
  });

  it("degrades honestly on auth failure", async () => {
    const bad = createNexusIpcOptimizerAdapter({
      endpoint: server.endpoint,
      tokenPath: join(home, "runtime", "missing-token"),
      timeoutMs: 500,
      token: "wrong-token-wrong-token-wrong-token-xx",
    });
    const status = await bad.getStatus();
    assert.equal(status.available, false);
    assert.equal(classifyOptimizerCapability(status), "UNAVAILABLE");
  });

  it("degrades honestly on timeout / missing socket", async () => {
    const missing = createNexusIpcOptimizerAdapter({
      endpoint: missingIpcEndpoint(home),
      tokenPath: join(home, "runtime", "vesper-token"),
      timeoutMs: 200,
    });
    const status = await missing.getStatus();
    assert.equal(status.available, false);
    assert.match(status.detail, /ENOENT|connect|NEXUS/i);
  });

  it("degrades on malformed JSON from the server", async () => {
    const client = createNexusIpcClient({
      endpoint: server.endpoint,
      token: TOKEN,
      timeoutMs: 500,
    });
    // Swap handler to write garbage via a one-off raw server response by using a
    // method that returns ok but we intercept — easier: temporary handler that the
    // client still parses; instead send via a custom connect by calling a method
    // whose handler we replace to... actually test the client's parse path with a
    // tiny throwaway server.
    const junkHome = await mkdtemp(join(tmpdir(), "vesper-nexus-junk-"));
    await mkdir(join(junkHome, "runtime"), { recursive: true });
    const junkSock = mockIpcEndpoint(junkHome);
    const junk = createServer((socket) => {
      socket.on("data", () => {
        socket.write("{not-json\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      junk.once("error", reject);
      junk.listen({ path: junkSock }, () => resolve());
    });
    const junkClient = createNexusIpcClient({
      endpoint: junkSock,
      token: TOKEN,
      timeoutMs: 500,
    });
    const result = await junkClient.call("getStatus");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Malformed/i);
    await new Promise<void>((resolve) => junk.close(() => resolve()));
    await rm(junkHome, { recursive: true, force: true });
    void client;
  });
});

describe("NEXUS mocked fidelity must not claim live hardware change", () => {
  let home = "";
  let server: MockNexusServer;

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "vesper-nexus-mockfid-"));
    await mkdir(join(home, "runtime"), { recursive: true });
    await writeFile(join(home, "runtime", "vesper-token"), `${TOKEN}\n`, { mode: 0o600 });
    server = new MockNexusServer();
    server.handlers = {
      optimize: () => ({
        ok: true,
        fidelity: "mocked",
        result: {
          id: "opt_mock_1",
          status: "applied_kept",
          summary: "Simulated apply.",
          checkpointId: "ckpt_mock",
          fidelity: "mocked",
        },
      }),
      getStatus: () => ({
        ok: true,
        fidelity: "mocked",
        result: { runState: "ready", activeProfileId: "balanced" },
      }),
      getCurrentProfile: () => ({
        ok: true,
        fidelity: "mocked",
        result: { profile: { id: "balanced" }, appliedAtMs: null },
      }),
    };
    await server.start(mockIpcEndpoint(home));
  });

  after(async () => {
    await server.stop();
    await rm(home, { recursive: true, force: true });
  });

  it("accepted summaries and logs refuse a live hardware claim", async () => {
    const entries: { message: string; data?: Record<string, unknown> }[] = [];
    const log = {
      info: (_c: string, message: string, data?: Record<string, unknown>) =>
        entries.push({ message, data }),
      warn: (_c: string, message: string, data?: Record<string, unknown>) =>
        entries.push({ message, data }),
      error: (_c: string, message: string, data?: Record<string, unknown>) =>
        entries.push({ message, data }),
    } as unknown as NonNullable<Parameters<typeof createNexusIpcOptimizerAdapter>[0]["log"]>;

    const adapter = createNexusIpcOptimizerAdapter({
      endpoint: server.endpoint,
      tokenPath: join(home, "runtime", "vesper-token"),
      timeoutMs: 1000,
      log,
    });

    const status = await adapter.getStatus();
    // Adapter provenance is still live (we really spoke IPC); fidelity is separate.
    assert.equal(status.mode, "live");

    const result = await adapter.requestOptimization({ profile: "performance" });
    assert.equal(result.accepted, true);
    assert.match(result.summary, /fidelity=mocked|not a live hardware change/i);
    assert.doesNotMatch(result.summary, /live hardware change was performed/i);

    const confirmed = entries.find((e) => e.message === "Optimizer confirmed an optimization");
    assert.equal(confirmed?.data?.machineStateChanged, false);
    assert.equal(confirmed?.data?.fidelity, "mocked");
  });
});
