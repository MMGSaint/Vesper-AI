import { createRuntime, type VesperRuntime } from "./runtime.ts";
import { createScriptedProvider } from "./models/scripted.ts";
import { MemoryStorage } from "./storage.ts";
import type { ScriptedTurn } from "./models/scripted.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDeviceIdentity,
  type PublicDeviceIdentity,
} from "./distributed/identity.ts";

export async function testRuntime(options?: {
  script?: ScriptedTurn[];
  config?: Record<string, unknown>;
  /** Drive the runtime with specific providers, for tests that inspect model traffic. */
  providers?: NonNullable<Parameters<typeof createRuntime>[0]>["providers"];
}): Promise<VesperRuntime> {
  const providers =
    options?.providers ??
    (options?.script ? [createScriptedProvider(options.script)] : undefined);
  const runtime = await createRuntime({
    storage: new MemoryStorage(),
    skipDiscovery: true,
    providers,
    config: options?.config,
  });
  await runtime.start();
  return runtime;
}

/**
 * Enrol a peer device and set its trust, so a test can hold a client session.
 *
 * Client sessions are bound to a registered device, which means every test that talks to
 * the gateway has to go through the same admission the real thing does. That is the
 * point: there is no test-only path onto the protocol.
 */
export async function enrolCompanion(
  runtime: VesperRuntime,
  options: { name?: string; trust?: "trusted" | "restricted" | "pending" } = {},
): Promise<PublicDeviceIdentity> {
  const dirs = { data: await mkdtemp(join(tmpdir(), "vesper-companion-")) };
  const { identity } = await loadDeviceIdentity({
    dirs,
    name: options.name ?? "phone",
    deviceType: "phone",
    vesperVersion: "test",
  });
  const peer = identity.publicIdentity();
  await runtime.devices.enrol(peer);
  const trust = options.trust ?? "trusted";
  if (trust !== "pending") await runtime.devices.setTrust(peer.deviceId, trust);
  return peer;
}
