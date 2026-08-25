import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEntry } from "./types.ts";

export function createJsonlSink(filePath: string): (entry: AuditEntry) => void {
  let queue: Promise<unknown> = Promise.resolve();
  return (entry) => {
    queue = queue.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    }, async () => {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    });
  };
}

export async function flushSink(sink: (entry: AuditEntry) => void): Promise<void> {
  void sink;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
