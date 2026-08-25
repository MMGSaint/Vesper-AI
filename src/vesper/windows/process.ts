import { spawn } from "node:child_process";
import { isSafeExecutableName, parseTasklistCsv } from "../security.ts";
import type { ProcessInfo } from "../types.ts";

export { parseTasklistCsv };

export async function listWindowsProcesses(input?: {
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
}): Promise<{ ok: boolean; processes: ProcessInfo[]; detail: string }> {
  const platform = input?.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      ok: false,
      processes: [],
      detail: "Live process listing is Windows-only. Using the simulated host on this machine.",
    };
  }
  const spawnImpl = input?.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    const child = spawnImpl("tasklist", ["/FO", "CSV", "/NH"], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, processes: [], detail: "tasklist timed out." });
    }, 2000);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, processes: [], detail: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, processes: [], detail: `tasklist exited ${code}` });
        return;
      }
      const parsed = parseTasklistCsv(stdout).map((row) => ({
        pid: row.pid,
        name: row.name,
        memoryMB: row.memoryMB,
      }));
      resolve({ ok: true, processes: parsed, detail: `${parsed.length} processes.` });
    });
  });
}

export function assertApprovedExecutable(executable: string): string {
  if (!isSafeExecutableName(executable)) {
    throw new Error("Executable name is not safe to spawn.");
  }
  return executable;
}
