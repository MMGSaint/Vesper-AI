import type { OptimizerAdapter } from './specialists/optimizer.ts';
import type { EventBus } from './events.ts';
import type { NotificationHub } from './notifications.ts';

export interface ProactiveObservation {
  readonly capturedAtMs: number;
  readonly optimizerAvailable: boolean;
  readonly cpuUtilizationPct: number | null;
  readonly gpuUtilizationPct: number | null;
  readonly gpuTemperatureC: number | null;
  readonly gpuVramUsedGB: number | null;
  readonly gpuVramTotalGB: number | null;
  readonly performanceState: string | null;
  readonly telemetryFidelity: NonNullable<Awaited<ReturnType<OptimizerAdapter["getTelemetry"]>>["fidelity"]>;
}

export interface ProactiveIssue {
  readonly id: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly title: string;
  readonly body: string;
  readonly cooldownKey: string;
  /** Sentinel is observation-only. A future action must be designed and gated separately. */
  readonly autoAction: 'none';
}

export interface ProactivityOptions {
  readonly intervalMs: number;
  /** Consecutive observations that must agree before an issue can arm. */
  readonly minSamplesForAlert: number;
  /** Minimum time before the same issue may re-arm after recovery. */
  readonly cooldownMs: number;
  /** Hard cap on visible Sentinel alerts in a rolling window. */
  readonly maxAlertsPerWindow: number;
  /** Rolling rate-limit window for visible Sentinel alerts. */
  readonly rateLimitWindowMs: number;
  /** Explicit opt-in required before Sentinel may create its background loop. */
  readonly enabled: boolean;
  readonly now?: () => number;
}

const DEFAULTS: ProactivityOptions = {
  intervalMs: 30_000,
  minSamplesForAlert: 3,
  cooldownMs: 120_000,
  maxAlertsPerWindow: 6,
  rateLimitWindowMs: 3_600_000,
  enabled: false,
};

export class ProactivityEngine {
  private readonly optimizer: OptimizerAdapter;
  private readonly events: EventBus;
  private readonly notifications: NotificationHub;
  private readonly options: ProactivityOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private consecutive = new Map<string, number>();
  /** An armed issue stays quiet until the evidence clears and it re-arms. */
  private armed = new Set<string>();
  private lastAlertAt = new Map<string, number>();
  private alertHistory: number[] = [];
  private previous: ProactiveObservation | null = null;

  constructor(
    optimizer: OptimizerAdapter,
    events: EventBus,
    notifications: NotificationHub,
    options: Partial<ProactivityOptions> = {},
  ) {
    this.optimizer = optimizer;
    this.events = events;
    this.notifications = notifications;
    this.options = { ...DEFAULTS, ...options };
  }

  start(): void {
    if (!this.options.enabled || this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async sample(): Promise<{ observation: ProactiveObservation; issues: ProactiveIssue[] }> {
    const now = (this.options.now ?? Date.now);
    const telemetry = await this.optimizer.getTelemetry();
    const hardware = telemetry.hardware;
    const observation: ProactiveObservation = {
      capturedAtMs: now(),
      optimizerAvailable: telemetry.available,
      cpuUtilizationPct: finiteOrNull(hardware.cpu.utilizationPct),
      gpuUtilizationPct: finiteOrNull(hardware.gpu?.utilizationPct ?? null),
      gpuTemperatureC: finiteOrNull(hardware.gpu?.tempC ?? null),
      gpuVramUsedGB: finiteOrNull(hardware.gpu?.vramUsedGB ?? null),
      gpuVramTotalGB: finiteOrNull(hardware.gpu?.vramGB ?? null),
      performanceState: telemetry.bound ?? null,
      telemetryFidelity: telemetry.fidelity,
    };

    const issues = this.evaluate(observation);
    return { observation, issues };
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const result = await this.sample();
      for (const issue of result.issues) this.publish(issue);
    } catch (error) {
      this.events.emit({
        type: 'proactivity.sample_failed',
        title: 'Sentinel could not sample machine state',
        detail: error instanceof Error ? error.message : String(error),
        severity: 'info',
        retention: 'transient',
        provenance: { author: 'subsystem', source: 'sentinel' },
      });
    } finally {
      if (this.running) {
        this.timer = setTimeout(() => void this.tick(), this.options.intervalMs);
        this.timer.unref?.();
      }
    }
  }

  evaluate(observation: ProactiveObservation): ProactiveIssue[] {
    const issues: ProactiveIssue[] = [];
    const now = observation.capturedAtMs;
    const liveTelemetry = observation.optimizerAvailable && observation.telemetryFidelity === 'live';
    this.alertHistory = this.alertHistory.filter(
      (at) => now - at < this.options.rateLimitWindowMs,
    );

    const add = (
      id: string,
      severity: ProactiveIssue['severity'],
      title: string,
      body: string,
      autoAction: ProactiveIssue['autoAction'] = 'none',
    ) => {
      const n = (this.consecutive.get(id) ?? 0) + 1;
      this.consecutive.set(id, n);
      if (n < this.options.minSamplesForAlert) return;

      // One alert per continuous episode. A changing temperature/body must not
      // defeat suppression while the underlying condition is still active.
      if (this.armed.has(id)) return;

      const last = this.lastAlertAt.get(id) ?? 0;
      if (last > 0 && now - last < this.options.cooldownMs) return;

      // Global Sentinel rate limit. NotificationHub has its own cooldown, but
      // Sentinel needs an explicit policy before it emits anything at all.
      if (this.alertHistory.length >= this.options.maxAlertsPerWindow) return;

      this.armed.add(id);
      this.lastAlertAt.set(id, now);
      this.alertHistory.push(now);
      issues.push({
        id,
        severity,
        title,
        body,
        cooldownKey: `sentinel:${id}`,
        autoAction,
      });
    };

    const clear = (id: string, active: boolean): void => {
      if (active) return;
      this.consecutive.delete(id);
      this.armed.delete(id);
    };

    const optimizerUnavailable = !observation.optimizerAvailable;
    clear('optimizer-unavailable', optimizerUnavailable);
    if (optimizerUnavailable) {
      add(
        'optimizer-unavailable',
        'warning',
        'NEXUS connection is unavailable',
        'I lost live optimizer telemetry. I am staying in observation mode rather than pretending the machine state is known.',
      );
    }

    if (!liveTelemetry) {
      for (const id of ['gpu-hot', 'vram-pressure', 'cpu-pressure', 'gpu-bound']) {
        clear(id, false);
      }
    }

    const gpuHot = liveTelemetry && observation.gpuTemperatureC !== null && observation.gpuTemperatureC >= 88;
    clear('gpu-hot', gpuHot);
    if (gpuHot) {
      add(
        'gpu-hot',
        'warning',
        'GPU temperature is unusually high',
        `GPU temperature has remained around ${Math.round(observation.gpuTemperatureC)}°C. I am watching for stability and throttling rather than changing tuning blindly.`,
      );
    }

    const vramPressure =
      liveTelemetry &&
      observation.gpuVramUsedGB !== null &&
      observation.gpuVramTotalGB !== null &&
      observation.gpuVramTotalGB > 0 &&
      observation.gpuVramUsedGB / observation.gpuVramTotalGB >= 0.92;
    clear('vram-pressure', vramPressure);
    if (vramPressure) {
      add(
        'vram-pressure',
        'warning',
        'VRAM pressure detected',
        `VRAM use is ${observation.gpuVramUsedGB.toFixed(1)} / ${observation.gpuVramTotalGB.toFixed(1)} GB. That can precede stutter or asset eviction in games and VR workloads.`,
      );
    }

    const cpu = observation.cpuUtilizationPct ?? 0;
    const gpu = observation.gpuUtilizationPct ?? 0;
    const cpuPressure = liveTelemetry && cpu >= 95 && gpu < 80;
    clear('cpu-pressure', cpuPressure);
    if (cpuPressure) {
      add(
        'cpu-pressure',
        'info',
        'CPU pressure detected',
        `CPU utilisation is about ${Math.round(cpu)}% while GPU utilisation is only ${Math.round(gpu)}%. The current workload looks CPU-bound.`,
      );
    }

    const gpuBound = liveTelemetry && gpu >= 98 && observation.performanceState === 'gpu';
    clear('gpu-bound', gpuBound);
    if (gpuBound) {
      add(
        'gpu-bound',
        'info',
        'GPU-bound workload detected',
        'The current workload is saturated on the GPU. Vesper will prefer measured frame-pacing evidence before suggesting a graphics change.',
      );
    }

    if (this.previous && this.previous.optimizerAvailable && !observation.optimizerAvailable) {
      this.events.emit({
        type: 'proactivity.optimizer_lost',
        title: 'NEXUS telemetry disappeared',
        detail: 'The last observation was healthy; this one is unavailable.',
        severity: 'warn',
        retention: 'durable',
        provenance: { author: 'subsystem', source: 'sentinel' },
      });
    }

    this.previous = observation;
    return issues;
  }

  private publish(issue: ProactiveIssue): void {
    const item = this.notifications.push({
      title: issue.title,
      body: issue.body,
      kind: issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info',
      cooldownKey: issue.cooldownKey,
      author: 'subsystem',
    });
    if (item) {
      this.events.emit({
        type: `proactivity.${issue.id}`,
        title: issue.title,
        detail: issue.body,
        severity: issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warn' : 'info',
        retention: 'durable',
        provenance: { author: 'subsystem', source: 'sentinel' },
      });
    }
  }
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}
