import { createHash } from "node:crypto";
import { chmod, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { VesperClientGateway } from "./gateway.ts";
import { DEFAULT_COMPANION_SCOPES } from "./protocol.ts";

export interface LocalCompanionTransportOptions {
  enabled: boolean;
  dataDir: string;
  socketPath?: string;
  tokenPath?: string;
  maxConnections?: number;
  maxRequestsPerMinute?: number;
  idleTimeoutMs?: number;
}

export interface LocalCompanionTransportStatus {
  enabled: boolean;
  running: boolean;
  endpoint: string | null;
  tokenPath: string | null;
  detail: string;
}

interface RequestEnvelope {
  id?: unknown;
  method?: unknown;
  token?: unknown;
  params?: unknown;
}

const MAX_LINE_BYTES = 64 * 1024;

function pipeName(dataDir: string): string {
  const digest = createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);
  return "\\.\pipe\vesper-companion-" + digest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectParams(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function textParam(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolParam(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function response(id: unknown, payload: unknown): string {
  return JSON.stringify({
    id: id ?? null,
    ...(isRecord(payload) && payload.ok === false
      ? payload
      : { ok: true, result: payload }),
  }) + "\n";
}

export class LocalCompanionTransport {
  private readonly gateway: VesperClientGateway;
  private readonly options: Required<Pick<
    LocalCompanionTransportOptions,
    "maxConnections" | "maxRequestsPerMinute" | "idleTimeoutMs"
  >> & LocalCompanionTransportOptions;
  private server: net.Server | null = null;
  private endpoint: string | null = null;
  private localToken: string | null = null;
  private activeConnections = 0;
  private connectionWindows = new WeakMap<net.Socket, number[]>();

  constructor(
    gateway: VesperClientGateway,
    options: LocalCompanionTransportOptions,
  ) {
    this.gateway = gateway;
    this.options = {
      ...options,
      maxConnections: Math.max(1, Math.min(16, options.maxConnections ?? 4)),
      maxRequestsPerMinute: Math.max(
        10,
        Math.min(600, options.maxRequestsPerMinute ?? 120),
      ),
      idleTimeoutMs: Math.max(
        10_000,
        Math.min(10 * 60_000, options.idleTimeoutMs ?? 120_000),
      ),
    };
  }

  async start(): Promise<LocalCompanionTransportStatus> {
    if (!this.options.enabled) {
      return this.status("Local companion transport is disabled.");
    }
    if (this.server) return this.status("Local companion transport is already running.");

    const session = await this.gateway.issueSession({
      deviceId: this.gateway.hello().deviceId,
      deviceLabel: "local-companion",
      scopes: DEFAULT_COMPANION_SCOPES,
      ttlMs: 60 * 60 * 1000,
    });
    if ("ok" in session) {
      return this.status("Could not create the local companion session: " + session.detail);
    }

    this.localToken = session.token;
    const tokenPath =
      this.options.tokenPath ??
      path.join(this.options.dataDir, "local-companion-token");
    this.options.tokenPath = tokenPath;
    await writeFile(tokenPath, session.token + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(tokenPath, 0o600).catch(() => undefined);

    const endpoint =
      process.platform === "win32"
        ? pipeName(this.options.dataDir)
        : (this.options.socketPath ??
          path.join(this.options.dataDir, "vesper-companion.sock"));
    this.endpoint = endpoint;

    if (process.platform !== "win32") {
      await unlink(endpoint).catch(() => undefined);
    }

    this.server = net.createServer((socket) => this.attach(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(endpoint);
    });

    if (process.platform !== "win32") {
      await chmod(endpoint, 0o600).catch(() => undefined);
    }

    return this.status("Local companion transport is listening.");
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.activeConnections = 0;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.endpoint && process.platform !== "win32") {
      await unlink(this.endpoint).catch(() => undefined);
    }
    this.endpoint = null;
    this.localToken = null;
  }

  token(): string | null {
    return this.localToken;
  }

  status(detail = "Local companion transport is stopped."): LocalCompanionTransportStatus {
    return {
      enabled: this.options.enabled,
      running: this.server !== null,
      endpoint: this.endpoint,
      tokenPath: this.options.tokenPath ?? null,
      detail,
    };
  }

  private attach(socket: net.Socket): void {
    if (this.activeConnections >= this.options.maxConnections) {
      socket.end(response(null, { ok: false, code: "UNAVAILABLE", detail: "Local companion connection limit reached." }));
      return;
    }

    this.activeConnections += 1;
    let buffer = Buffer.alloc(0);
    this.connectionWindows.set(socket, []);

    socket.setTimeout(this.options.idleTimeoutMs, () => {
      socket.destroy();
    });

    const cleanup = () => {
      if (this.activeConnections > 0) this.activeConnections -= 1;
      this.connectionWindows.delete(socket);
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_LINE_BYTES * 2 && !buffer.includes(0x0a)) {
        socket.end(response(null, {
          ok: false,
          code: "INVALID",
          detail: "Request exceeded the 64 KiB framing limit.",
        }));
        return;
      }

      let newline = buffer.indexOf(0x0a);
      while (newline >= 0) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length > MAX_LINE_BYTES) {
          socket.end(response(null, {
            ok: false,
            code: "INVALID",
            detail: "Request exceeded the 64 KiB framing limit.",
          }));
          return;
        }

        void this.handleLine(socket, line.toString("utf8"));
        newline = buffer.indexOf(0x0a);
      }
    });
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    if (!line.trim()) return;

    const now = Date.now();
    const window = this.connectionWindows.get(socket) ?? [];
    const recent = window.filter((stamp) => now - stamp < 60_000);
    if (recent.length >= this.options.maxRequestsPerMinute) {
      socket.end(response(null, {
        ok: false,
        code: "UNAVAILABLE",
        detail: "Local companion request rate limit exceeded.",
      }));
      return;
    }
    recent.push(now);
    this.connectionWindows.set(socket, recent);

    let request: RequestEnvelope;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) throw new Error("request must be an object");
      request = parsed as RequestEnvelope;
    } catch {
      socket.write(response(null, {
        ok: false,
        code: "INVALID",
        detail: "Malformed JSON request.",
      }));
      return;
    }

    const id = request.id ?? null;
    const method = textParam(request.method);
    if (!method) {
      socket.write(response(id, {
        ok: false,
        code: "INVALID",
        detail: "A request method is required.",
      }));
      return;
    }

    const token = textParam(request.token);
    const params = objectParams(request.params);

    try {
      const result = await this.dispatch(method, token, params);
      socket.write(response(id, result));
    } catch (error) {
      socket.write(response(id, {
        ok: false,
        code: "UNAVAILABLE",
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async dispatch(
    method: string,
    token: string | undefined,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "hello":
        return this.gateway.hello();
      case "status":
        return this.gateway.status(token);
      case "converse":
        return this.gateway.converse(token, textParam(params.text));
      case "confirm":
        return this.gateway.confirm(
          token,
          textParam(params.confirmationId) ?? "",
          boolParam(params.approve) ?? false,
        );
      case "listMemory":
        return this.gateway.listMemory(token);
      case "remember":
        return this.gateway.remember(token, {
          key: textParam(params.key) ?? "",
          value: textParam(params.value) ?? "",
          ...(textParam(params.category) ? { category: textParam(params.category) as never } : {}),
        });
      case "searchKnowledge":
        return this.gateway.searchKnowledge(token, textParam(params.query) ?? "");
      case "notifications":
        return this.gateway.notifications(token);
      case "pending":
        return this.gateway.pending(token);
      case "forbiddenPowers":
        return this.gateway.forbiddenPowers();
      case "scopesOf":
        return this.gateway.scopesOf(token);
      default:
        return {
          ok: false,
          code: "INVALID",
          detail: "Unknown companion method: " + method,
        };
    }
  }
}

export async function readLocalCompanionToken(tokenPath: string): Promise<string | null> {
  try {
    const raw = await (await import("node:fs/promises")).readFile(tokenPath, "utf8");
    const token = raw.trim();
    return token || null;
  } catch {
    return null;
  }
}
