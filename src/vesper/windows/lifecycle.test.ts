/**
 * Shutdown: bounded, isolated, and observably honest.
 *
 * A hook that wedges must not hold the process on logoff, a hook that throws must not
 * prevent later hooks from running, and every failure must reach the caller as a real
 * error rather than being swallowed. All three used to be gaps.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLifecycleController,
  DEFAULT_SHUTDOWN_HOOK_TIMEOUT_MS,
} from "./lifecycle.ts";
import type { VesperDirs } from "../types.ts";

async function dirs(): Promise<VesperDirs> {
  const root = await mkdtemp(join(tmpdir(), "vesper-lifecycle-"));
  return {
    root,
    config: join(root, "config"),
    data: join(root, "data"),
    logs: join(root, "logs"),
    models: join(root, "models"),
  };
}

describe("shutdown runs every hook even when one throws", () => {
  it("collects errors and continues", async () => {
    const life = createLifecycleController({
      dirs: await dirs(),
      writeHealth: async () => undefined,
    });
    const ran: string[] = [];
    life.addHook({ name: "first", run: () => void ran.push("first") });
    life.addHook({
      name: "second-throws",
      run: () => {
        ran.push("second");
        throw new Error("boom");
      },
    });
    life.addHook({ name: "third", run: () => void ran.push("third") });

    const outcome = await life.shutdown("test");

    assert.deepEqual(ran, ["first", "second", "third"], "every hook must have run");
    assert.equal(outcome.ok, false);
    assert.ok(outcome.errors.some((e) => e.includes("second-throws")));
  });
});

describe("shutdown is bounded per hook", () => {
  it("moves past a hook that overshoots its budget rather than hanging forever", async () => {
    // The hook itself keeps running — we cannot cancel a promise it did not co-operate
    // to make cancellable — but shutdown does not wait on it, and the outcome names
    // the timeout honestly rather than reporting success.
    const life = createLifecycleController({
      dirs: await dirs(),
      writeHealth: async () => undefined,
    });
    // The hook must outlive the shutdown budget but must eventually resolve, or the
    // test runner records a pending Promise and cancels the whole suite ("Promise
    // resolution is still pending but the event loop has already resolved"). Wire an
    // external resolver so the test can release the hook after the budget check.
    const releaseWedgedRef: { fn: null | (() => void) } = { fn: null };
    life.addHook({
      name: "wedged",
      timeoutMs: 40,
      run: () =>
        new Promise<void>((resolve) => {
          releaseWedgedRef.fn = resolve;
        }),
    });
    life.addHook({
      name: "after-wedged",
      run: async () => undefined,
    });

    const started = Date.now();
    const outcome = await life.shutdown("test");
    const elapsed = Date.now() - started;
    releaseWedgedRef.fn?.();

    assert.ok(elapsed < 5000, `shutdown must not hang: took ${elapsed}ms`);
    assert.equal(outcome.ok, false);
    assert.ok(
      outcome.errors.some((e) => e.includes("wedged") && e.includes("40ms")),
      `timeout error missing: ${outcome.errors.join("; ")}`,
    );
  });

  it("uses a sensible default budget when the hook does not name one", () => {
    // Documented as a constant rather than magic in every hook. A machine at logoff
    // has minutes, not seconds; a single wedged hook exhausting all of that would be a
    // regression felt by the person shutting down their PC.
    assert.equal(DEFAULT_SHUTDOWN_HOOK_TIMEOUT_MS, 5000);
  });
});

describe("shutdown is idempotent", () => {
  it("a second call returns 'already in progress' without re-running hooks", async () => {
    const life = createLifecycleController({
      dirs: await dirs(),
      writeHealth: async () => undefined,
    });
    let ran = 0;
    life.addHook({ name: "count", run: () => void (ran += 1) });

    const first = await life.shutdown("first");
    const second = await life.shutdown("second");

    assert.equal(ran, 1, "the hook must run exactly once");
    assert.equal(first.ok, true);
    assert.match(second.summary, /already in progress/i);
  });
});
