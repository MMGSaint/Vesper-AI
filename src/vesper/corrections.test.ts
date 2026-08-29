/**
 * Correction records: the store, the producer, and the decision table between them.
 *
 * The security half — that a correction can never grant authority — is in
 * security-corrections.test.ts, where the permanent gate runs it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "./storage.ts";
import { CorrectionStore } from "./corrections.ts";
import { OptimizerCorrectionProducer, judgeOptimizerExpectation } from "./correction-producer.ts";
import type { Logger } from "./logging.ts";
import type { OptimizerAdapter } from "./specialists/optimizer.ts";

function silentLog(): Logger {
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  };
  return log as unknown as Logger;
}

function newStore(storage = new MemoryStorage()) {
  return new CorrectionStore({ storage, log: silentLog() });
}

const GOOD = {
  subsystem: "optimizer" as const,
  context: "asked for a cpu profile",
  assumption: "the workload was cpu-bound",
  evidence: "telemetry showed 92% gpu utilisation",
  correction: "the workload was gpu-bound",
  outcome: "assumption_wrong" as const,
  source: { author: "specialist" as const, origin: "optimizer", external: true },
};

/** An optimizer stub whose answers a test controls exactly. */
function fakeOptimizer(input: {
  available?: boolean;
  bound?: "cpu" | "gpu" | "idle" | "unknown";
  summary?: string;
  throws?: boolean;
}): OptimizerAdapter {
  return {
    async getStatus() {
      if (input.throws) throw new Error("adapter exploded");
      return {
        available: input.available ?? true,
        mode: "mock",
        currentProfile: "balanced",
        lastAction: null,
        lastResult: null,
        performanceState: null,
        detail: input.available === false ? "Optimizer adapter is unavailable." : "ok",
      } as never;
    },
    async analyze() {
      return {
        bound: (input.bound ?? "gpu") as never,
        notes: [],
        summary: input.summary ?? `Workload is ${input.bound ?? "gpu"}-bound.`,
      };
    },
  } as unknown as OptimizerAdapter;
}

describe("a correction is a small set of facts", () => {
  it("records and reads back what was expected and what was observed", async () => {
    const store = newStore();
    const written = await store.record(GOOD);
    assert.equal(written.ok, true);

    const [record] = await store.list();
    assert.equal(record!.subsystem, "optimizer");
    assert.equal(record!.outcome, "assumption_wrong");
    assert.match(record!.assumption, /cpu-bound/);
    assert.match(record!.evidence, /92%/);
    assert.equal(record!.source.external, true);
  });

  it("survives a restart", async () => {
    const storage = new MemoryStorage();
    const first = newStore(storage);
    await first.record(GOOD);
    await first.flush();

    const second = newStore(storage);
    const records = await second.list();
    assert.equal(records.length, 1, "a learning signal that does not persist is not one");
  });

  it("counts outcomes, including the ones where Vesper was right", async () => {
    // A store that only ever admits failures gives a badly skewed picture of how often
    // Vesper is right, so "the assumption held" is a first-class outcome.
    const store = newStore();
    await store.record(GOOD);
    await store.record({ ...GOOD, outcome: "assumption_held" });
    await store.record({ ...GOOD, outcome: "inconclusive" });

    assert.deepEqual(await store.tally(), {
      assumption_wrong: 1,
      assumption_held: 1,
      inconclusive: 1,
    });
  });

  it("filters by subsystem and outcome", async () => {
    const store = newStore();
    await store.record(GOOD);
    await store.record({ ...GOOD, subsystem: "model", outcome: "assumption_held" });

    assert.equal((await store.list({ subsystem: "model" })).length, 1);
    assert.equal((await store.list({ outcome: "assumption_wrong" })).length, 1);
  });

  it("refuses a record with an empty field", async () => {
    const store = newStore();
    for (const field of ["context", "assumption", "evidence", "correction"] as const) {
      const result = await store.record({ ...GOOD, [field]: "  " });
      assert.equal(result.ok, false, `empty ${field} must be refused`);
    }
    assert.deepEqual(await store.list(), []);
  });

  it("refuses an unknown subsystem or outcome rather than storing it", async () => {
    // Validated at the boundary so a tally can never be skewed by a record filed
    // against something that does not exist.
    const store = newStore();
    assert.equal((await store.record({ ...GOOD, subsystem: "nexus" as never })).ok, false);
    assert.equal((await store.record({ ...GOOD, outcome: "probably" as never })).ok, false);
  });

  it("bounds how much it retains", async () => {
    const store = new CorrectionStore({
      storage: new MemoryStorage(),
      log: silentLog(),
      maxRetained: 10,
    });
    for (let i = 0; i < 25; i += 1) {
      await store.record({ ...GOOD, context: `run ${i}` });
    }
    const all = await store.list({ limit: 200 });
    assert.equal(all.length, 10, "retention must be bounded");
    assert.match(all.at(-1)!.context, /run 24/, "the newest survive");
  });

  it("survives a corrupt blob without losing availability", async () => {
    const storage = new MemoryStorage({ "corrections.records": "not an array" as never });
    const store = newStore(storage);
    assert.deepEqual(await store.list(), []);
    assert.equal((await store.record(GOOD)).ok, true, "a fresh record must still work");
  });

  it("drops a planted record whose subsystem or outcome is unrecognised", async () => {
    // The blob lives in the shared state file. Validating only on the way in leaves a
    // corrupted entry free to skew every tally that reads it.
    const storage = new MemoryStorage({
      "corrections.records": [
        { ...GOOD, id: "cor_1", at: "2026-01-01T00:00:00Z" },
        { ...GOOD, id: "cor_2", at: "2026-01-01T00:00:00Z", subsystem: "made-up" },
        { ...GOOD, id: "cor_3", at: "2026-01-01T00:00:00Z", outcome: "made-up" },
      ] as never,
    });
    const store = newStore(storage);
    const records = await store.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.id, "cor_1");
  });
});

describe("the producer judges an expectation against an observation", () => {
  it("records that the assumption was wrong when the bottleneck differs", async () => {
    // The mission's worked example: Vesper expected cpu, NEXUS reported gpu.
    const store = newStore();
    const producer = new OptimizerCorrectionProducer({
      optimizer: fakeOptimizer({ bound: "gpu", summary: "Workload is gpu-bound." }),
      corrections: store,
    });

    producer.expect({
      profile: "cpu-boost",
      expectedBound: "cpu",
      because: "the last reading looked cpu-heavy",
      accepted: true,
    });
    const outcome = await producer.observe();

    assert.equal(outcome?.outcome, "assumption_wrong");
    assert.equal(outcome?.recorded, true);
    const [record] = await store.list();
    assert.match(record!.correction, /gpu-bound, not cpu-bound/);
    assert.equal(record!.source.author, "specialist", "the evidence came from a system Vesper does not control");
  });

  it("records that the assumption held when it did", async () => {
    const store = newStore();
    const producer = new OptimizerCorrectionProducer({
      optimizer: fakeOptimizer({ bound: "cpu" }),
      corrections: store,
    });
    producer.expect({ profile: "cpu-boost", expectedBound: "cpu", because: "x", accepted: true });

    assert.equal((await producer.observe())?.outcome, "assumption_held");
  });

  it("is inconclusive when the optimizer never accepted the request", async () => {
    // Recording "the profile change did not help" when the profile never changed would
    // invent both the action and its outcome.
    const store = newStore();
    const producer = new OptimizerCorrectionProducer({
      optimizer: fakeOptimizer({ bound: "gpu" }),
      corrections: store,
    });
    producer.expect({ profile: "cpu-boost", expectedBound: "cpu", because: "x", accepted: false });

    const outcome = await producer.observe();
    assert.equal(outcome?.outcome, "inconclusive");
    const [record] = await store.list();
    assert.match(record!.correction, /did not accept/);
  });

  it("is inconclusive when the optimizer is unavailable", async () => {
    const store = newStore();
    const producer = new OptimizerCorrectionProducer({
      optimizer: fakeOptimizer({ available: false }),
      corrections: store,
    });
    producer.expect({ profile: "p", expectedBound: "cpu", because: "x", accepted: true });

    assert.equal((await producer.observe())?.outcome, "inconclusive");
  });

  it("is inconclusive when the adapter throws, rather than assuming agreement", async () => {
    // A failed probe is an observation Vesper could not make. Treating it as agreement
    // would manufacture evidence.
    const store = newStore();
    const producer = new OptimizerCorrectionProducer({
      optimizer: fakeOptimizer({ throws: true }),
      corrections: store,
    });
    producer.expect({ profile: "p", expectedBound: "cpu", because: "x", accepted: true });

    const outcome = await producer.observe();
    assert.equal(outcome?.outcome, "inconclusive");
    const [record] = await store.list();
    assert.match(record!.evidence, /failed/i);
  });

  it("does nothing when no expectation is pending", async () => {
    const store = newStore();
    const producer = new OptimizerCorrectionProducer({
      optimizer: fakeOptimizer({}),
      corrections: store,
    });
    assert.equal(await producer.observe(), null);
    assert.deepEqual(await store.list(), []);
  });

  it("clears the expectation even when the store refuses the record", async () => {
    // Otherwise a refused record leaves the producer re-filing the same one forever.
    const store = newStore();
    const producer = new OptimizerCorrectionProducer({
      optimizer: fakeOptimizer({ bound: "gpu" }),
      corrections: store,
    });
    producer.expect({
      profile: "p",
      expectedBound: "cpu",
      // An empty `because` makes the context empty, which the store refuses.
      because: "",
      accepted: true,
    });

    const first = await producer.observe();
    assert.equal(first?.recorded, true, "the context is still non-empty prose around the empty reason");
    assert.equal(producer.hasPending(), false, "the expectation must be consumed either way");
  });

  it("covers the whole decision table exhaustively", () => {
    const base = { profile: "p", expectedBound: "cpu" as const, because: "x", accepted: true };
    const cases: Array<[Parameters<typeof judgeOptimizerExpectation>[0], string]> = [
      [{ expectation: base, observedBound: "cpu", optimizerAvailable: true }, "assumption_held"],
      [{ expectation: base, observedBound: "gpu", optimizerAvailable: true }, "assumption_wrong"],
      [{ expectation: base, observedBound: "idle", optimizerAvailable: true }, "assumption_wrong"],
      [{ expectation: base, observedBound: "unknown", optimizerAvailable: true }, "inconclusive"],
      [{ expectation: base, observedBound: "cpu", optimizerAvailable: false }, "inconclusive"],
      [
        { expectation: { ...base, accepted: false }, observedBound: "cpu", optimizerAvailable: true },
        "inconclusive",
      ],
    ];
    for (const [input, expected] of cases) {
      assert.equal(
        judgeOptimizerExpectation(input).outcome,
        expected,
        `${JSON.stringify({ b: input.observedBound, a: input.optimizerAvailable, ac: input.expectation.accepted })}`,
      );
    }
  });
});
