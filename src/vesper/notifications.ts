import { createId, nowIso } from "./id.ts";
import type { VesperNotification } from "./types.ts";

export class NotificationHub {
  private items: VesperNotification[] = [];
  private lastByKey = new Map<string, number>();
  private readonly enabled: boolean;
  private readonly cooldownMs: number;

  constructor(enabled: boolean, cooldownMs: number) {
    this.enabled = enabled;
    this.cooldownMs = cooldownMs;
  }

  push(input: Omit<VesperNotification, "id" | "at"> & { at?: string }): VesperNotification | null {
    if (!this.enabled) return null;
    const now = Date.now();
    if (input.cooldownKey) {
      const last = this.lastByKey.get(input.cooldownKey) ?? 0;
      if (now - last < this.cooldownMs) return null;
      this.lastByKey.set(input.cooldownKey, now);
    }
    const item: VesperNotification = {
      id: createId("note"),
      at: input.at ?? nowIso(),
      title: input.title,
      body: input.body,
      kind: input.kind,
      cooldownKey: input.cooldownKey,
    };
    this.items.push(item);
    if (this.items.length > 100) this.items.splice(0, this.items.length - 100);
    return item;
  }

  recent(limit = 20): VesperNotification[] {
    return this.items.slice(-limit);
  }
}
