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
}

export interface ProactiveIssue {
  readonly id: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly title: string;
  readonly body: string;
  readonly cooldownKey: string;
  readonly autoAction: 'none' | 'safe';
}

export interface ProactivityOptions {
  readonly intervalMs: number;
  readonly minSamplesForAlert: number;
  readonly cooldownMs: number;
  readonly now?: () => number;
}

const DEFAULTS: ProactivityOptions = {
  intervalMs: 30_000,
  minSamplesForAlert: 3,
  cooldownMs: 120_000,
};

export class ProactivityEngine {
  private readonly optimizer: OptimizerAdapter;
  private readonly events: EventBus;
  private readonly notifications: NotificationHub;
  private readonly options: ProactivityOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private consecutive = new Map<string, number>();
  private lastFingerprint = new Map<string, string>();
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
    if (this.running) return;
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
      const fingerprint = JSON.stringify({ id, severity, body });
      if (this.lastFingerprint.get(id) === fingerprint) return;
      this.lastFingerprint.set(id, fingerprint);
      issues.push({
        id,
        severity,
        title,
        body,
        cooldownKey: `sentinel:${id}`,
        autoAction,
      });
    };

    if (!observation.optimizerAvailable) {
      add(
        'optimizer-unavailable',
        'warning',
        'NEXUS connection is unavailable',
        'I lost live optimizer telemetry. I am staying in observation mode rather than pretending the machine state is known.',
      );
    }

    if (
      observation.gpuTemperatureC !== null &&
      observation.gpuTemperatureC >= 88
    ) {
      add(
        'gpu-hot',
        'warning',
        'GPU temperature is unusually high',
        `GPU temperature has remained around ${Math.round(observation.gpuTemperatureC)}°C. I am watching for stability and throttling rather than changing tuning blindly.`,
      );
    }

    if (
      observation.gpuVramUsedGB !== null &&
      observation.gpuVramTotalGB !== null &&
      observation.gpuVramTotalGB > 0 &&
      observation.gpuVramUsedGB / observation.gpuVramTotalGB >= 0.92
    ) {
      add(
        'vram-pressure',
        'warning',
        'VRAM pressure detected',
        `VRAM use is ${observation.gpuVramUsedGB.toFixed(1)} / ${observation.gpuVramTotalGB.toFixed(1)} GB. That can precede stutter or asset eviction in games and VR workloads.`,
      );
    }

    const cpu = observation.cpuUtilizationPct ?? 0;
    const gpu = observation.gpuUtilizationPct ?? 0;
    if (cpu >= 95 && gpu < 80) {
      add(
        'cpu-pressure',
        'info',
        'CPU pressure detected',
        `CPU utilisation is about ${Math.round(cpu)}% while GPU utilisation is only ${Math.round(gpu)}%. The current workload looks CPU-bound.`,
      );
    }

    if (gpu >= 98 && observation.performanceState === 'gpu') {
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
