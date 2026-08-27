/**
 * Which device did the user mean?
 *
 * The dangerous default is treating every request as local. Someone on their laptop
 * saying "prepare my PC for VRChat" means the desktop; running it locally would launch
 * the wrong applications on the wrong machine and report success. So the target is
 * resolved explicitly, and an ambiguous request is reported as ambiguous rather than
 * guessed.
 */

import type { DeviceRecord } from "./registry.ts";
import type { Capability } from "./capabilities.ts";
import { manifestHas } from "./capabilities.ts";

export type IntentTarget =
  | { kind: "current"; reason: string }
  | { kind: "device"; hint: string; reason: string }
  | { kind: "best"; reason: string };

/** Words that name a machine rather than describing work. */
const DEVICE_WORDS: { pattern: RegExp; hint: string }[] = [
  { pattern: /\b(my )?desktop\b/i, hint: "desktop" },
  { pattern: /\b(my )?(gaming )?(pc|rig|tower)\b/i, hint: "desktop" },
  { pattern: /\b(my )?laptop\b/i, hint: "laptop" },
  { pattern: /\b(my )?(phone|mobile)\b/i, hint: "phone" },
];

/** Phrasing that explicitly asks Vesper to choose. */
const BEST_EFFORT =
  /\b(wherever|whichever|best (device|machine|place)|somewhere|any (device|machine)|fastest (device|machine))\b/i;

/** Work that only makes sense on the machine in front of the user. */
const LOCAL_ONLY = /\b(this (screen|window|terminal)|here|in front of me|current device)\b/i;

export function classifyDeviceIntent(text: string): IntentTarget {
  const trimmed = text.trim();

  if (LOCAL_ONLY.test(trimmed)) {
    return { kind: "current", reason: "The request names the device in front of the user." };
  }
  if (BEST_EFFORT.test(trimmed)) {
    return { kind: "best", reason: "The request asks Vesper to choose a device." };
  }
  for (const entry of DEVICE_WORDS) {
    if (entry.pattern.test(trimmed)) {
      return {
        kind: "device",
        hint: entry.hint,
        reason: `The request names the ${entry.hint}.`,
      };
    }
  }
  // Nothing named a device, so the request is about the machine being used. This is the
  // safe default precisely because it cannot reach across to another machine.
  return { kind: "current", reason: "No other device was named, so this stays local." };
}

export interface ResolvedTarget {
  ok: boolean;
  device?: DeviceRecord;
  /** Set when the request cannot be satisfied, explaining what is missing. */
  problem?: string;
  reason: string;
}

/**
 * How strongly a device answers to a hint like "desktop".
 *
 * `deviceType` is a constrained enum fixed at enrolment. `name` is free text the
 * enrolling device supplies about *itself*, never validated and never deduplicated — so
 * treating the two as equal let a phone enrolled as "my desktop" capture work aimed at
 * the actual desktop, on nothing more than registry insertion order.
 *
 * 2 = the device type says so. 1 = only its self-chosen name says so. 0 = no.
 */
function hintStrength(device: DeviceRecord, hint: string): 0 | 1 | 2 {
  if (device.identity.deviceType === hint) return 2;
  return device.identity.name.toLowerCase().includes(hint) ? 1 : 0;
}

function matchesHint(device: DeviceRecord, hint: string): boolean {
  return hintStrength(device, hint) > 0;
}

/**
 * Turn an intent into an actual device.
 *
 * A named device that is offline is *not* silently replaced with an online one. The
 * user asked for that machine; substituting another one and reporting success is how
 * an action lands somewhere it was never meant to.
 */
export function resolveTarget(input: {
  intent: IntentTarget;
  devices: DeviceRecord[];
  currentDeviceId: string;
  requiredCapabilities?: Capability[];
}): ResolvedTarget {
  const current = input.devices.find(
    (device) => device.identity.deviceId === input.currentDeviceId,
  );
  const required = input.requiredCapabilities ?? [];
  const capable = (device: DeviceRecord): boolean =>
    required.every((capability) => manifestHas(device.capabilities, capability));

  if (input.intent.kind === "current") {
    if (!current) return { ok: false, problem: "This device is not in the registry.", reason: input.intent.reason };
    if (!capable(current)) {
      return {
        ok: false,
        device: current,
        problem: `This device does not have: ${required
          .filter((capability) => !manifestHas(current.capabilities, capability))
          .join(", ")}.`,
        reason: input.intent.reason,
      };
    }
    return { ok: true, device: current, reason: input.intent.reason };
  }

  if (input.intent.kind === "device") {
    const hint = input.intent.kind === "device" ? input.intent.hint : "";
    const matched = input.devices.filter((device) => matchesHint(device, hint));
    // A device type beats a self-chosen name, and only the strongest tier is considered:
    // once a real desktop answers, a phone that merely calls itself one does not.
    const best = matched.reduce((top, device) => Math.max(top, hintStrength(device, hint)), 0);
    const named = matched.filter((device) => hintStrength(device, hint) === best);
    if (named.length > 1) {
      return {
        ok: false,
        problem:
          `More than one enrolled device answers to "${hint}" (${named
            .map((device) => device.identity.name)
            .join(", ")}). Name the one you mean; I will not pick for you.`,
        reason: input.intent.reason,
      };
    }
    if (named.length === 0) {
      return {
        ok: false,
        problem: `No enrolled device matches "${input.intent.hint}".`,
        reason: input.intent.reason,
      };
    }
    const usable = named.find(
      (device) => device.trust === "trusted" && device.presence.reachability === "online" && capable(device),
    );
    if (usable) return { ok: true, device: usable, reason: input.intent.reason };

    const offline = named.find((device) => device.presence.reachability !== "online");
    if (offline) {
      return {
        ok: false,
        device: offline,
        // Deliberately not falling back: the user named this machine.
        problem: `${offline.identity.name} is offline. I did not substitute another device.`,
        reason: input.intent.reason,
      };
    }
    const untrusted = named.find((device) => device.trust !== "trusted");
    if (untrusted) {
      return {
        ok: false,
        device: untrusted,
        problem: `${untrusted.identity.name} is '${untrusted.trust}', so it cannot be asked to act.`,
        reason: input.intent.reason,
      };
    }
    return {
      ok: false,
      device: named[0],
      problem: `${named[0].identity.name} does not have: ${required.join(", ")}.`,
      reason: input.intent.reason,
    };
  }

  const candidates = input.devices.filter(
    (device) => device.trust === "trusted" && device.presence.reachability === "online" && capable(device),
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      problem: "No trusted, online device has what this needs. I have queued nothing and run nothing.",
      reason: input.intent.reason,
    };
  }
  // Same preference as task routing: leave the machine the user is on alone when there
  // is somewhere idle to do the work.
  const rank = (device: DeviceRecord): number =>
    device.presence.activity === "idle" ? 0 : device.presence.activity === "background" ? 1 : 2;
  const chosen = [...candidates].sort(
    (a, b) => rank(a) - rank(b) || a.identity.deviceId.localeCompare(b.identity.deviceId),
  )[0];
  return { ok: true, device: chosen, reason: input.intent.reason };
}
