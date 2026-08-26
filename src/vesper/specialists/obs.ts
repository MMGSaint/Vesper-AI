/**
 * OBS Studio integration over obs-websocket v5.
 *
 * Vesper previously inferred OBS state from process presence: "OBS is running,
 * recording state is not confirmed". That is honest but not useful — the question is
 * almost always whether it is *recording*, not whether the process exists.
 *
 * This client asks OBS directly, so the answer becomes observed rather than inferred.
 * When it is not connected, Vesper says so and falls back to the inference; it never
 * reports an observed state it did not observe.
 *
 * No dependency: Node 22 ships a global WebSocket, and the handshake needs only
 * `node:crypto`.
 */

import { createHash } from "node:crypto";
import { checkLocalEndpoint } from "../net.ts";

/** obs-websocket v5 opcodes. */
const OP_HELLO = 0;
const OP_IDENTIFY = 1;
const OP_IDENTIFIED = 2;
const OP_EVENT = 5;
const OP_REQUEST = 6;
const OP_REQUEST_RESPONSE = 7;

const RPC_VERSION = 1;
/** Output state events only; Vesper has no use for the high-frequency categories. */
const EVENT_SUBSCRIPTIONS = 64;

export interface ObsStatus {
  connected: boolean;
  /** True only when OBS itself told us. `null` when unknown. */
  recording: boolean | null;
  streaming: boolean | null;
  /** Distinguishes an answer from OBS from an inference about OBS. */
  observed: boolean;
  detail: string;
}

export interface ObsSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onOpen(handler: () => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
}

export type ObsSocketFactory = (url: string) => ObsSocket;

/**
 * The v5 auth string: sha256(password + salt) base64, then sha256(that + challenge)
 * base64.
 */
export function obsAuthString(password: string, salt: string, challenge: string): string {
  const secret = createHash("sha256").update(`${password}${salt}`).digest("base64");
  return createHash("sha256").update(`${secret}${challenge}`).digest("base64");
}

function defaultSocketFactory(url: string): ObsSocket {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onMessage: (handler) =>
      socket.addEventListener("message", (event) => handler(String((event as MessageEvent).data))),
    onOpen: (handler) => socket.addEventListener("open", () => handler()),
    onClose: (handler) => socket.addEventListener("close", () => handler()),
    onError: (handler) => socket.addEventListener("error", () => handler(new Error("socket error"))),
  };
}

export interface ObsClientOptions {
  url?: string;
  password?: string;
  timeoutMs?: number;
  socketFactory?: ObsSocketFactory;
  /** Called when OBS reports a state change, so it can be correlated later. */
  onStateChange?: (change: { kind: "record" | "stream"; active: boolean; detail: string }) => void;
}

export interface ObsClient {
  connect(): Promise<ObsStatus>;
  status(): Promise<ObsStatus>;
  disconnect(): void;
  isConnected(): boolean;
}

const DISCONNECTED = (detail: string): ObsStatus => ({
  connected: false,
  recording: null,
  streaming: null,
  observed: false,
  detail,
});

export function createObsClient(options: ObsClientOptions = {}): ObsClient {
  const url = options.url ?? "ws://127.0.0.1:4455";
  const timeoutMs = options.timeoutMs ?? 3000;
  const factory = options.socketFactory ?? defaultSocketFactory;

  // OBS runs on this machine. An "OBS" somewhere on the internet is not this user's OBS,
  // and the password would be sent to it. The shared endpoint check speaks http(s);
  // ws/wss carry the same host and port semantics, so map the scheme for the check
  // rather than loosening the check itself.
  const endpoint = checkLocalEndpoint(url.replace(/^ws(s?):\/\//i, "http$1://"), {
    label: "obs.url",
  });

  let socket: ObsSocket | null = null;
  let identified = false;
  let requestCounter = 0;
  const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();

  let closing = false;

  function cleanup(reason: string): void {
    // Closing a socket makes it fire close/error, which lands back here. Without this
    // guard the real WebSocket recurses until the stack is exhausted.
    if (closing) return;
    closing = true;
    identified = false;
    for (const [, waiter] of pending) waiter.reject(new Error(reason));
    pending.clear();
    const current = socket;
    socket = null;
    try {
      current?.close();
    } catch {
      /* already gone, or never finished connecting */
    }
    closing = false;
  }

  function handle(raw: string): void {
    let message: { op?: number; d?: Record<string, unknown> };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return; // one malformed frame must not drop the connection
    }
    const data = message.d ?? {};

    if (message.op === OP_REQUEST_RESPONSE) {
      const requestId = String(data.requestId ?? "");
      const waiter = pending.get(requestId);
      if (!waiter) return;
      pending.delete(requestId);
      const status = data.requestStatus as { result?: boolean; comment?: string } | undefined;
      if (status?.result) waiter.resolve(data.responseData ?? {});
      else waiter.reject(new Error(status?.comment ?? "OBS rejected the request"));
      return;
    }

    if (message.op === OP_EVENT) {
      const eventType = String(data.eventType ?? "");
      const eventData = (data.eventData ?? {}) as Record<string, unknown>;
      if (eventType === "RecordStateChanged") {
        options.onStateChange?.({
          kind: "record",
          active: eventData.outputActive === true,
          detail: `OBS ${eventData.outputActive === true ? "started" : "stopped"} recording`,
        });
      } else if (eventType === "StreamStateChanged") {
        options.onStateChange?.({
          kind: "stream",
          active: eventData.outputActive === true,
          detail: `OBS ${eventData.outputActive === true ? "started" : "stopped"} streaming`,
        });
      }
    }
  }

  function request(requestType: string): Promise<Record<string, unknown>> {
    if (!socket || !identified) return Promise.reject(new Error("Not connected to OBS."));
    requestCounter += 1;
    const requestId = `vesper-${requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`OBS did not answer ${requestType} within ${timeoutMs}ms`));
      }, positiveMs(timeoutMs));
      pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as Record<string, unknown>);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket?.send(JSON.stringify({ op: OP_REQUEST, d: { requestType, requestId } }));
    });
  }

  return {
    isConnected: () => identified,

    disconnect() {
      cleanup("Disconnected.");
    },

    async connect(): Promise<ObsStatus> {
      if (!endpoint.ok) return DISCONNECTED(`I did not contact OBS: ${endpoint.reason}`);
      if (identified) return this.status();

      return await new Promise<ObsStatus>((resolve) => {
        let settled = false;
        const finish = (status: ObsStatus) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(status);
        };
        const timer = setTimeout(() => {
          finish(DISCONNECTED(`OBS did not complete a handshake within ${timeoutMs}ms.`));
          cleanup("Connection timed out.");
        }, timeoutMs);

        let created: ObsSocket;
        try {
          created = factory(url);
        } catch (error) {
          finish(DISCONNECTED(`Could not open a socket to OBS: ${errorText(error)}`));
          return;
        }
        socket = created;

        created.onError(() => {
          finish(DISCONNECTED(`OBS is not reachable at ${url}.`));
          cleanup("Socket error.");
        });
        created.onClose(() => {
          const wasIdentified = identified;
          if (!wasIdentified) finish(DISCONNECTED(`OBS closed the connection at ${url}.`));
          cleanup("Socket closed.");
        });

        created.onMessage((raw) => {
          let message: { op?: number; d?: Record<string, unknown> };
          try {
            message = JSON.parse(raw) as typeof message;
          } catch {
            return;
          }

          if (message.op === OP_HELLO) {
            const auth = message.d?.authentication as
              | { challenge?: string; salt?: string }
              | undefined;
            const payload: Record<string, unknown> = {
              rpcVersion: RPC_VERSION,
              eventSubscriptions: EVENT_SUBSCRIPTIONS,
            };
            if (auth?.challenge && auth?.salt) {
              if (!options.password) {
                finish(
                  DISCONNECTED(
                    "OBS requires a websocket password and none is configured. Set obs.password.",
                  ),
                );
                cleanup("Authentication required.");
                return;
              }
              payload.authentication = obsAuthString(options.password, auth.salt, auth.challenge);
            }
            created.send(JSON.stringify({ op: OP_IDENTIFY, d: payload }));
            return;
          }

          if (message.op === OP_IDENTIFIED) {
            identified = true;
            clearTimeout(timer);
            // Swap in the steady-state handler now that the handshake is done.
            created.onMessage(handle);
            void this.status().then(finish, () =>
              finish({
                connected: true,
                recording: null,
                streaming: null,
                observed: false,
                detail: "Connected to OBS, but it did not report its output state.",
              }),
            );
            return;
          }

          handle(raw);
        });
      });
    },

    async status(): Promise<ObsStatus> {
      if (!identified) return DISCONNECTED("Not connected to OBS.");
      try {
        const [record, stream] = await Promise.all([
          request("GetRecordStatus"),
          request("GetStreamStatus"),
        ]);
        const recording = record.outputActive === true;
        const streaming = stream.outputActive === true;
        return {
          connected: true,
          recording,
          streaming,
          observed: true,
          detail: `OBS reports recording ${recording ? "active" : "inactive"} and streaming ${
            streaming ? "active" : "inactive"
          }.`,
        };
      } catch (error) {
        return {
          connected: true,
          recording: null,
          streaming: null,
          observed: false,
          detail: `Connected to OBS but could not read its state: ${errorText(error)}`,
        };
      }
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keeps the timeout a positive number even if config supplies nonsense. */
function positiveMs(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 3000;
}
