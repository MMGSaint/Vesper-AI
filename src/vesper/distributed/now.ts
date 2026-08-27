/**
 * "Vesper Now": one compact snapshot of the whole ecosystem.
 *
 * The agent needs to know which device it is on, what else exists, and what is
 * reachable, on essentially every turn. Discovering that through tool calls would cost a
 * round trip each time, so it is assembled once from state already in memory and folded
 * into the prompt as text.
 *
 * Everything here is observed. A device that has not reported in is listed as offline
 * rather than as its last known state, and a capability that was never probed is absent
 * rather than assumed.
 */

import type { HostPosture } from "./identity.ts";
import type { DeviceRecord } from "./registry.ts";
import type { VesperTask } from "./tasks.ts";
import { manifestHas, type Capability } from "./capabilities.ts";

/** Capabilities worth naming in a one-line device summary. */
const HEADLINE: Capability[] = ["local_llm", "nexus", "voice_stt", "obs"];

export interface VesperNow {
  generatedAt: string;
  activeDevice: {
    deviceId: string;
    name: string;
    trust: string;
    hostPosture: HostPosture;
  };
  workspace: string;
  devices: {
    name: string;
    deviceId: string;
    type: string;
    trust: string;
    reachability: string;
    activity: string;
    headline: Capability[];
    isCurrent: boolean;
  }[];
  models: { active: string; available: string[] };
  voice: string;
  optimizer: string;
  tasks: { queued: number; running: number; blocked: number; failed: number };
}

export function buildNow(input: {
  self: DeviceRecord;
  hostPosture: HostPosture;
  workspace: string;
  devices: DeviceRecord[];
  tasks: VesperTask[];
  models: { active: string; available: { id: string; available: boolean }[] };
  voice: string;
  optimizer: string;
  now?: () => string;
}): VesperNow {
  const count = (state: VesperTask["state"]): number =>
    input.tasks.filter((task) => task.state === state).length;

  return {
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
    activeDevice: {
      deviceId: input.self.identity.deviceId,
      name: input.self.identity.name,
      trust: input.self.trust,
      hostPosture: input.hostPosture,
    },
    workspace: input.workspace,
    devices: input.devices.map((device) => ({
      name: device.identity.name,
      deviceId: device.identity.deviceId,
      type: device.identity.deviceType,
      trust: device.trust,
      reachability: device.presence.reachability,
      activity: device.presence.activity,
      headline: HEADLINE.filter((capability) => manifestHas(device.capabilities, capability)),
      isCurrent: device.identity.deviceId === input.self.identity.deviceId,
    })),
    models: {
      active: input.models.active,
      available: input.models.available.filter((item) => item.available).map((item) => item.id),
    },
    voice: input.voice,
    optimizer: input.optimizer,
    tasks: {
      queued: count("queued"),
      running: count("running"),
      blocked: count("blocked"),
      failed: count("failed"),
    },
  };
}

/**
 * Render for the prompt. Deliberately terse: this is included on every turn, so each
 * line has to earn its tokens.
 */
export function renderNow(now: VesperNow): string {
  const lines: string[] = [];
  const host =
    now.activeDevice.hostPosture === "foreign"
      ? " — running on a host that is not yours; treat it as able to observe this session"
      : "";
  lines.push(`Active device: ${now.activeDevice.name} (${now.activeDevice.trust})${host}`);
  lines.push(`Workspace: ${now.workspace}`);

  const others = now.devices.filter((device) => !device.isCurrent);
  if (others.length) {
    lines.push("Other devices:");
    for (const device of others) {
      const caps = device.headline.length ? ` [${device.headline.join(", ")}]` : "";
      const state =
        device.reachability === "online" ? `online/${device.activity}` : "offline";
      lines.push(`  ${device.name} (${device.type}, ${device.trust}): ${state}${caps}`);
    }
  } else {
    lines.push("Other devices: none enrolled.");
  }

  lines.push(
    `Models: active ${now.models.active}${
      now.models.available.length ? `; available ${now.models.available.join(", ")}` : "; none reachable"
    }`,
  );
  lines.push(`Voice: ${now.voice}. Optimizer: ${now.optimizer}.`);

  const { queued, running, blocked, failed } = now.tasks;
  if (queued || running || blocked || failed) {
    lines.push(
      `Tasks: ${running} running, ${queued} queued, ${blocked} blocked, ${failed} failed.`,
    );
  }
  return lines.join("\n");
}
