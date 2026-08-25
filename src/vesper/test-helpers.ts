import { createRuntime, type VesperRuntime } from "./runtime.ts";
import { createScriptedProvider } from "./models/scripted.ts";
import { MemoryStorage } from "./storage.ts";
import type { ScriptedTurn } from "./models/scripted.ts";

export async function testRuntime(options?: {
  script?: ScriptedTurn[];
  config?: Record<string, unknown>;
}): Promise<VesperRuntime> {
  const providers = options?.script
    ? [createScriptedProvider(options.script)]
    : undefined;
  const runtime = await createRuntime({
    storage: new MemoryStorage(),
    skipDiscovery: true,
    providers,
    config: options?.config,
  });
  await runtime.start();
  return runtime;
}
