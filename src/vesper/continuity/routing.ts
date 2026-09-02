/**
 * Resource-aware model routing metadata.
 *
 * Routing stays deterministic. Device class is a hint, never a hard-coded map of
 * this owner's current machines. A USB node prefers a lightweight local model;
 * a desktop prefers the strongest *available* local model. Remote/cloud is an
 * optional fallback, never a requirement.
 */

export const DEVICE_CLASSES = ["usb", "laptop", "desktop", "unknown"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export const LATENCY_CLASSES = ["low", "medium", "high", "unknown"] as const;
export type LatencyClass = (typeof LATENCY_CLASSES)[number];

export const QUALITY_TIERS = ["draft", "everyday", "strong", "unknown"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

export interface ModelDescriptor {
  provider: string;
  model: string;
  capabilities: { tools: boolean; vision: boolean; speech: boolean };
  contextTokens: number;
  estimatedMemoryMB: number | null;
  latency: LatencyClass;
  quality: QualityTier;
  location: "local" | "remote";
  available: boolean;
  priority: number;
}

export interface RoutingNeed {
  tools?: boolean;
  vision?: boolean;
  speech?: boolean;
  minContextTokens?: number;
  preferLocal?: boolean;
}

const CLASS_MEMORY_HINT: Record<DeviceClass, number | null> = {
  usb: 4096,
  laptop: 8192,
  desktop: null,
  unknown: null,
};

export function selectModel(
  descriptors: ModelDescriptor[],
  need: RoutingNeed = {},
  deviceClass: DeviceClass = "unknown",
): ModelDescriptor | null {
  const memoryHint = CLASS_MEMORY_HINT[deviceClass];
  const eligible = descriptors.filter((item) => {
    if (!item.available) return false;
    if (need.tools && !item.capabilities.tools) return false;
    if (need.vision && !item.capabilities.vision) return false;
    if (need.speech && !item.capabilities.speech) return false;
    if (need.minContextTokens && item.contextTokens < need.minContextTokens) return false;
    if (memoryHint !== null && item.estimatedMemoryMB !== null && item.estimatedMemoryMB > memoryHint) {
      return false;
    }
    if (need.preferLocal && item.location !== "local") return false;
    return true;
  });
  if (!eligible.length) return null;
  const local = eligible.filter((item) => item.location === "local");
  const pool = local.length ? local : eligible;
  return [...pool].sort((a, b) => {
    const qualityRank = { strong: 3, everyday: 2, draft: 1, unknown: 0 };
    const q = qualityRank[b.quality] - qualityRank[a.quality];
    if (q !== 0) return q;
    return b.priority - a.priority;
  })[0] ?? null;
}
