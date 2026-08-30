/**
 * End-to-end inference from the HOST layer, over a real socket.
 *
 * `live-backend.test.ts` already drives a real socket, but it enters at `createRuntime`
 * with an inline config object. That leaves the top of the production path untested:
 * the config FILE on disk, `createProductionHost`, and the `runtime.chat` call that
 * `--ask` actually makes (host/main.ts:316). Everything a user's install depends on to
 * turn a line in vesper.json into a request on the wire lived below the lowest test.
 *
 * So this file starts where a real run starts - a vesper.json in a config directory -
 * and asserts on what the backend received. The chain under test is:
 *
 *   vesper.json -> loadHostConfig -> createProductionHost -> createRuntime
 *     -> createModelRouter -> createOllamaProvider -> HTTP -> /api/chat
 *     -> NDJSON -> Agent.runTurn -> AgentTurn -> caller
 *
 * The server is a stand-in: it speaks Ollama's wire protocol but loads no model, so no
 * timing here describes real inference. What it does prove is that the configured model
 * name reaches the wire unchanged, which is the property that made a real install
 * confusing to debug.
 *
 * For a run against a REAL Ollama daemon with real weights, see the opt-in block at the
 * bottom, gated on VESPER_LIVE_OLLAMA.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionHost } from "./service.ts";
import { configFile } from "../paths.ts";
import type { VesperDirs } from "../types.ts";

interface ChatRecord {
  path: string;
  model: string | null;
}

interface FakeOllama {
  url: string;
  /** Every request path the provider asked for, in order. */
  paths: string[];
  /** Every /api/chat body's `model` field - what actually went on the wire. */
  chats: ChatRecord[];
  close(): Promise<void>;
}

/** A real listener speaking Ollama's native protocol. Real, because the question is
 *  which bytes leave the process, and a stubbed fetch answers that by assuming it. */
async function startOllama(reply: string): Promise<FakeOllama> {
  const paths: string[] = [];
  const chats: ChatRecord[] = [];
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    paths.push(url);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              {
                name: "qwen3:14b",
                model: "qwen3:14b",
                size: 9_000_000_000,
                details: { family: "qwen3", parameter_size: "14.8B", quantization_level: "Q4_K_M" },
              },
            ],
          }),
        );
        return;
      }
      if (url === "/api/chat") {
        const raw = Buffer.concat(chunks).toString("utf8");
        let model: string | null = null;
        try {
          const body = JSON.parse(raw) as { model?: unknown };
          model = typeof body.model === "string" ? body.model : null;
        } catch {
          model = null;
        }
        chats.push({ path: url, model });
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(`${JSON.stringify({ message: { role: "assistant", content: reply }, done: false })}\n`);
        res.write(
          `${JSON.stringify({
            message: { role: "assistant", content: "" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 11,
            eval_count: 5,
            eval_duration: 50_000_000,
          })}\n`,
        );
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    paths,
    chats,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function dirsUnder(name: string): VesperDirs {
  const root = join(tmpdir(), `vesper-${name}-${process.pid}-${Date.now()}`);
  return {
    root,
    config: join(root, "config"),
    data: join(root, "data"),
    logs: join(root, "logs"),
    models: join(root, "models"),
  };
}

/** Write a config file the way a real install spells it, `/v1` suffix and all. */
async function writeConfig(dirs: VesperDirs, endpoint: string, model: string): Promise<void> {
  await mkdir(dirs.config, { recursive: true });
  await writeFile(
    configFile(dirs),
    JSON.stringify(
      {
        identity: { name: "Vesper", userName: "User" },
        models: {
          endpoints: { ollama: `${endpoint}/v1` },
          roles: { everyday: { provider: "ollama", model } },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("inference end to end from the host layer", () => {
  it("carries a config file's model name onto the wire and a reply back", async () => {
    const backend = await startOllama("Paris.");
    const dirs = dirsUnder("live-inference");
    await writeConfig(dirs, backend.url, "qwen3:14b");
    const host = await createProductionHost({ dirs, runtime: { skipDiscovery: true } });
    try {
      // The exact call `--ask` makes (host/main.ts:316).
      const turn = await host.runtime.chat("What is the capital of France?");

      // 1. A reply came back out through Vesper, not a fallback stub.
      assert.equal(turn.reply, "Paris.");
      assert.equal(turn.model?.providerId, "ollama");
      assert.notEqual(turn.model?.unavailable, true, "the local backend served this turn");

      // 2. The model the CONFIG FILE named is the model that reached the wire. This is
      //    the whole point: no discovery, migration, or defaulting rewrites it in
      //    between. A mismatch here means the reported role and the served model have
      //    drifted apart, which is unfalsifiable from the outside.
      assert.equal(turn.model?.model, "qwen3:14b");
      assert.deepEqual(
        backend.chats.map((chat) => chat.model),
        ["qwen3:14b"],
        `server saw ${JSON.stringify(backend.chats)}`,
      );

      // A SECOND turn, because the two turns take different branches of `pick()` and
      // only asserting one leaves the other unpinned. Nothing has been probed when the
      // first turn runs (the host was built with skipDiscovery, exactly as
      // `npm run doctor` and a cold start do), so `pick()` finds no available provider,
      // falls through to `reprobeIfStale()`, and returns from the post-probe branch.
      // By the second turn the provider is marked available and the preferred branch
      // answers directly. Mutating either branch to return a different model name is
      // caught only by the turn that goes through it - verified by mutation, after the
      // single-turn version of this test survived a rewrite of the branch it never hit.
      const second = await host.runtime.chat("And the capital of Italy?");
      assert.equal(second.model?.model, "qwen3:14b");
      assert.equal(second.model?.providerId, "ollama");
      assert.deepEqual(
        backend.chats.map((chat) => chat.model),
        ["qwen3:14b", "qwen3:14b"],
        `both turns must carry the configured model; server saw ${JSON.stringify(backend.chats)}`,
      );

      // 3. Native API, not the OpenAI-compat shim - the `/v1` in the config is stripped
      //    rather than prefixed onto the native route.
      assert.ok(backend.paths.includes("/api/chat"), `paths: ${JSON.stringify(backend.paths)}`);
      assert.deepEqual(
        backend.paths.filter((path) => path.startsWith("/v1")),
        [],
        `no /v1 request should be made; saw ${JSON.stringify(backend.paths)}`,
      );
    } finally {
      await host.shutdown();
      await backend.close();
    }
  });

  it("reports the model it actually used, not the one it was configured with", async () => {
    // When the backend is down the turn must say so rather than reporting the
    // configured model as though it had served the reply. `turn.model` is the only
    // record of what answered.
    const backend = await startOllama("unused");
    const url = backend.url;
    await backend.close();
    const dirs = dirsUnder("live-inference-down");
    await writeConfig(dirs, url, "qwen3:14b");
    const host = await createProductionHost({ dirs, runtime: { skipDiscovery: true } });
    try {
      const turn = await host.runtime.chat("What is the capital of France?");
      assert.notEqual(
        turn.model?.providerId,
        "ollama",
        "nothing was listening, so ollama cannot be reported as the provider that answered",
      );
      assert.notEqual(turn.reply, "Paris.");
    } finally {
      await host.shutdown();
    }
  });
});

describe("the doctor names where its configuration came from", () => {
  it("names the file it read", async () => {
    const backend = await startOllama("hello");
    const dirs = dirsUnder("doctor-config-file");
    await writeConfig(dirs, backend.url, "qwen3:14b");
    const host = await createProductionHost({ dirs, runtime: { skipDiscovery: true } });
    try {
      const report = await host.doctor();
      const config = report.checks.find((check) => check.id === "config");
      assert.ok(config, "expected a config check");
      assert.ok(
        config.detail.includes(configFile(dirs)),
        `the config check must name the file it read; said: ${config.detail}`,
      );
      assert.match(config.detail, /read from/i);
    } finally {
      await host.shutdown();
      await backend.close();
    }
  });

  it("says so plainly when there is no config file and it is reporting its own defaults", async () => {
    // Regression: this printed "Config parsed (Vesper)" - identical to the line above -
    // and then reported built-in defaults in the role lines in the same shape as a real
    // setting. A user whose config lives on a path this process does not resolve to saw
    // a green report describing a configuration they never wrote.
    const dirs = dirsUnder("doctor-config-default");
    const host = await createProductionHost({ dirs, runtime: { skipDiscovery: true } });
    try {
      const report = await host.doctor();
      const config = report.checks.find((check) => check.id === "config");
      assert.ok(config, "expected a config check");
      assert.match(
        config.detail,
        /built-in defaults/i,
        `a defaulted config must say so; said: ${config.detail}`,
      );
      assert.ok(
        config.detail.includes(configFile(dirs)),
        `it must still name the path it looked at; said: ${config.detail}`,
      );
      // And the two cases must not read alike.
      assert.doesNotMatch(config.detail, /read from/i);
    } finally {
      await host.shutdown();
    }
  });
});

/**
 * Opt-in: run against a REAL Ollama daemon with real weights.
 *
 *   VESPER_LIVE_OLLAMA=1 \
 *   VESPER_LIVE_OLLAMA_MODEL=qwen3:14b \
 *   node --experimental-strip-types --test src/vesper/host/live-inference.test.ts
 *
 * Skipped by default so the suite stays hermetic and offline. This is the only test in
 * the repository whose passing depends on a model actually generating tokens; when it
 * runs, the reply is real inference and the token counters are measurements.
 */
const LIVE = process.env.VESPER_LIVE_OLLAMA === "1";
const LIVE_MODEL = process.env.VESPER_LIVE_OLLAMA_MODEL ?? "qwen3:14b";
const LIVE_ENDPOINT = process.env.VESPER_LIVE_OLLAMA_ENDPOINT ?? "http://127.0.0.1:11434/v1";

describe("against a real Ollama daemon", { skip: !LIVE && "set VESPER_LIVE_OLLAMA=1 to run" }, () => {
  it("answers a question through the production host path", async () => {
    const dirs = dirsUnder("live-real-ollama");
    await mkdir(dirs.config, { recursive: true });
    await writeFile(
      configFile(dirs),
      JSON.stringify(
        {
          identity: { name: "Vesper", userName: "User" },
          models: {
            endpoints: { ollama: LIVE_ENDPOINT },
            roles: { everyday: { provider: "ollama", model: LIVE_MODEL } },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const host = await createProductionHost({ dirs, runtime: { skipDiscovery: true } });
    try {
      const turn = await host.runtime.chat(
        "What is the capital of France? Answer in one short sentence.",
      );
      assert.equal(turn.model?.providerId, "ollama", `turn: ${JSON.stringify(turn.model)}`);
      assert.equal(turn.model?.model, LIVE_MODEL);
      assert.notEqual(turn.model?.unavailable, true, `the model did not serve: ${turn.reply}`);
      assert.ok(turn.reply.length > 0, "a real model produced no text");
      // Not asserting the content: a small model may phrase it any number of ways, and
      // an assertion on wording would be a test of the model, not of Vesper.
      console.log(`[live] ${LIVE_MODEL} replied: ${turn.reply.trim().slice(0, 200)}`);
    } finally {
      await host.shutdown();
    }
  });
});
