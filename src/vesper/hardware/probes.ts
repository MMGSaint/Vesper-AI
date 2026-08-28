/**
 * Hardware probe interface — the seam for the target-PC bootstrap.
 *
 * The first-boot report in bootstrap.ts already lists 18 steps, six of which are
 * hard-coded strings on non-Windows platforms (gpu, vram, telemetry, audio, windows,
 * benchmark). On the physical target PC — Ryzen 9 9950X / RX 7900 XT / 96 GB / Windows
 * — real probes will fill these in. Until that machine exists, this module defines the
 * INTERFACE those probes will implement, and a registry the bootstrap consults.
 *
 * Nothing here fabricates a benchmark number or claims a piece of hardware without a
 * probe result. If a probe is not registered for the current platform, the bootstrap
 * records the shortfall explicitly — "AMD ADLX telemetry probe is not implemented on
 * linux; validate on the target PC" — which is honest, and which a diagnostic can
 * point an operator to.
 *
 * Design notes:
 *   - Every probe is asynchronous and MUST NOT throw. A probe that would throw returns
 *     {ok: false, reason: "..."} instead — a probe failure is bootstrap information,
 *     not a startup blocker.
 *   - Every probe declares whether its result is `implemented_tested`,
 *     `implemented_hardware_dependent`, `mocked_simulated`, or
 *     `documented_not_implemented`. The bootstrap surfaces this classification.
 *   - Probes are registered by id; the ids match the first-boot step ids so a probe
 *     implementation replaces the current synthetic step deterministically.
 *   - No probe is granted authority to install itself. The runtime's config or the
 *     platform bootstrap chooses which probes to register.
 */

export type ProbeClassification =
  | "implemented_tested"
  | "implemented_hardware_dependent"
  | "mocked_simulated"
  | "documented_not_implemented";

export interface ProbeContext {
  /** The OS as reported by process.platform, e.g. "win32", "linux", "darwin". */
  platform: string;
  /**
   * A logger the probe can use for diagnostic messages. Kept out of the interface
   * shape so probes stay portable — real implementations import it themselves.
   */
  log?: {
    debug?: (message: string, data?: unknown) => void;
    info?: (message: string, data?: unknown) => void;
    warn?: (message: string, data?: unknown) => void;
    error?: (message: string, data?: unknown) => void;
  };
}

export interface ProbeResult {
  /** True when the probe actually established the answer. */
  ok: boolean;
  /** Human-readable summary, exactly what the first-boot step will show. */
  detail: string;
  /** Structured payload the caller can persist. */
  data?: Record<string, unknown>;
  /** Classification for the DiagnosticReport. */
  classification: ProbeClassification;
}

export interface HardwareProbe {
  /** Matches the first-boot step id (e.g. "gpu", "vram", "telemetry"). */
  id: string;
  /** One-line title shown in the first-boot report. */
  title: string;
  /**
   * The platforms this probe can produce a meaningful answer for. A probe registered
   * for platform 'win32' running on 'linux' returns the platform-unsupported result.
   */
  platforms: readonly string[];
  probe: (ctx: ProbeContext) => Promise<ProbeResult>;
}

export class HardwareProbeRegistry {
  private readonly probes = new Map<string, HardwareProbe[]>();

  /**
   * Register a probe. Multiple probes can share an id — the registry picks the first
   * whose `platforms` includes the current one, so a Windows probe and a Linux fallback
   * can co-exist under the same id.
   */
  register(probe: HardwareProbe): void {
    const arr = this.probes.get(probe.id) ?? [];
    arr.push(probe);
    this.probes.set(probe.id, arr);
  }

  /** Enumerate registered probe ids. */
  known(): string[] {
    return [...this.probes.keys()];
  }

  /**
   * Run the highest-priority probe for `id` on `platform`. If no probe matches the
   * platform, the caller gets the not-implemented result — never a throw.
   */
  async run(id: string, ctx: ProbeContext): Promise<ProbeResult> {
    const candidates = this.probes.get(id) ?? [];
    for (const p of candidates) {
      if (p.platforms.includes(ctx.platform)) {
        try {
          return await p.probe(ctx);
        } catch (error) {
          // A throw is a bug, not a hardware answer. Report it as a probe failure so
          // the bootstrap does not mask the state.
          return {
            ok: false,
            detail: `Probe '${id}' threw: ${error instanceof Error ? error.message : String(error)}`,
            classification: "documented_not_implemented",
          };
        }
      }
    }
    return {
      ok: false,
      detail: `No probe registered for '${id}' on ${ctx.platform}. Validate on the target PC.`,
      classification: "documented_not_implemented",
    };
  }

  /** Run every registered probe id and return a map of results. */
  async runAll(ctx: ProbeContext): Promise<Record<string, ProbeResult>> {
    const out: Record<string, ProbeResult> = {};
    for (const id of this.known()) {
      out[id] = await this.run(id, ctx);
    }
    return out;
  }
}

/**
 * Deliberate non-implementations: the physical-PC probes that will one day replace the
 * synthetic bootstrap steps. Each returns a "not implemented on this platform" result
 * on Linux/macOS, which is honest and which the first-boot report can show as-is.
 *
 * On win32, they still return not-implemented — the physical Windows implementation
 * plugs in AT install time (a `platforms: ["win32"]` probe registered by a Windows-only
 * module) and takes priority over these fallbacks by insertion order.
 */
export function registerPlaceholderProbes(registry: HardwareProbeRegistry): void {
  const placeholder = (id: string, title: string, detail: string): HardwareProbe => ({
    id,
    title,
    platforms: ["linux", "darwin", "win32"],
    async probe() {
      return { ok: false, detail, classification: "documented_not_implemented" };
    },
  });

  registry.register(
    placeholder(
      "gpu.live",
      "Detect the live GPU identity",
      "Live GPU identity was not read. Target: AMD Radeon RX 7900 XT (20 GB). See docs/hardware-validation-checklist.md.",
    ),
  );
  registry.register(
    placeholder(
      "vram.live",
      "Detect live VRAM totals",
      "Live VRAM was not read. Target: 20 GB on the RX 7900 XT. See docs/hardware-validation-checklist.md.",
    ),
  );
  registry.register(
    placeholder(
      "telemetry.amd",
      "AMD ADLX/ADL telemetry",
      "AMD ADLX/ADL clocks, power, and thermals were not read. Windows-only, and only after the ADLX bindings are in place. See docs/hardware-validation-checklist.md.",
    ),
  );
  registry.register(
    placeholder(
      "audio.wasapi",
      "WASAPI audio devices",
      "Audio-device enumeration is Windows-specific (WASAPI). Not implemented; validate on the target PC.",
    ),
  );
  registry.register(
    placeholder(
      "windows.tray",
      "Windows tray + startup registration",
      "Windows tray + startup registration is Windows-only. Simulated on this host; validate on the target PC.",
    ),
  );
  registry.register(
    placeholder(
      "benchmark.harness",
      "Model benchmark harness (with real backend)",
      "The benchmark harness refuses to invent TTFT/throughput without a real backend generating tokens. Requires a running local model on the target PC.",
    ),
  );
}
