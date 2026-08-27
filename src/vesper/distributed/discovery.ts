/**
 * The probe set that turns this running Vesper into a capability manifest.
 *
 * Every entry here answers "what can this device actually do, right now" by asking the
 * component that would do the work — never by assuming a device type implies a
 * capability. A laptop with no reachable model backend does not have `local_llm`, and
 * saying it does would make routing send it work it cannot perform.
 *
 * The three states carry different meanings and are not interchangeable:
 *   AVAILABLE       - asked, and it answered yes.
 *   UNAVAILABLE     - asked, and it answered no (or could not be reached).
 *   NOT_CONFIGURED  - nothing is wired up to answer at all.
 *
 * That last one is the honest answer for a capability Vesper has code for but has not
 * connected to anything yet. Reporting it as UNAVAILABLE would imply we looked.
 */

import type { CapabilityState } from "../client/protocol.ts";
import type { Capability, DiscoveryProbe } from "./capabilities.ts";
import type { HostPosture } from "./identity.ts";

/** Anything that can answer a probe. Kept structural so tests need no real runtime. */
export interface DiscoverySubjects {
  models: {
    status(): { available: { id: string; kind: string; available: boolean }[] };
  };
  voice: { status(): { available: boolean; stt: string; tts: string } };
  optimizer: {
    getStatus(): Promise<{ available: boolean; mode: "mock" | "live" | "unavailable"; detail: string }>;
  };
  obs: { isConnected?: () => boolean };
  tools: { list(workspaceId?: string): { name: string }[] };
  hostPosture: HostPosture;
  /** Whether a sync transport is actually attached. Today nothing attaches one. */
  syncAttached?: boolean;
  /** The Windows host, when one is attached. Nothing attaches it yet. */
  windowsHost?: { available(): boolean };
}

function state(ok: boolean, yes: string, no: string): { state: CapabilityState; detail: string } {
  return ok ? { state: "AVAILABLE", detail: yes } : { state: "UNAVAILABLE", detail: no };
}

function notConfigured(detail: string): { state: CapabilityState; detail: string } {
  return { state: "NOT_CONFIGURED", detail };
}

/**
 * A capability that depends on a registered tool is reported from the tool registry,
 * because the tool is what would actually run. If the gate would refuse it, the
 * capability is not there regardless of what the platform could theoretically do.
 */
function hasTool(subjects: DiscoverySubjects, name: string): boolean {
  return subjects.tools.list().some((tool) => tool.name === name);
}

export function buildDiscoveryProbes(subjects: DiscoverySubjects): DiscoveryProbe[] {
  const probe = (
    id: Capability,
    fn: () => Promise<{ state: CapabilityState; detail: string }> | { state: CapabilityState; detail: string },
  ): DiscoveryProbe => ({ id, probe: fn });

  const localBackends = () =>
    subjects.models.status().available.filter((item) => item.kind === "local" && item.available);
  const remoteBackends = () =>
    subjects.models.status().available.filter((item) => item.kind !== "local" && item.available);

  return [
    probe("conversation", () => ({
      state: "AVAILABLE",
      detail: "The agent loop runs on this device.",
    })),
    probe("local_llm", () => {
      const local = localBackends();
      return state(
        local.length > 0,
        `${local.length} local backend(s) reachable: ${local.map((item) => item.id).join(", ")}.`,
        "No local model backend answered.",
      );
    }),
    probe("large_llm", () => {
      const remote = remoteBackends();
      return state(
        remote.length > 0,
        `${remote.length} non-local backend(s) reachable.`,
        "No large-model backend is reachable from this device.",
      );
    }),
    probe("embeddings", () => {
      // Embeddings ride on a model backend; without one there is nothing to embed with.
      const local = localBackends();
      return state(
        local.length > 0,
        "A model backend that can serve embeddings is reachable.",
        "No backend is reachable to compute embeddings.",
      );
    }),
    probe("voice_stt", () => {
      const status = subjects.voice.status();
      return state(
        status.available && Boolean(status.stt),
        `Speech-to-text via ${status.stt}.`,
        "No speech-to-text provider is available.",
      );
    }),
    probe("voice_tts", () => {
      const status = subjects.voice.status();
      return state(
        status.available && Boolean(status.tts),
        `Text-to-speech via ${status.tts}.`,
        "No text-to-speech provider is available.",
      );
    }),
    probe("notifications", () => ({
      state: "AVAILABLE",
      detail: "Notifications are delivered in-process.",
    })),
    probe("presence", () => ({
      state: "AVAILABLE",
      detail: "This device reports presence to its own registry.",
    })),
    probe("sync", () =>
      subjects.syncAttached
        ? { state: "AVAILABLE" as CapabilityState, detail: "A sync transport is attached." }
        : notConfigured("Sync is implemented but no transport is attached on this device."),
    ),
    probe("task_create", () => ({
      state: "AVAILABLE",
      detail: "This device can queue tasks.",
    })),
    probe("task_execute", () =>
      // A foreign host runs Vesper but is not the user's machine: it may ask for work
      // to be done, it may not become the machine that does it.
      subjects.hostPosture === "foreign"
        ? {
            state: "UNAVAILABLE" as CapabilityState,
            detail: "Running on a foreign host; this device does not execute tasks for others.",
          }
        : { state: "AVAILABLE" as CapabilityState, detail: "This device can execute queued tasks." },
    ),
    probe("process_inspect", () =>
      state(
        hasTool(subjects, "process_list"),
        "process_list is registered.",
        "No process inspection tool is registered on this device.",
      ),
    ),
    probe("app_launch", () =>
      state(
        hasTool(subjects, "app_launch"),
        "app_launch is registered.",
        "No application launch tool is registered on this device.",
      ),
    ),
    probe("filesystem", () =>
      state(
        hasTool(subjects, "fs_read"),
        "Approved-root filesystem tools are registered.",
        "No filesystem tool is registered on this device.",
      ),
    ),
    probe("windows_control", () =>
      // Asked of the host module, not of a tool name: there is no Windows tool in the
      // registry to look for, so a tool-name probe would report a permanent "no" that
      // looks like a finding rather than an unwired feature.
      subjects.windowsHost
        ? state(
            subjects.windowsHost.available(),
            "A Windows host is attached and reports itself available.",
            "A Windows host is attached but reports itself unavailable.",
          )
        : notConfigured("No Windows host is attached on this device."),
    ),
    probe("nexus", async () => {
      // Never claim the optimizer is there because a tool exists. Ask NEXUS itself —
      // and a mock adapter answering "available" is not NEXUS. Reporting the capability
      // on a mock would let a peer route real optimization work to a device that can
      // only pretend to do it, which is the one thing the optimizer boundary forbids.
      try {
        const status = await subjects.optimizer.getStatus();
        if (status.mode === "mock") {
          return notConfigured(`No real optimizer is connected (mock adapter): ${status.detail}`);
        }
        return state(
          status.available && status.mode === "live",
          `NEXUS answered: ${status.detail}`,
          `NEXUS did not report itself available: ${status.detail}`,
        );
      } catch (error) {
        return {
          state: "UNAVAILABLE" as CapabilityState,
          detail: `Could not reach NEXUS: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
    probe("obs", () =>
      subjects.obs.isConnected
        ? state(
            subjects.obs.isConnected(),
            "OBS websocket is connected.",
            "OBS is configured but not connected.",
          )
        : notConfigured("No OBS client is attached on this device."),
    ),
    probe("gaming", () =>
      state(
        hasTool(subjects, "set_scenario"),
        "Gaming scenario control is registered.",
        "No gaming scenario tool is registered on this device.",
      ),
    ),
    probe("vrchat", () =>
      state(
        hasTool(subjects, "set_scenario"),
        "VRChat scenarios can be set from this device.",
        "No VRChat scenario tool is registered on this device.",
      ),
    ),
  ];
}
