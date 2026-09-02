import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "../storage.ts";
import { JobError, JobStore } from "./jobs.ts";

describe("durable jobs", () => {
  it("checkpoints and completes without executing a tool", async () => {
    const jobs = new JobStore(new MemoryStorage());
    const job = await jobs.create({ title: "pack", workspaceId: "dev", ownerDeviceId: "pc" });
    const mid = await jobs.checkpoint(job.id, { step: 1 }, 0.5);
    assert.equal(mid.state, "checkpointed");
    const done = await jobs.complete(job.id, "packed");
    assert.equal(done.state, "done");
  });

  it("refuses secret-shaped titles and checkpoints", async () => {
    const jobs = new JobStore(new MemoryStorage());
    await assert.rejects(() => jobs.create({ title: "rotate api_key", workspaceId: "dev", ownerDeviceId: "pc" }), JobError);
    const job = await jobs.create({ title: "pack", workspaceId: "dev", ownerDeviceId: "pc" });
    await assert.rejects(() => jobs.checkpoint(job.id, { token: "abc" }, 0.1), JobError);
  });

  it("cannot complete a cancelled job", async () => {
    const jobs = new JobStore(new MemoryStorage());
    const job = await jobs.create({ title: "pack", workspaceId: "dev", ownerDeviceId: "pc" });
    await jobs.cancel(job.id);
    await assert.rejects(() => jobs.complete(job.id, "nope"), JobError);
  });
});
