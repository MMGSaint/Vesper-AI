/**
 * The executor that turns a durable job into work.
 *
 * A job record is not a tool call. This module is the missing half: it picks the
 * job up through TaskScheduler, checkpoints a deterministic-first plan, and only
 * then may invoke a tool — through ToolRegistry.invoke, under a scheduled origin,
 * never confirming itself, never naming a never-tier tool.
 *
 *   job_create → TaskQueue(durable_job) → scheduler → this executor
 *             → plan / checkpoint → tools.invoke → complete | wait_confirm | fail
 *
 * The same three rules as tool-executor.ts apply, plus one more:
 *
 * 1. Never call a handler directly.
 * 2. Never choose an origin from the job or task record.
 * 3. Never set confirmed: true.
 * 4. A title is not a grant. Matching a confirm-tier or never-tier tool from a
 *    title pauses or fails the job; it does not run it.
 */

import type { ToolRegistry } from "../tools/registry.ts";
import type { RequestOrigin } from "../tools/remote.ts";
import type { TaskExecutor, TaskExecutionResult } from "../task-scheduler.ts";
import type { JsonObject } from "../types.ts";
import type { VesperTask } from "../distributed/tasks.ts";
import type { ProcedureStore } from "../procedures.ts";
import type { SkillRegistry } from "../skills.ts";
import type { EventBus } from "../events.ts";
import type { NotificationHub } from "../notifications.ts";
import type { TaskQueue } from "../distributed/tasks.ts";
import { planExecution, type RoutePlan } from "./route.ts";
import { JobError, type JobStore } from "./jobs.ts";

export const DURABLE_JOB_TASK_KIND = "durable_job";

const SCHEDULED_ORIGIN: RequestOrigin = Object.freeze({ kind: "scheduled" as const });

export interface JobExecutorDeps {
  jobs: JobStore;
  tools: ToolRegistry;
  procedures?: ProcedureStore;
  skills?: SkillRegistry;
  events: EventBus;
  notifications: NotificationHub;
  workspaceId: () => string;
}

interface JobTaskArgs {
  jobId: string;
  tool?: string;
  args: JsonObject;
}

function readJobArgs(task: VesperTask): JobTaskArgs | { error: string } {
  const raw = task.args;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "a durable_job task needs args naming the job to run" };
  }
  const jobId = raw.jobId;
  if (typeof jobId !== "string" || jobId.length === 0) {
    return { error: "a durable_job task needs args.jobId" };
  }
  const tool = raw.tool;
  if (tool !== undefined && (typeof tool !== "string" || tool.length === 0)) {
    return { error: "args.tool must be a non-empty tool name when present" };
  }
  const inner = raw.args;
  if (inner !== undefined && (typeof inner !== "object" || inner === null || Array.isArray(inner))) {
    return { error: "args.args must be an object when present" };
  }
  return { jobId, tool: typeof tool === "string" ? tool : undefined, args: (inner as JsonObject | undefined) ?? {} };
}

export function createJobExecutor(deps: JobExecutorDeps): TaskExecutor {
  return async function durableJobExecutor(task, ctx): Promise<TaskExecutionResult> {
    const parsed = readJobArgs(task);
    if ("error" in parsed) {
      return { ok: false, summary: parsed.error, retryable: false };
    }
    if (ctx.signal.aborted) {
      return { ok: false, summary: "The runtime is shutting down; the job was not started." };
    }

    const job = await deps.jobs.get(parsed.jobId);
    if (!job) return { ok: false, summary: "Unknown job.", retryable: false };
    if (job.state === "cancelled") {
      return { ok: true, summary: `Job '${job.title}' was cancelled.` };
    }
    if (job.state === "done") {
      return { ok: true, summary: job.summary ?? `Job '${job.title}' already finished.` };
    }
    if (job.state === "failed") {
      return { ok: false, summary: job.error ?? `Job '${job.title}' already failed.`, retryable: false };
    }
    if (job.state === "waiting_confirm") {
      return {
        ok: false,
        summary: `Job '${job.title}' is waiting for a person at the keyboard.`,
        retryable: false,
        data: { jobId: job.id, state: job.state },
      };
    }

    try {
      await deps.jobs.start(parsed.jobId);
    } catch (error) {
      return {
        ok: false,
        summary: error instanceof JobError ? error.message : String(error),
        retryable: false,
      };
    }

    const workspaceId =
      typeof task.workspaceId === "string" && task.workspaceId
        ? task.workspaceId
        : job.workspaceId || deps.workspaceId();

    const catalog = {
      procedures: deps.procedures ? await deps.procedures.list({ workspaceId }) : [],
      skills: deps.skills ? await deps.skills.list() : [],
      tools: deps.tools.list(workspaceId).map((tool) => ({
        name: tool.name,
        permission: tool.permission,
      })),
    };
    const plan = planExecution({ intent: parsed.tool ? parsed.tool.replaceAll("_", " ") : job.title, catalog });
    const checkpoint: JsonObject = {
      plan: { step: plan.step, name: plan.name, reason: plan.reason, executed: false },
      tool: parsed.tool ?? null,
    };
    await deps.jobs.checkpoint(parsed.jobId, checkpoint, 0.2);

    const named = parsed.tool;
    if (named) {
      return invokeNamed(deps, parsed.jobId, named, parsed.args, workspaceId, plan);
    }

    if (plan.step === "procedure") {
      return runProcedureSteps(deps, parsed.jobId, plan, workspaceId);
    }

    if (plan.step === "tool") {
      const spec = deps.tools.get(plan.name)?.spec;
      const level = spec?.permission ?? plan.permissionCeiling;
      if (level === "never") {
        await deps.jobs.fail(parsed.jobId, "A job cannot run a never-tier tool.");
        return { ok: false, summary: "A job cannot run a never-tier tool.", retryable: false };
      }
      if (level === "confirm") {
        await deps.jobs.waitConfirm(parsed.jobId, { ...checkpoint, tool: plan.name, reason: "confirm-tier" });
        notifyWaiting(deps, job.title, plan.name);
        return {
          ok: false,
          summary: `'${plan.name}' needs a person at the keyboard. The job is waiting.`,
          retryable: false,
          data: { jobId: parsed.jobId, state: "waiting_confirm", tool: plan.name },
        };
      }
      return invokeNamed(deps, parsed.jobId, plan.name, {}, workspaceId, plan);
    }

    await deps.jobs.complete(
      parsed.jobId,
      plan.step === "skill"
        ? `Skill '${plan.name}' matches. Not executed — enabling a skill is not a grant.`
        : "Plan recorded. Nothing executed; no deterministic tool or procedure matched.",
    );
    return {
      ok: true,
      summary: `Job '${job.title}' checkpointed a ${plan.step} plan without executing tools.`,
      data: { jobId: parsed.jobId, executed: false, step: plan.step },
    };
  };
}

async function runProcedureSteps(
  deps: JobExecutorDeps,
  jobId: string,
  plan: RoutePlan,
  workspaceId: string,
): Promise<TaskExecutionResult> {
  const procedures = deps.procedures ? await deps.procedures.list({ workspaceId, state: "active" }) : [];
  const procedure = procedures.find((item) => item.name === plan.name);
  if (!procedure) {
    await deps.jobs.complete(jobId, `Procedure '${plan.name}' was planned but is no longer active.`);
    return { ok: true, summary: `Procedure '${plan.name}' was not executed.`, data: { executed: false } };
  }

  const summaries: string[] = [];
  for (const step of procedure.steps) {
    if (!step.toolName) {
      summaries.push(step.instruction);
      continue;
    }
    const spec = deps.tools.get(step.toolName)?.spec;
    const level = spec?.permission ?? step.permission;
    if (level === "never") {
      await deps.jobs.fail(jobId, `Procedure step names never-tier tool '${step.toolName}'.`);
      return { ok: false, summary: `Refused never-tier tool '${step.toolName}'.`, retryable: false };
    }
    if (level === "confirm") {
      await deps.jobs.waitConfirm(jobId, {
        plan: { step: plan.step, name: plan.name, executed: false },
        tool: step.toolName,
        reason: "confirm-tier procedure step",
      });
      notifyWaiting(deps, procedure.name, step.toolName);
      return {
        ok: false,
        summary: `Procedure '${procedure.name}' paused on confirm-tier '${step.toolName}'.`,
        retryable: false,
        data: { jobId, state: "waiting_confirm", tool: step.toolName },
      };
    }
    const result = await invokeNamed(deps, jobId, step.toolName, {}, workspaceId, plan, {
      settle: false,
    });
    if (!result.ok) return result;
    summaries.push(result.summary);
  }

  await deps.jobs.complete(jobId, summaries.join("; ").slice(0, 400) || `Procedure '${procedure.name}' finished.`);
  return {
    ok: true,
    summary: `Job completed procedure '${procedure.name}'.`,
    data: { jobId, executed: true, step: "procedure" },
  };
}

async function invokeNamed(
  deps: JobExecutorDeps,
  jobId: string,
  tool: string,
  args: JsonObject,
  workspaceId: string,
  plan: RoutePlan,
  options: { settle?: boolean } = {},
): Promise<TaskExecutionResult> {
  const settle = options.settle !== false;
  const spec = deps.tools.get(tool)?.spec;
  if (!spec) {
    if (settle) await deps.jobs.fail(jobId, `Unknown tool '${tool}'.`);
    return { ok: false, summary: `Unknown tool '${tool}'.`, retryable: false };
  }
  if (spec.permission === "never") {
    await deps.jobs.fail(jobId, "A job cannot run a never-tier tool.");
    return { ok: false, summary: "A job cannot run a never-tier tool.", retryable: false };
  }
  if (spec.permission === "confirm") {
    await deps.jobs.waitConfirm(jobId, {
      plan: { step: plan.step, name: plan.name, executed: false },
      tool,
      reason: "confirm-tier",
    });
    notifyWaiting(deps, tool, tool);
    return {
      ok: false,
      summary: `'${tool}' needs a person at the keyboard. The job is waiting.`,
      retryable: false,
      data: { jobId, state: "waiting_confirm", tool },
    };
  }

  const call = await deps.tools.invoke({
    name: tool,
    args,
    workspaceId,
    origin: SCHEDULED_ORIGIN,
  });

  if (call.confirmationId) {
    await deps.jobs.waitConfirm(jobId, {
      plan: { step: plan.step, name: plan.name, executed: false },
      tool,
      confirmationId: call.confirmationId,
    });
    return {
      ok: false,
      summary: `'${tool}' is waiting for confirmation and a scheduled job cannot give it.`,
      retryable: false,
      data: { jobId, tool, confirmationId: call.confirmationId },
    };
  }

  const result = call.result;
  if (!result?.ok) {
    const refused = call.decision.allowed === false || call.decision.level === "never";
    await deps.jobs.fail(jobId, result?.summary ?? `'${tool}' was refused.`);
    return {
      ok: false,
      summary: result?.summary ?? `'${tool}' was refused.`,
      retryable: !refused,
      data: { jobId, tool, refused },
    };
  }

  if (settle) {
    await deps.jobs.complete(jobId, result.summary.slice(0, 400));
    deps.events.emit({
      type: "job.completed",
      title: `Job finished via ${tool}`,
      detail: result.summary,
      severity: "info",
      retention: "durable",
      provenance: { author: "subsystem", source: "job-executor" },
    });
  }
  return {
    ok: true,
    summary: result.summary,
    data: { jobId, tool, executed: true, level: call.decision.level },
  };
}

function notifyWaiting(deps: JobExecutorDeps, title: string, tool: string): void {
  deps.notifications.push({
    kind: "info",
    author: "subsystem",
    title: "Job waiting for confirmation",
    body: `'${title}' paused on ${tool}. A person at the keyboard has to approve it.`,
    cooldownKey: `job-confirm:${tool}`,
  });
}

/**
 * After a restart, re-queue work for jobs that were mid-flight. Waiting-confirm
 * stays paused: a crash is not a person at the keyboard.
 */
export async function recoverOpenJobs(input: {
  jobs: JobStore;
  tasks: TaskQueue;
  deviceId: string;
}): Promise<number> {
  const open = await input.jobs.recoverOpen();
  if (!open.length) return 0;
  const existing = await input.tasks.list();
  let queued = 0;
  for (const job of open) {
    const live = existing.some((task) => {
      if (task.kind !== DURABLE_JOB_TASK_KIND) return false;
      const args = task.args;
      if (!args || typeof args !== "object" || Array.isArray(args)) return false;
      if (args.jobId !== job.id) return false;
      return task.state !== "done" && task.state !== "failed" && task.state !== "cancelled";
    });
    if (live) continue;
    const checkpoint = job.checkpoint ?? {};
    const tool = typeof checkpoint.tool === "string" && checkpoint.tool.length ? checkpoint.tool : undefined;
    const inner =
      checkpoint.args && typeof checkpoint.args === "object" && !Array.isArray(checkpoint.args)
        ? (checkpoint.args as JsonObject)
        : {};
    await input.tasks.create({
      description: `Resume job: ${job.title}`,
      createdBy: input.deviceId,
      kind: DURABLE_JOB_TASK_KIND,
      args: tool ? { jobId: job.id, tool, args: inner } : { jobId: job.id },
      workspaceId: job.workspaceId,
      preferredDevice: input.deviceId,
      eligibleDevices: [input.deviceId],
      idempotent: false,
    });
    queued += 1;
  }
  return queued;
}

