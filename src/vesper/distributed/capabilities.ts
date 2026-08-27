/**
 * Capability manifests and what a remote device may ask of this one.
 *
 * Two separate questions live here and must not be conflated:
 *
 *   1. What can this device actually do?  -> the manifest, which is *discovered*.
 *      A capability is never listed because a device type usually has it; a laptop
 *      without a reachable model backend does not have `local_llm`.
 *
 *   2. What may another device ask this one to do?  -> the grant, decided by the
 *      requester's trust class. This is where the portable/USB restriction lives: a
 *      restricted device authenticates as the user and still cannot reach host
 *      authority, because the machine underneath it is not the user's machine.
 *
 * A grant is a ceiling, never a permission. Everything still passes the local
 * permission gate afterwards; a grant can only ever narrow what the gate would allow.
 */

import type { CapabilityState } from "../client/protocol.ts";
import { FORBIDDEN_REMOTE_POWERS } from "../client/protocol.ts";
import type { TrustState } from "./identity.ts";

export const CAPABILITIES = [
  "conversation",
  "local_llm",
  "large_llm",
  "embeddings",
  "voice_stt",
  "voice_tts",
  "notifications",
  "sync",
  "presence",
  "task_create",
  "task_execute",
  "process_inspect",
  "app_launch",
  "filesystem",
  "windows_control",
  "nexus",
  "obs",
  "gaming",
  "vrchat",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface CapabilityFinding {
  id: Capability;
  state: CapabilityState;
  /** How this was determined. "assumed" is never an acceptable answer. */
  detail: string;
}

export interface CapabilityManifest {
  deviceId: string;
  generatedAt: string;
  findings: CapabilityFinding[];
}

export function manifestHas(manifest: CapabilityManifest | null, capability: Capability): boolean {
  if (!manifest) return false;
  return manifest.findings.some(
    (finding) => finding.id === capability && finding.state === "AVAILABLE",
  );
}

export function capabilityState(
  manifest: CapabilityManifest | null,
  capability: Capability,
): CapabilityState {
  return (
    manifest?.findings.find((finding) => finding.id === capability)?.state ?? "NOT_CONFIGURED"
  );
}

/**
 * What a device of this trust class may ask a peer to do.
 *
 * `restricted` is the portable class. It deliberately excludes every capability that
 * would give a foreign host reach into the destination machine. A portable Vesper asks
 * a trusted device to act; it never acts on the host itself.
 */
const GRANTS: Record<TrustState, readonly Capability[]> = {
  trusted: CAPABILITIES,
  restricted: [
    "conversation",
    "presence",
    "sync",
    "task_create",
    "notifications",
  ],
  pending: [],
  unknown: [],
  revoked: [],
};

export function grantedCapabilities(trust: TrustState): readonly Capability[] {
  return GRANTS[trust] ?? [];
}

export function isGranted(trust: TrustState, capability: Capability): boolean {
  return grantedCapabilities(trust).includes(capability);
}

/**
 * Capabilities that must never be reachable from any remote device, at any trust class.
 * These mirror `FORBIDDEN_REMOTE_POWERS`: OS authority stays on the host that owns it.
 */
export const NEVER_REMOTE: readonly Capability[] = ["filesystem", "windows_control"];

export interface RemoteRequestDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Decide whether a remote device may request a capability of this device.
 *
 * Order matters. The never-remote check runs first so that no trust class, present or
 * future, can reach OS authority across the wire - including `trusted`, because a
 * trusted *device* is still a different machine.
 */
export function decideRemoteRequest(input: {
  trust: TrustState;
  capability: Capability;
  manifest: CapabilityManifest | null;
}): RemoteRequestDecision {
  if (NEVER_REMOTE.includes(input.capability)) {
    return {
      allowed: false,
      reason: `'${input.capability}' is never reachable from another device. OS authority stays on the machine that owns it.`,
    };
  }
  if (input.trust === "revoked") {
    return { allowed: false, reason: "This device was revoked." };
  }
  if (!isGranted(input.trust, input.capability)) {
    return {
      allowed: false,
      reason: `A '${input.trust}' device may not request '${input.capability}'.`,
    };
  }
  if (!manifestHas(input.manifest, input.capability)) {
    return {
      allowed: false,
      reason: `This device does not report '${input.capability}' as available.`,
    };
  }
  return {
    allowed: true,
    reason: `Granted for a '${input.trust}' device; the local permission gate still applies.`,
  };
}

/** Sanity check used by tests and startup: grants must never name a forbidden power. */
export function grantsRespectForbiddenPowers(): boolean {
  const forbidden = new Set<string>(FORBIDDEN_REMOTE_POWERS);
  return !CAPABILITIES.some((capability) => forbidden.has(capability));
}

export interface DiscoveryProbe {
  id: Capability;
  probe: () => Promise<{ state: CapabilityState; detail: string }> | { state: CapabilityState; detail: string };
}

/**
 * Build a manifest by running probes. A probe that throws yields UNAVAILABLE with the
 * reason rather than removing the capability silently - "we could not tell" and "it is
 * not there" are different answers and Vesper reports which one it has.
 */
export async function discoverCapabilities(input: {
  deviceId: string;
  probes: DiscoveryProbe[];
  now?: () => string;
}): Promise<CapabilityManifest> {
  const findings: CapabilityFinding[] = [];
  for (const probe of input.probes) {
    try {
      const result = await probe.probe();
      findings.push({ id: probe.id, state: result.state, detail: result.detail });
    } catch (error) {
      findings.push({
        id: probe.id,
        state: "UNAVAILABLE",
        detail: `Probe failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return {
    deviceId: input.deviceId,
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
    findings,
  };
}
