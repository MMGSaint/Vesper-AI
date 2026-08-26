import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createObsClient, obsAuthString, type ObsSocket } from "./obs.ts";

/** A fake OBS server speaking obs-websocket v5 over an in-memory socket. */
function fakeObs(options: {
  password?: string;
  recording?: boolean;
  streaming?: boolean;
  failRequests?: boolean;
  neverHello?: boolean;
} = {}) {
  const sent: unknown[] = [];
  let onMessage: (data: string) => void = () => {};
  let onOpen: () => void = () => {};
  let onClose: () => void = () => {};
  let onError: (error: Error) => void = () => {};
  let closed = false;

  const emit = (payload: unknown) => {
    if (!closed) onMessage(JSON.stringify(payload));
  };

  const socket: ObsSocket = {
    send(data: string) {
      const message = JSON.parse(data) as { op: number; d: Record<string, unknown> };
      sent.push(message);
      if (message.op === 1) {
        if (options.password) {
          const expected = obsAuthString(
            options.password,
            "SALT",
            "CHALLENGE",
          );
          if (message.d.authentication !== expected) {
            emit({ op: 5, d: { eventType: "AuthFailed" } });
            closed = true;
            onClose();
            return;
          }
        }
        emit({ op: 2, d: { negotiatedRpcVersion: 1 } });
        return;
      }
      if (message.op === 6) {
        const requestId = String(message.d.requestId);
        const requestType = String(message.d.requestType);
        if (options.failRequests) {
          emit({
            op: 7,
            d: { requestType, requestId, requestStatus: { result: false, code: 604, comment: "nope" } },
          });
          return;
        }
        const active =
          requestType === "GetRecordStatus" ? options.recording === true : options.streaming === true;
        emit({
          op: 7,
          d: {
            requestType,
            requestId,
            requestStatus: { result: true, code: 100 },
            responseData: { outputActive: active },
          },
        });
      }
    },
    close() {
      if (closed) return;
      closed = true;
      // A real WebSocket fires close on close, and an unconnected one also errors.
      // Reproducing that here is what catches re-entrant cleanup.
      onClose();
      onError(new Error("closed"));
    },
    onMessage: (handler) => {
      onMessage = handler;
    },
    onOpen: (handler) => {
      onOpen = handler;
    },
    onClose: (handler) => {
      onClose = handler;
    },
    onError: (handler) => {
      onError = handler;
    },
  };

  return {
    factory: () => {
      // Hello arrives right after the client wires up its handlers.
      queueMicrotask(() => {
        onOpen();
        if (options.neverHello) return;
        emit({
          op: 0,
          d: {
            obsWebSocketVersion: "5.5.0",
            rpcVersion: 1,
            ...(options.password ? { authentication: { challenge: "CHALLENGE", salt: "SALT" } } : {}),
          },
        });
      });
      return socket;
    },
    sent,
    pushEvent: emit,
    fail: () => onError(new Error("socket error")),
  };
}

test("obs client", async (t) => {
  await t.test("computes the v5 authentication string as the protocol specifies", () => {
    const secret = createHash("sha256").update("hunter2SALT").digest("base64");
    const expected = createHash("sha256").update(`${secret}CHALLENGE`).digest("base64");
    assert.equal(obsAuthString("hunter2", "SALT", "CHALLENGE"), expected);
  });

  await t.test("connects without a password and observes output state", async () => {
    const server = fakeObs({ recording: true, streaming: false });
    const client = createObsClient({ socketFactory: server.factory });
    const status = await client.connect();

    assert.equal(status.connected, true);
    assert.equal(status.observed, true, "the state came from OBS, not from inference");
    assert.equal(status.recording, true);
    assert.equal(status.streaming, false);
    assert.match(status.detail, /recording active/);
    client.disconnect();
  });

  await t.test("authenticates when OBS asks for a password", async () => {
    const server = fakeObs({ password: "hunter2", recording: false, streaming: true });
    const client = createObsClient({ socketFactory: server.factory, password: "hunter2" });
    const status = await client.connect();

    assert.equal(status.connected, true);
    assert.equal(status.streaming, true);
    const identify = server.sent.find((m) => (m as { op: number }).op === 1) as {
      d: { authentication?: string };
    };
    assert.ok(identify.d.authentication, "an authentication string was sent");
    client.disconnect();
  });

  await t.test("says plainly when a password is required and missing", async () => {
    const server = fakeObs({ password: "hunter2" });
    const client = createObsClient({ socketFactory: server.factory });
    const status = await client.connect();

    assert.equal(status.connected, false);
    assert.equal(status.observed, false);
    assert.match(status.detail, /requires a websocket password/i);
    assert.ok(!status.detail.includes("hunter2"), "no secret is echoed");
  });

  await t.test("refuses a non-local OBS endpoint before sending a password", async () => {
    let opened = false;
    const client = createObsClient({
      url: "ws://obs.example.com:4455",
      password: "hunter2",
      socketFactory: () => {
        opened = true;
        throw new Error("should not be reached");
      },
    });
    const status = await client.connect();

    assert.equal(status.connected, false);
    assert.equal(opened, false, "no socket is opened to a remote host");
    assert.match(status.detail, /did not contact OBS/i);
  });

  await t.test("reports an unreachable OBS rather than throwing", async () => {
    const client = createObsClient({
      socketFactory: () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const status = await client.connect();
    assert.equal(status.connected, false);
    assert.equal(status.observed, false);
    assert.match(status.detail, /Could not open a socket/i);
  });

  await t.test("times out a silent server instead of hanging", async () => {
    const server = fakeObs({ neverHello: true });
    const client = createObsClient({ socketFactory: server.factory, timeoutMs: 60 });
    const status = await client.connect();
    assert.equal(status.connected, false);
    assert.match(status.detail, /did not complete a handshake within 60ms/);
  });

  await t.test("stays connected but honest when OBS refuses a request", async () => {
    const server = fakeObs({ failRequests: true });
    const client = createObsClient({ socketFactory: server.factory });
    const status = await client.connect();

    assert.equal(status.connected, true);
    assert.equal(status.observed, false, "a refused request is not an observation");
    assert.equal(status.recording, null);
    client.disconnect();
  });

  await t.test("surfaces recording and streaming state changes as they happen", async () => {
    const changes: { kind: string; active: boolean; detail: string }[] = [];
    const server = fakeObs({ recording: false, streaming: false });
    const client = createObsClient({
      socketFactory: server.factory,
      onStateChange: (change) => changes.push(change),
    });
    await client.connect();

    server.pushEvent({
      op: 5,
      d: { eventType: "RecordStateChanged", eventData: { outputActive: true } },
    });
    server.pushEvent({
      op: 5,
      d: { eventType: "StreamStateChanged", eventData: { outputActive: false } },
    });

    assert.deepEqual(
      changes.map((change) => `${change.kind}:${change.active}`),
      ["record:true", "stream:false"],
    );
    assert.match(changes[0].detail, /started recording/);
    client.disconnect();
  });

  await t.test("a malformed frame does not drop the connection", async () => {
    const server = fakeObs({ recording: true });
    const client = createObsClient({ socketFactory: server.factory });
    await client.connect();
    server.pushEvent("{ not json");
    assert.equal(client.isConnected(), true);
    const status = await client.status();
    assert.equal(status.recording, true);
    client.disconnect();
  });

  await t.test("reports not-connected before connecting", async () => {
    const client = createObsClient({ socketFactory: fakeObs().factory });
    const status = await client.status();
    assert.equal(status.connected, false);
    assert.equal(status.observed, false);
  });

  await t.test("closing does not recurse when the socket fires back", async () => {
    // A real WebSocket fires close and error in response to close(). Cleanup used to
    // re-enter through those handlers until the stack was exhausted.
    const server = fakeObs({ recording: true });
    const client = createObsClient({ socketFactory: server.factory });
    await client.connect();
    client.disconnect();
    client.disconnect();
    assert.equal(client.isConnected(), false);
  });

  await t.test("a socket error before the handshake is reported once", async () => {
    const server = fakeObs({ neverHello: true });
    const client = createObsClient({ socketFactory: server.factory, timeoutMs: 500 });
    const connecting = client.connect();
    queueMicrotask(() => server.fail());
    const status = await connecting;
    assert.equal(status.connected, false);
    assert.match(status.detail, /not reachable|closed the connection/i);
  });
});
