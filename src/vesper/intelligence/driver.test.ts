import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testRuntime } from "../test-helpers.ts";
import { DURABLE_JOB_TASK_KIND } from "./driver.ts";

describe("durable job driver", () => {
  it("is registered on the runtime", async () => {
    const runtime = await testRuntime();
    assert.equal(runtime.taskExecutors.has(DURABLE_JOB_TASK_KIND), true);
    await runtime.stop();
  });

  it("job_create of a safe tool actually runs through the gate", async () => {
    const runtime = await testRuntime();
    const created = await runtime.tools.invoke({
      name: "job_create",
      args: {
        title: "remember the wire colour",
        tool: "memory_remember",
        toolArgs: { category: "fact", key: "job-wire", value: "copper" },
      },
      workspaceId: "general",
    });
    assert.equal(created.result?.ok, true, created.result?.summary);
    const jobId = (created.result?.data as { id?: string }).id!;
    const job = await runtime.intelligence.jobs.get(jobId);
    assert.equal(job?.state, "done", `job did not complete: ${job?.state} / ${job?.error}`);
    const hits = await runtime.memory.search("job-wire");
    assert.ok(hits.some((entry) => entry.value.includes("copper")));
    await runtime.stop();
  });

  it("a confirm-tier job waits instead of executing", async () => {
    const runtime = await testRuntime();
    const created = await runtime.tools.invoke({
      name: "job_create",
      args: { title: "write a file", tool: "fs_write", toolArgs: { path: "x.txt", content: "nope" } },
      workspaceId: "general",
    });
    assert.equal(created.result?.ok, true, created.result?.summary);
    const jobId = (created.result?.data as { id?: string }).id!;
    const job = await runtime.intelligence.jobs.get(jobId);
    assert.equal(job?.state, "waiting_confirm", job?.state);
    await runtime.stop();
  });

  it("refuses to name a never-tier tool", async () => {
    const runtime = await testRuntime();
    const created = await runtime.tools.invoke({
      name: "job_create",
      args: { title: "wipe", tool: "disk_wipe" },
      workspaceId: "general",
    });
    assert.equal(created.result?.ok, false);
    assert.match(created.result?.summary ?? "", /never-tier/);
    const jobs = await runtime.intelligence.jobs.list();
    assert.equal(jobs.length, 0);
    await runtime.stop();
  });

  it("a title-only job records a plan and does not invent a grant", async () => {
    const runtime = await testRuntime();
    const created = await runtime.tools.invoke({
      name: "job_create",
      args: { title: "think about dinner" },
      workspaceId: "general",
    });
    assert.equal(created.result?.ok, true, created.result?.summary);
    const jobId = (created.result?.data as { id?: string }).id!;
    const job = await runtime.intelligence.jobs.get(jobId);
    assert.equal(job?.state, "done");
    assert.equal(created.result?.data && (created.result.data as { executed?: boolean }).executed, false);
    await runtime.stop();
  });

  it("job_cancel stops a queued job", async () => {
    const runtime = await testRuntime();
    const created = await runtime.intelligence.jobs.create({
      title: "later",
      workspaceId: "general",
      ownerDeviceId: runtime.deviceIdentity.deviceId,
    });
    const cancelled = await runtime.tools.invoke({
      name: "job_cancel",
      args: { id: created.id },
      workspaceId: "general",
    });
    assert.equal(cancelled.result?.ok, true);
    assert.equal((await runtime.intelligence.jobs.get(created.id))?.state, "cancelled");
    await runtime.stop();
  });

  it("recoverOpenJobs re-queues a checkpointed job after restart", async () => {
    const { MemoryStorage } = await import("../storage.ts");
    const { createRuntime } = await import("../runtime.ts");
    const storage = new MemoryStorage();
    const first = await createRuntime({ storage, skipDiscovery: true });
    await first.start();
    const job = await first.intelligence.jobs.create({
      title: "resume me",
      workspaceId: "general",
      ownerDeviceId: first.deviceIdentity.deviceId,
    });
    await first.intelligence.jobs.checkpoint(job.id, { step: 1 }, 0.4);
    await first.stop();

    const second = await createRuntime({ storage, skipDiscovery: true });
    await second.start();
    const tasks = await second.taskQueue.list();
    assert.ok(
      tasks.some((task) => task.kind === DURABLE_JOB_TASK_KIND && task.args?.jobId === job.id),
      "a checkpointed job must be re-queued after restart",
    );
    await second.stop();
  });
});
