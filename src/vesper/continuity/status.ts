/**
 * Unified status. Never claims a subsystem is live when only a mock/stub exists.
 */

import type { TrustState } from "../distributed/identity.ts";
import type { CloudStatus } from "./cloud.ts";
import type { DeviceClass } from "./routing.ts";

export interface IdentityStatus {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  trust: TrustState;
  portable: boolean;
  live: true;
}

export interface SyncStatusView {
  enabled: boolean;
  connected: boolean;
  lastSync: string | null;
  pending: number;
  conflicts: number;
  errors: string[];
  provider: CloudStatus;
}

export interface MemoryStatusView {
  localOk: boolean;
  sharedOk: boolean;
  detail: string;
}

export interface ModelStatusView {
  provider: string;
  model: string;
  fallback: boolean;
  location: "local" | "remote" | "echo";
}

export interface VoiceStatusView {
  asr: { enabled: boolean; available: boolean; capturing: boolean };
  tts: { enabled: boolean; available: boolean };
  wakeWord: { enabled: boolean; capturing: boolean };
  detail: string;
}

export interface RuntimeStatusView {
  scheduler: string;
  heartbeat: string;
}

export interface NexusStatusView {
  configured: boolean;
  reachable: boolean;
  mode: "mock" | "stub" | "live" | "unconfigured";
}

export interface VesperStatus {
  identity: IdentityStatus;
  sync: SyncStatusView;
  memory: MemoryStatusView;
  model: ModelStatusView;
  voice: VoiceStatusView;
  runtime: RuntimeStatusView;
  nexus: NexusStatusView;
  deviceClass: DeviceClass;
}

export function honestNexusMode(input: { mode: string; endpoint: string | null }): NexusStatusView["mode"] {
  if (input.mode === "live" && input.endpoint) return "live";
  if (input.mode === "live") return "stub";
  if (input.mode === "http") return "stub";
  if (input.mode === "mock") return "mock";
  return "unconfigured";
}

export function disabledVoiceStatus(): VoiceStatusView {
  return {
    asr: { enabled: false, available: false, capturing: false },
    tts: { enabled: false, available: false },
    wakeWord: { enabled: false, capturing: false },
    detail: "Voice is optional and currently disabled. No capture is running.",
  };
}
