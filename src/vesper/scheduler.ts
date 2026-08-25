import type { EventBus } from "./events.ts";
import type { Logger } from "./logging.ts";
import type { BackgroundState } from "./types.ts";
import { nowIso } from "./id.ts";

export interface SchedulerStatus {
  enabled: boolean;
  paused: boolean;
  lastTickAt: string | null;
  ticks: number;
  skippedForGaming: number;
  idleIntervalMs: number;
  gamingThrottle: boolean;
}

export interface IdleScheduler {
  status(): SchedulerStatus;
  start(): void;
  stop(): void;
  tick(now?: number): Promise<{ ran: boolean; reason: string }>;
}

export function createIdleScheduler(input: {
  events: EventBus;
  log: Logger;
  intervalMs?: number;
  state: () => BackgroundState;
  isGamingHeavy?: () => boolean;
  onTick?: () => Promise<void> | void;
}): IdleScheduler {
  const idleIntervalMs = input.intervalMs ?? 30_000;
  let enabled = false;
  let lastTickAt: string | null = null;
  let ticks = 0;
  let skippedForGaming = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(_now?: number): Promise<{ ran: boolean; reason: string }> {
    if (!enabled) return { ran: false, reason: "Scheduler is stopped." };
    const state = input.state();
    if (state === "paused" || state === "stopped" || state === "stopping") {
      return { ran: false, reason: `Background is ${state}; tick skipped.` };
    }
    if (input.isGamingHeavy?.()) {
      skippedForGaming += 1;
      input.log.debug("lifecycle", "Idle tick skipped during GPU-heavy workload", {
        skippedForGaming,
      });
      return { ran: false, reason: "Gaming/GPU-heavy workload; idle work was skipped." };
    }
    ticks += 1;
    lastTickAt = nowIso();
    try {
      await input.onTick?.();
    } catch (error) {
      input.log.warn("lifecycle", "Idle scheduler tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { ran: true, reason: "Idle tick completed." };
  }

  return {
    status() {
      return {
        enabled,
        paused: input.state() === "paused",
        lastTickAt,
        ticks,
        skippedForGaming,
        idleIntervalMs,
        gamingThrottle: Boolean(input.isGamingHeavy?.()),
      };
    },
    start() {
      if (enabled) return;
      enabled = true;
      input.log.info("lifecycle", "Idle scheduler started", { idleIntervalMs });
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        void tick();
      }, idleIntervalMs);
      timer.unref?.();
    },
    stop() {
      enabled = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
  };
}
