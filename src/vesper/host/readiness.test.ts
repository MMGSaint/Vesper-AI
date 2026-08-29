/**
 * Readiness monitor: what a caller can trust, and what it cannot mistake for authority.
 *
 * The rule the mission gives: "do not infer readiness merely because the process
 * exists." These tests enforce it as the shape of the state machine — every claim of
 * readiness has to be justified by an observation, and no observation can pull the
 * runtime backwards toward "initializing" once it has stopped.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReadinessMonitor } from "./readiness.ts";

function newMonitor() {
  return new ReadinessMonitor({
    components: [
      { id: "model", description: "local model backend", optional: true },
      { id: "manifest", description: "capability manifest", optional: false },
      { id: "knowledge", description: "knowledge index", optional: true },
    ],
  });
}

describe("the aggregate state is derived from observations, not assumed", () => {
  it("starts in INITIALIZING with every component pending", () => {
    const m = newMonitor();
    const snapshot = m.snapshot();
    assert.equal(snapshot.state, "INITIALIZING");
    assert.equal(snapshot.settled, false);
    assert.ok(snapshot.components.every((c) => c.state === "pending"));
  });

  it("does not reach READY just because CORE_READY was declared", () => {
    // start() returning does not mean the manifest is refreshed or the backend has
    // been probed. A caller that reads CORE_READY and treats it as READY has silently
    // lost the honest three-state distinction the mission calls for.
    const m = newMonitor();
    m.advanceTo("CORE_READY");
    assert.equal(m.snapshot().state, "CORE_READY");
    assert.equal(m.snapshot().settled, false);
  });

  it("reaches READY once every component has answered without problems", () => {
    const m = newMonitor();
    m.advanceTo("CORE_READY");
    m.markComponent("model", "ready", "ollama answered");
    m.markComponent("manifest", "ready", "manifest refreshed");
    m.markComponent("knowledge", "ready", "0 sources");
    const snapshot = m.snapshot();
    assert.equal(snapshot.state, "READY");
    assert.equal(snapshot.settled, true);
  });

  it("reaches DEGRADED when an optional component reports degraded", () => {
    const m = newMonitor();
    m.advanceTo("CORE_READY");
    m.markComponent("model", "degraded", "no backend reachable");
    m.markComponent("manifest", "ready", "refreshed");
    m.markComponent("knowledge", "ready", "0 sources");
    assert.equal(m.snapshot().state, "DEGRADED");
    assert.equal(m.snapshot().settled, true, "DEGRADED is a settled state, not a wait");
  });

  it("reaches DEGRADED (not FAILED) when a non-optional component fails", () => {
    // FAILED is reserved for a runtime that cannot serve any request. A refresh failure
    // on the manifest leaves the runtime running with a stale manifest — degradation,
    // not failure. Only `advanceTo("FAILED")` from the outside means truly dead.
    const m = newMonitor();
    m.advanceTo("CORE_READY");
    m.markComponent("model", "ready", "ok");
    m.markComponent("manifest", "failed", "refresh threw");
    m.markComponent("knowledge", "ready", "0 sources");
    assert.equal(m.snapshot().state, "DEGRADED");
  });
});

describe("the state machine never regresses", () => {
  it("does not move backwards from CORE_READY to INITIALIZING", () => {
    const m = newMonitor();
    m.advanceTo("CORE_READY");
    m.advanceTo("INITIALIZING");
    assert.equal(m.snapshot().state, "CORE_READY");
  });

  it("a pending mark after settle does not pull the state back", () => {
    const m = newMonitor();
    m.advanceTo("CORE_READY");
    for (const id of ["model", "manifest", "knowledge"]) m.markComponent(id, "ready", "ok");
    assert.equal(m.snapshot().state, "READY");
    m.markComponent("model", "pending", "reprobe scheduled");
    // Reevaluate leaves the state alone rather than regressing to CORE_READY: an
    // in-flight recheck must not tell a phone "we are not ready".
    assert.equal(m.snapshot().state, "READY");
  });

  it("SHUTDOWN states always win", () => {
    const m = newMonitor();
    m.advanceTo("CORE_READY");
    m.advanceTo("STOPPING");
    m.advanceTo("READY");
    assert.equal(m.snapshot().state, "STOPPING");
    m.advanceTo("STOPPED");
    assert.equal(m.snapshot().state, "STOPPED");
    // Stopped stays stopped even against a later mark.
    m.markComponent("model", "ready", "ok");
    assert.equal(m.snapshot().state, "STOPPED");
  });
});

describe("the summary reads honestly", () => {
  it("names the pending components before settle", () => {
    const m = newMonitor();
    m.advanceTo("CORE_READY");
    m.markComponent("model", "ready", "ok");
    assert.match(m.snapshot().summary, /manifest|knowledge/);
  });

  it("names the degraded components after settle", () => {
    const m = newMonitor();
    m.advanceTo("CORE_READY");
    m.markComponent("model", "degraded", "no backend reachable");
    m.markComponent("manifest", "ready", "ok");
    m.markComponent("knowledge", "ready", "ok");
    assert.match(m.snapshot().summary, /model degraded/);
  });
});

describe("readiness cannot become authority", () => {
  it("imports nothing that would let it decide a permission", async () => {
    // Structural assertion, deliberately. A state machine that could reach into the
    // permission gate could raise it by moving to READY, which is precisely the shape
    // of defect the "no readiness authority" rule forbids.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("./readiness.ts", import.meta.url), "utf8");
    // Scan only actual import statements, not prose in the file's own header comment
    // that names the same modules as forbidden.
    const importLines = src
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line));
    const imports = importLines.join("\n");
    for (const forbidden of [
      "permissions.ts",
      "autonomy.ts",
      "distributed/registry.ts",
      "tools/registry.ts",
      "tools/remote.ts",
    ]) {
      assert.ok(
        !imports.includes(forbidden),
        `readiness.ts must not import ${forbidden}: import lines are\n${imports}`,
      );
    }
  });
});
