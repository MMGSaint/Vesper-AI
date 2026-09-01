/**
 * The executor that fires a reminder when it comes due.
 *
 * `tool_call` is the other scheduled kind: it runs a tool through the authorization
 * chain. A reminder is deliberately not that. It writes a notification and an event,
 * and it stops. `task.args.tool` is ignored even if present — a persisted task record
 * is attacker-influenceable, and letting a reminder become a tool call by stuffing a
 * name into args would be a side door around `createToolCallExecutor`'s origin and
 * confirm-tier refusals.
 *
 * The scheduler, not this file, is what waits. This executor is only invoked once
 * `dueAt` has passed (or was never set). A reminder with no dueAt is due immediately,
 * which is how `task_create` with `inSeconds: 0` behaves.
 */

import { sanitiseInline } from "./untrusted.ts";
import type { NotificationHub } from "./notifications.ts";
import type { EventBus } from "./events.ts";
import type { TaskExecutor, TaskExecutionResult } from "./task-scheduler.ts";
import type { VesperTask } from "./distributed/tasks.ts";

/** The registered kind. Shared so a typo cannot silently produce an unrunnable task. */
export const REMINDER_TASK_KIND = "reminder";

export interface ReminderExecutorDeps {
  notifications: NotificationHub;
  events: EventBus;
  /**
   * Host toast dispatch. Optional so a runtime without a Windows adapter still records
   * the reminder in the hub. The return is *dispatch*, never delivery — same honesty
   * as the host adapter itself.
   */
  notifyHost?: (title: string, body: string) => { ok: boolean; summary: string };
}

function reminderBody(task: VesperTask): string {
  const raw = task.args;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.message === "string") {
    return sanitiseInline(raw.message, 300);
  }
  return sanitiseInline(task.description, 300);
}

/**
 * Build the executor. Dependencies are captured in a closure, same reason as the
 * tool-call executor: the task record must not be able to name a different hub.
 */
export function createReminderExecutor(deps: ReminderExecutorDeps): TaskExecutor {
  return async function reminderExecutor(task, ctx): Promise<TaskExecutionResult> {
    if (ctx.signal.aborted) {
      return { ok: false, summary: "The runtime is shutting down; the reminder was not delivered." };
    }

    const title = sanitiseInline(task.description, 80) || "Reminder";
    const body = reminderBody(task) || title;

    const sent = deps.notifications.push({
      kind: "info",
      author: "subsystem",
      title,
      body,
      cooldownKey: `reminder:${task.id}`,
    });

    let hostSummary: string | undefined;
    if (deps.notifyHost) {
      try {
        hostSummary = deps.notifyHost(title, body).summary;
      } catch (error) {
        hostSummary = error instanceof Error ? error.message : String(error);
      }
    }

    deps.events.emit({
      type: "task.reminder",
      title: `Reminder: ${title}`,
      detail: body,
      severity: "info",
      retention: "durable",
      provenance: { author: "subsystem", source: "reminder-executor" },
      data: { taskId: task.id, delivered: Boolean(sent) },
    });

    return {
      ok: true,
      summary: sent
        ? (hostSummary ?? `Reminder delivered: ${title}`)
        : `Reminder recorded (notifications disabled or cooled down): ${title}`,
      data: {
        title,
        delivered: Boolean(sent),
        // Deliberately not echoing args.tool or any other extra key. A reminder
        // that ran a tool would be a bug; the test asserts the file was not written.
      },
    };
  };
}
