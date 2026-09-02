/**
 * Independently enabled local context sources.
 *
 * Screenpipe's useful idea is not always-on capture. It is that computer context is a
 * *set of sources*, each of which can be off, and that off means *no work* — not an
 * empty screenshot. Vesper already inspects processes for game/OBS workload. This
 * engine is the seam those sources, and later ones, hang off.
 *
 * Invasive sources (clipboard, screen, browser, audio, window titles, filesystem
 * watchers) default OFF and, while off, must not open devices, spawn helpers, or
 * read the clipboard. Enabling them is a config change, not a code path that "just
 * starts recording".
 *
 * No Screenpipe code is copied. No SQLite. No network.
 */

import { nowIso } from "../id.ts";
import type { ContextTrust, JsonObject } from "../types.ts";

export const CONTEXT_SOURCE_IDS = [
  "process",
  "window",
  "clipboard",
  "filesystem",
  "browser",
  "screen",
  "audio",
] as const;

export type ContextSourceId = (typeof CONTEXT_SOURCE_IDS)[number];

export type ContextObservationKind = "observed" | "unavailable" | "disabled";

export interface ContextObservation {
  source: ContextSourceId;
  at: string;
  kind: ContextObservationKind;
  summary: string;
  data?: JsonObject;
  /**
   * Who produced this observation. Provenance is a label, not a permission.
   * Process lists are SYSTEM. Unimplemented capture, if it existed, would be
   * UNTRUSTED_EXTERNAL — it is content Vesper did not author.
   */
  trust: ContextTrust;
  scope?: string;
}

export interface ContextSource {
  id: ContextSourceId;
  enabled: boolean;
  snapshot: () => ContextObservation | Promise<ContextObservation>;
}

export interface ContextSourceConfig {
  process: boolean;
  window: boolean;
  clipboard: boolean;
  filesystem: boolean;
  browser: boolean;
  screen: boolean;
  audio: boolean;
}

export const DISABLED_CONTEXT_SOURCES: ContextSourceConfig = {
  process: false,
  window: false,
  clipboard: false,
  filesystem: false,
  browser: false,
  screen: false,
  audio: false,
};

export interface ContextEngine {
  sources: () => { id: ContextSourceId; enabled: boolean }[];
  snapshot: () => Promise<ContextObservation[]>;
}

export function createContextEngine(input: {
  config?: Partial<ContextSourceConfig>;
  listProcesses?: () => { name: string; pid?: number }[];
}): ContextEngine {
  const enabled: ContextSourceConfig = { ...DISABLED_CONTEXT_SOURCES, ...input.config };
  const sources: ContextSource[] = CONTEXT_SOURCE_IDS.map((id) => {
    if (id === "process") {
      return processSource({
        enabled: enabled.process,
        listProcesses: input.listProcesses,
      });
    }
    return inertSource(id, enabled[id]);
  });

  return {
    sources() {
      return sources.map((source) => ({ id: source.id, enabled: source.enabled }));
    },
    async snapshot() {
      return Promise.all(sources.map((source) => Promise.resolve(source.snapshot())));
    },
  };
}

function processSource(input: {
  enabled: boolean;
  listProcesses?: () => { name: string; pid?: number }[];
}): ContextSource {
  return {
    id: "process",
    enabled: input.enabled,
    snapshot() {
      if (!input.enabled) {
        return disabled("process");
      }
      const list = input.listProcesses?.() ?? [];
      const names = list.map((item) => item.name).filter((name) => name.length > 0);
      return {
        source: "process",
        at: nowIso(),
        kind: "observed",
        summary: names.length ? `${names.length} process name(s) visible` : "no processes reported",
        data: { names: names.slice(0, 64) },
        trust: "system",
        scope: "device",
      };
    },
  };
}

function inertSource(id: ContextSourceId, enabled: boolean): ContextSource {
  return {
    id,
    enabled,
    snapshot() {
      if (!enabled) return disabled(id);
      return {
        source: id,
        at: nowIso(),
        kind: "unavailable",
        summary: `${id} capture is not implemented; enabling it does not record anything`,
        trust: "system",
        scope: "device",
      };
    },
  };
}

function disabled(id: ContextSourceId): ContextObservation {
  return {
    source: id,
    at: nowIso(),
    kind: "disabled",
    summary: `${id} source is off`,
    trust: "system",
    scope: "device",
  };
}
