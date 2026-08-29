/**
 * Regression: `--doctor` reported "Provider 'ollama' (local) did not answer" on a machine
 * where Ollama was plainly running - `ollama list` worked, `/api/tags` answered
 * `Invoke-RestMethod`, the config named the right endpoint.
 *
 * The doctor was not failing to reach Ollama. It was not reaching for it at all.
 * `models.status()` is a pure read of each provider's cached `available` flag, whose only
 * writer is `probeAll()` - called once at the tail of fire-and-forget first-boot
 * discovery, and from a lazy re-probe reachable only through `pick()` on a real
 * completion. `npm run doctor` passes `--skip-discovery`, so on that path nothing ever
 * probed, and the report said "did not answer" about a request that was never sent.
 *
 * These tests drive the real production doctor against a real HTTP server on loopback.
 * A stubbed provider would not have caught the bug: the defect was in which code ran, not
 * in what Ollama replied.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createProductionHost } from "./service.ts";
import { configFile } from "../paths.ts";
import type { DoctorReport } from "../doctor.ts";
import type { VesperDirs } from "../types.ts";

/** Every path the provider actually requested, in order. */
interface FakeOllama {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

/**
 * A real HTTP listener speaking the two native routes a probe touches. Real because the
 * question under test is which URL leaves the process, and a fake `fetch` would answer
 * that question by assuming it.
 */
async function startOllama(): Promise<FakeOllama> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
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
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
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

/**
 * Write the endpoint the way a real install spells it - with the `/v1` suffix the starter
 * config ships and the user's machine had.
 */
async function writeOllamaConfig(dirs: VesperDirs, endpoint: string): Promise<void> {
  await mkdir(dirs.config, { recursive: true });
  await writeFile(
    configFile(dirs),
    JSON.stringify(
      {
        models: {
          endpoints: { ollama: endpoint },
          roles: { everyday: { provider: "ollama", model: "qwen3:14b" } },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function check(report: DoctorReport, id: string) {
  return report.checks.find((entry) => entry.id === id);
}

describe("doctor / ollama reachability", () => {
  it("a configured /v1 endpoint reaches native /api/tags", async () => {
    const ollama = await startOllama();
    const dirs = dirsUnder("doctor-v1");
    // Exactly the shape in the field: the OpenAI-compat URL, serving the native API.
    await writeOllamaConfig(dirs, `${ollama.url}/v1`);
    const host = await createProductionHost({ dirs, runtime: { skipDiscovery: true } });
    try {
      await host.doctor();
      assert.ok(
        ollama.requests.includes("/api/tags"),
        `expected a native /api/tags request; server saw ${JSON.stringify(ollama.requests)}`,
      );
      // The `/v1` suffix is stripped, not appended to the native route. A request to
      // `/v1/api/tags` (or to the shim's `/v1/models`) would mean Vesper had quietly
      // gone back to the OpenAI-compat path.
      assert.deepEqual(
        ollama.requests.filter((path) => path.startsWith("/v1")),
        [],
        `no request should carry the /v1 prefix; server saw ${JSON.stringify(ollama.requests)}`,
      );
    } finally {
      await host.shutdown();
      await ollama.close();
    }
  });

  it("reports the backend REACHABLE when it is actually running, under --skip-discovery", async () => {
    const ollama = await startOllama();
    const dirs = dirsUnder("doctor-reachable");
    await writeOllamaConfig(dirs, `${ollama.url}/v1`);
    // `skipDiscovery` is what `npm run doctor` passes. It skips first-boot DISCOVERY;
    // it must not turn live reachability into a stale guess.
    const host = await createProductionHost({ dirs, runtime: { skipDiscovery: true } });
    try {
      const report = await host.doctor();
      const local = check(report, "local-model");
      assert.ok(local, "expected a local-model check");
      assert.match(
        local.detail,
        /Local inference backend\(s\) reachable: .*\bollama\b/,
        `local-model said: ${local.detail}`,
      );
      // The unreachable-provider line is emitted only for providers that failed. Ollama
      // answered, so it must not be named there.
      assert.equal(
        check(report, "provider-ollama"),
        undefined,
        "ollama answered, so no 'did not answer' line should be emitted for it",
      );
      const role = check(report, "role-everyday");
      assert.ok(role, "expected a role-everyday check");
      assert.equal(role.ok, true, `role-everyday said: ${role.detail}`);
    } finally {
      await host.shutdown();
      await ollama.close();
    }
  });

  it("still reports UNREACHABLE when nothing is listening", async () => {
    // Guards the other direction: a doctor that always said "reachable" would pass the
    // test above and lie on a machine with no backend. Bind a port, then release it, so
    // the endpoint is well-formed and certainly refused.
    const ollama = await startOllama();
    const url = ollama.url;
    await ollama.close();
    const dirs = dirsUnder("doctor-unreachable");
    await writeOllamaConfig(dirs, `${url}/v1`);
    const host = await createProductionHost({ dirs, runtime: { skipDiscovery: true } });
    try {
      const report = await host.doctor();
      const local = check(report, "local-model");
      assert.ok(local, "expected a local-model check");
      assert.match(local.detail, /No local inference backend is reachable/);
      const provider = check(report, "provider-ollama");
      assert.ok(provider, "expected the unreachable-provider line for ollama");
      assert.match(provider.detail, /did not answer/);
    } finally {
      await host.shutdown();
    }
  });

  it("status() alone never contacts the backend", async () => {
    // Pins the property that produced the bug, so the fix cannot be undone by moving the
    // probe back out of `doctor()`: reading status is free, and therefore anything that
    // reports reachability has to probe first.
    const ollama = await startOllama();
    const dirs = dirsUnder("doctor-status-pure");
    await writeOllamaConfig(dirs, `${ollama.url}/v1`);
    const host = await createProductionHost({ dirs, runtime: { skipDiscovery: true } });
    try {
      const before = ollama.requests.length;
      const status = host.runtime.models.status();
      assert.equal(
        ollama.requests.length,
        before,
        "status() must remain a pure read of cached flags",
      );
      const entry = status.available.find((provider) => provider.id === "ollama");
      assert.ok(entry, "expected ollama among the routed providers");
      assert.equal(entry.available, false, "unprobed means not-yet-known, not available");
    } finally {
      await host.shutdown();
      await ollama.close();
    }
  });
});
