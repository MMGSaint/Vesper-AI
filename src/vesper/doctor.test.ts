import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./config.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";

describe("doctor", () => {
  it("reports writable dirs and does not claim hardware validation", async () => {
    const root = join(tmpdir(), `vesper-doctor-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const dirs = {
      root,
      config: join(root, "config"),
      data: join(root, "data"),
      logs: join(root, "logs"),
      models: join(root, "models"),
    };
    const report = await runDoctor({
      dirs,
      config: defaultConfig(),
      configOk: true,
      configErrors: [],
      storageReadable: true,
    });
    assert.equal(report.ok, true);
    assert.ok(report.checks.some((check) => check.id === "node" && check.ok));
    assert.ok(report.checks.some((check) => check.id === "client-protocol" && check.ok));
    const text = formatDoctor(report);
    assert.equal(text.includes("AMD telemetry"), true);
    assert.equal(/passed on the target PC/i.test(text), false);
  });
});

describe("doctor tells the user about their model backend, honestly", () => {
  /**
   * Every previous run of --doctor said nothing about which providers were reachable or
   * which models were installed on them. On a Windows PC where Ollama wasn't running,
   * the user got a clean bill of health while every natural-language question fell to
   * the "no local inference backend" fallback. The doctor is where that mismatch should
   * be surfaced first.
   *
   * `ok: true` is retained for "no local model" — Vesper starts and runs deterministic
   * intents, tools, memory, and the security boundary — because the doctor should not
   * report a machine as broken when the user has simply not started their model server.
   * The detail line is what says what is missing.
   */
  async function run(status?: import("./doctor.ts").DoctorModelStatus) {
    const { defaultConfig } = await import("./config.ts");
    const { resolveVesperDirs } = await import("./paths.ts");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "vesper-doctor-"));
    return runDoctor({
      dirs: resolveVesperDirs({ dataDir: base }),
      config: defaultConfig(),
      configOk: true,
      configErrors: [],
      storageReadable: true,
      models: status,
    });
  }

  it("says no backend is reachable when none is, and does not report the box as broken", async () => {
    const report = await run({
      active: "auto",
      available: [
        { id: "ollama", kind: "local", available: false },
        { id: "llamacpp", kind: "local", available: false },
        { id: "echo", kind: "test", available: true },
      ],
      roles: {
        everyday: { provider: "ollama", model: "qwen2.5:14b" },
      },
    });
    const model = report.checks.find((check) => check.id === "local-model");
    assert.ok(model, "local-model check missing");
    assert.equal(model.ok, true, "unreachable backend was reported as an error");
    assert.match(model.detail, /No local inference backend is reachable/);
    assert.match(model.detail, /Start a backend/i, "no actionable advice was given");
    // Every unreachable provider gets its own line.
    assert.ok(
      report.checks.find((check) => check.id === "provider-ollama"),
      "ollama provider status missing",
    );
    assert.ok(
      report.checks.find((check) => check.id === "provider-llamacpp"),
      "llamacpp provider status missing",
    );
    // Roles that reference an unreachable provider say so.
    const role = report.checks.find((check) => check.id === "role-everyday");
    assert.match(role?.detail ?? "", /not reachable/i);
  });

  it("names the reachable local backends when they exist", async () => {
    const report = await run({
      active: "ollama",
      available: [
        { id: "ollama", kind: "local", available: true },
        { id: "llamacpp", kind: "local", available: false },
      ],
      roles: { everyday: { provider: "ollama", model: "qwen2.5:14b" } },
    });
    const model = report.checks.find((check) => check.id === "local-model");
    assert.match(model?.detail ?? "", /reachable: ollama/i);
    assert.match(model?.detail ?? "", /Active router selection: ollama/i);
    const role = report.checks.find((check) => check.id === "role-everyday");
    assert.match(role?.detail ?? "", /reachable/i);
    assert.doesNotMatch(role?.detail ?? "", /not reachable/i);
  });

  it("skips model checks entirely when status is not provided (unit callers)", async () => {
    const report = await run();
    assert.equal(report.checks.find((c) => c.id === "local-model"), undefined);
    assert.equal(report.checks.find((c) => c.id.startsWith("provider-")), undefined);
    assert.equal(report.checks.find((c) => c.id.startsWith("role-")), undefined);
  });
});

describe("doctor reports readiness and startup registration", () => {
  async function report(input: {
    readiness?: Parameters<typeof runDoctor>[0]["readiness"];
    startup?: Parameters<typeof runDoctor>[0]["startup"];
  } = {}) {
    const { defaultConfig } = await import("./config.ts");
    const { resolveVesperDirs } = await import("./paths.ts");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "vesper-doctor-"));
    return runDoctor({
      dirs: resolveVesperDirs({ dataDir: base }),
      config: defaultConfig(),
      configOk: true,
      configErrors: [],
      storageReadable: true,
      readiness: input.readiness,
      startup: input.startup,
    });
  }

  it("adds a readiness check when a readiness snapshot is supplied", async () => {
    const r = await report({
      readiness: {
        state: "READY",
        settled: true,
        summary: "Vesper is ready.",
        components: [
          { id: "manifest", state: "ready", detail: "refreshed", optional: false },
        ],
      },
    });
    const check = r.checks.find((c) => c.id === "readiness");
    assert.ok(check, "readiness check must be present");
    assert.equal(check!.ok, true);
    assert.match(check!.detail, /READY/);
  });

  it("omits readiness when no snapshot is supplied", async () => {
    // A doctor run before start() has no readiness to report on; omitting the check
    // is honest, and asserting it keeps the doctor's own boot-time footprint minimal.
    const r = await report();
    assert.equal(r.checks.some((c) => c.id === "readiness"), false);
    assert.equal(r.checks.some((c) => c.id === "startup-registration"), false);
  });

  it("passes CORE_READY as ok:true too, because it is a settled reading of 'started, catching up'", async () => {
    // A doctor run inside the discovery window would otherwise show `ok: false` and
    // push the process exit code to 1 for a normal warm-up state. Distinct from
    // DEGRADED (settled with degradation) and READY (fully settled), CORE_READY is
    // the "just after start()" moment where nothing has failed yet.
    const r = await report({
      readiness: {
        state: "CORE_READY",
        settled: false,
        summary: "Core ready. Waiting on manifest.",
        components: [],
      },
    });
    assert.equal(r.checks.find((c) => c.id === "readiness")?.ok, true);
  });

  it("marks the startup check ok:true when the intent matches the registry", async () => {
    const r = await report({
      startup: { preferred: false, inSync: true, detail: "absent: not registered" },
    });
    const check = r.checks.find((c) => c.id === "startup-registration");
    assert.ok(check);
    assert.equal(check!.ok, true);
  });

  it("marks the startup check ok:false when the intent and registry disagree", async () => {
    // A startup that will not fire at logon is a real problem worth reporting through
    // the exit code, even though the current session is unaffected.
    const r = await report({
      startup: {
        preferred: true,
        inSync: false,
        detail: "absent: no Run key entry, but startOnLogin is on",
      },
    });
    const check = r.checks.find((c) => c.id === "startup-registration");
    assert.ok(check);
    assert.equal(check!.ok, false);
    assert.equal(r.ok, false, "overall doctor result must reflect the out-of-sync startup");
  });
});
