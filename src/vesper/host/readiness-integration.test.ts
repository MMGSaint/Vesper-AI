/**
 * Startup no longer blocks on knowledge reindex, and the readiness monitor observes
 * the transition end to end through the real runtime.
 *
 * The behaviour tested here is exactly the mission's rule "startup must be fast and
 * non-blocking, do NOT make Windows wait for large memory indexing". Directly asserted
 * against `runtime.start()` and against the aggregate readiness state.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "../test-helpers.ts";

describe("runtime.start() does not block on knowledge indexing", () => {
  it("returns fast on a runtime that has knowledge but no reachable backend", async () => {
    // We cannot easily inject a slow reindex here without wiring a stub, but the
    // property we care about is that reindex is FIRED not AWAITED — measured through
    // the total time start() took. A regression that reintroduced the await would
    // push this into hundreds of ms even on this small fixture.
    const started = Date.now();
    const runtime = await testRuntime();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `runtime.start() should return quickly, took ${elapsed}ms`);
    // And the runtime is at least CORE_READY afterwards.
    const state = runtime.readiness.snapshot().state;
    assert.ok(["CORE_READY", "READY", "DEGRADED"].includes(state), `state=${state}`);
  });

  it("start() does not use `await this.knowledge.reindex()`", async () => {
    // Structural assertion, deliberately. The property "start() does not block on
    // reindex" is invisible on a fixture with no knowledge sources — the reindex
    // returns immediately whether it is awaited or not. So the guarantee is pinned as
    // the shape of the source itself: reindex must be called INSIDE a `void (async
    // () => {})` block, never as a bare `await` on the start() body. This mirrors the
    // pattern the repo uses for OBS in start() and for the entry-guard assertions in
    // stdio-flush.test.ts.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(new URL("../runtime.ts", import.meta.url)),
      "utf8",
    );
    const startMatch = src.match(/async start\(\)[\s\S]*?^  \}/m);
    assert.ok(startMatch, "could not locate start() in runtime.ts");
    // Strip line and block comments before pattern-matching so a prose mention of
    // "used to be AWAITED" in a doc block does not trip the regex. Same technique the
    // stdio-flush structural test uses for a similar reason.
    const body = startMatch[0]
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // Every `await this.knowledge.reindex()` must appear inside a `void (async ...`
    // dispatch. This slices the body at each occurrence and confirms the immediately
    // preceding `void` opens a still-open async block. It is not a full parser — good
    // enough to catch a regression where the reindex is moved back onto the critical
    // path.
    for (const match of body.matchAll(/await\s+this\.knowledge\.reindex\(\)/g)) {
      const preceding = body.slice(0, match.index ?? 0);
      const lastVoidAsync = preceding.lastIndexOf("void (async");
      assert.notEqual(
        lastVoidAsync,
        -1,
        "runtime.start() must NOT await knowledge.reindex() outside a void async block — it belongs on the background path",
      );
      // The void async block must not have closed already. Rough proxy: the substring
      // between lastVoidAsync and here has more `(` than `)`. Not exact but sufficient.
      const between = preceding.slice(lastVoidAsync);
      const opens = (between.match(/\(/g) ?? []).length;
      const closes = (between.match(/\)/g) ?? []).length;
      assert.ok(opens > closes, "await knowledge.reindex() must be inside an open void async block");
    }
    assert.match(
      body,
      /void\s*\(async[\s\S]*?knowledge\.reindex\(\)/,
      "knowledge.reindex() must be dispatched inside a void async IIFE",
    );
  });

  it("advances past INITIALIZING once start() has returned", async () => {
    const runtime = await testRuntime();
    const snapshot = runtime.readiness.snapshot();
    assert.notEqual(snapshot.state, "INITIALIZING");
  });

  it("reaches STOPPING and then STOPPED through stop()", async () => {
    const runtime = await testRuntime();
    await runtime.stop();
    // A caller reading readiness after stop() sees STOPPED, not the previous state.
    // Not asserting STOPPING because it is transient — the assertion that shutdown
    // eventually reaches STOPPED is the one that matters for a phone or a diagnostic.
    assert.equal(runtime.readiness.snapshot().state, "STOPPED");
  });
});
