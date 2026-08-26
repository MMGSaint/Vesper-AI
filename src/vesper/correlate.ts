/**
 * Time correlation over the event log.
 *
 * When the optimizer reports that performance changed, the useful answer is usually
 * "OBS started recording forty seconds earlier", not a telemetry dump. Vesper holds
 * that context because it watches applications, games, capture, and workspace changes;
 * the optimizer does not.
 *
 * This module reports *temporal* relationships and nothing more. Two events near each
 * other in time are correlated, not proven causal, and every phrase produced here says
 * so. Vesper must never upgrade "happened just before" into "caused".
 */

import type { VesperEvent } from "./types.ts";

export interface CorrelationWindow {
  /** How far back to look from the anchor. */
  beforeMs: number;
  /** How far forward to look. */
  afterMs: number;
}

export const DEFAULT_WINDOW: CorrelationWindow = { beforeMs: 120_000, afterMs: 30_000 };

export interface Correlation {
  event: VesperEvent;
  /** Negative when the event happened before the anchor. */
  offsetMs: number;
  relation: "preceded" | "followed" | "concurrent";
  /** How much this kind of event plausibly bears on machine performance. */
  weight: number;
}

/**
 * Event kinds that plausibly move the needle on system performance, most significant
 * first. Anything unlisted still correlates, at low weight, rather than being hidden.
 */
const SIGNIFICANCE: { prefix: string; weight: number }[] = [
  { prefix: "game.", weight: 5 },
  { prefix: "obs.", weight: 5 },
  { prefix: "optimizer.", weight: 4 },
  { prefix: "application.", weight: 3 },
  { prefix: "system.", weight: 3 },
  { prefix: "workspace.", weight: 1 },
  { prefix: "lifecycle.", weight: 1 },
];

export function eventWeight(type: string): number {
  for (const entry of SIGNIFICANCE) {
    if (type.startsWith(entry.prefix)) return entry.weight;
  }
  return 1;
}

function parseAt(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Events within the window around an anchor moment, most significant first and, at
 * equal significance, closest in time first.
 */
export function correlateAround(
  events: VesperEvent[],
  anchorAt: string | number,
  window: CorrelationWindow = DEFAULT_WINDOW,
  options?: { limit?: number; exclude?: (event: VesperEvent) => boolean },
): Correlation[] {
  const anchor = typeof anchorAt === "number" ? anchorAt : parseAt(anchorAt);
  if (anchor === null) return [];

  const found: Correlation[] = [];
  for (const event of events) {
    if (options?.exclude?.(event)) continue;
    const at = parseAt(event.at);
    if (at === null) continue;
    const offsetMs = at - anchor;
    if (offsetMs < -window.beforeMs || offsetMs > window.afterMs) continue;
    found.push({
      event,
      offsetMs,
      // A second either way is the same moment for this purpose.
      relation: Math.abs(offsetMs) <= 1000 ? "concurrent" : offsetMs < 0 ? "preceded" : "followed",
      weight: eventWeight(event.type),
    });
  }

  found.sort((a, b) => b.weight - a.weight || Math.abs(a.offsetMs) - Math.abs(b.offsetMs));
  return found.slice(0, options?.limit ?? 6);
}

function humanGap(offsetMs: number): string {
  const seconds = Math.round(Math.abs(offsetMs) / 1000);
  if (seconds < 1) return "at the same moment";
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

export function describeCorrelation(correlation: Correlation): string {
  const gap = humanGap(correlation.offsetMs);
  if (correlation.relation === "concurrent") return `${correlation.event.title} (at the same moment)`;
  const direction = correlation.relation === "preceded" ? "before" : "after";
  return `${correlation.event.title} (${gap} ${direction})`;
}

/**
 * A sentence Vesper can say. Deliberately hedged: this is timing evidence offered to
 * the user, not a diagnosis, and the optimizer remains the authority on its own domain.
 */
export function explainCorrelations(anchorTitle: string, correlations: Correlation[]): string {
  if (correlations.length === 0) {
    return `I checked the event log around "${anchorTitle}" and found nothing else recorded nearby. That is not proof nothing happened, only that Vesper did not observe it.`;
  }
  const before = correlations.filter((item) => item.relation !== "followed");
  const after = correlations.filter((item) => item.relation === "followed");
  const parts = [
    `Around "${anchorTitle}" I observed: ${[...before, ...after].map(describeCorrelation).join("; ")}.`,
    "That is timing only — these events line up in time, which does not prove one caused another.",
  ];
  return parts.join(" ");
}
