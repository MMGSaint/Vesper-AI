/**
 * Unified subsystem availability.
 *
 * Never present a mock as live hardware. Never present a configured stub as a
 * connected real service. This is an adapter over existing status vocabs, not a
 * replacement for CapabilityState.
 */

export const AVAILABILITY = [
  "live",
  "available",
  "mock",
  "stub",
  "disabled",
  "unavailable",
  "blocked",
  "requires_hardware",
  "requires_credentials",
] as const;
export type Availability = (typeof AVAILABILITY)[number];

export interface AvailabilityView {
  id: string;
  label: string;
  availability: Availability;
  detail: string;
}

export function availabilityFor(input: {
  enabled?: boolean;
  implemented?: boolean;
  mock?: boolean;
  stub?: boolean;
  live?: boolean;
  hardware?: boolean;
  credentials?: boolean;
  blocked?: boolean;
}): Availability {
  if (input.blocked) return "blocked";
  if (input.hardware && !input.live) return "requires_hardware";
  if (input.credentials && !input.live) return "requires_credentials";
  if (input.enabled === false) return "disabled";
  if (input.live) return "live";
  if (input.mock) return "mock";
  if (input.stub) return "stub";
  if (input.implemented) return "available";
  return "unavailable";
}

export function describeAvailability(status: Availability): string {
  switch (status) {
    case "live":
      return "Observed on this machine.";
    case "available":
      return "Implemented and ready.";
    case "mock":
      return "Mock. Not live hardware or a hosted service.";
    case "stub":
      return "Interface only. No connected backend.";
    case "disabled":
      return "Present and switched off.";
    case "unavailable":
      return "Not reachable.";
    case "blocked":
      return "Refused by policy.";
    case "requires_hardware":
      return "Needs the physical machine.";
    case "requires_credentials":
      return "Needs production credentials that are not present.";
  }
}
