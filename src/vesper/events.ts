import { createId, nowIso } from "./id.ts";
import type { Logger } from "./logging.ts";
import type { StorageAdapter } from "./storage.ts";
import type { JsonValue, VesperEvent } from "./types.ts";

type Handler = (event: VesperEvent) => void;

const STORAGE_KEY = "events.recent";

export class EventBus {
  private events: VesperEvent[] = [];
  private handlers = new Map<string, Set<Handler>>();
  private anyHandlers = new Set<Handler>();
  private readonly log: Logger;
  private readonly limit: number;
  private readonly storage?: StorageAdapter;
  /** Writes are serialized and coalesced so a burst of events cannot pile up. */
  private saving: Promise<void> = Promise.resolve();
  private saveQueued = false;

  constructor(log: Logger, limit = 500, storage?: StorageAdapter) {
    this.log = log;
    this.limit = limit;
    this.storage = storage;
  }

  /**
   * Load the persisted tail. Correlation is only useful across a restart if the events
   * that explain a change survive it - and a crash is exactly when that matters most.
   */
  async hydrate(): Promise<number> {
    if (!this.storage) return 0;
    try {
      const raw = await this.storage.get(STORAGE_KEY);
      if (!Array.isArray(raw)) return 0;
      const restored = raw.filter((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
        const candidate = item as Record<string, unknown>;
        return (
          typeof candidate.id === "string" &&
          typeof candidate.at === "string" &&
          typeof candidate.type === "string"
        );
      }) as unknown as VesperEvent[];
      // Restored events go before anything emitted during startup.
      this.events = [...restored, ...this.events].slice(-this.limit);
      return restored.length;
    } catch (error) {
      // A corrupt event log costs history, never availability.
      this.log.warn("event", "Could not restore the event log", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /** Flush pending writes, for a clean shutdown. */
  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    if (!this.storage || this.saveQueued) return;
    this.saveQueued = true;
    this.saving = this.saving
      .then(async () => {
        this.saveQueued = false;
        await this.storage?.set(STORAGE_KEY, this.events as unknown as JsonValue);
      })
      .catch((error: unknown) => {
        this.saveQueued = false;
        // Never let a failed event write reach the process as an unhandled rejection.
        this.log.warn("event", "Could not persist the event log", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  emit(partial: Omit<VesperEvent, "id" | "at"> & { at?: string }): VesperEvent {
    const event: VesperEvent = {
      id: createId("evt"),
      at: partial.at ?? nowIso(),
      type: partial.type,
      title: partial.title,
      detail: partial.detail,
      workspaceId: partial.workspaceId,
      severity: partial.severity,
      data: partial.data,
    };
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    this.log.info("event", event.title, { type: event.type, severity: event.severity });
    this.schedulePersist();
    this.handlers.get(event.type)?.forEach((handler) => handler(event));
    this.anyHandlers.forEach((handler) => handler(event));
    return event;
  }

  on(type: string, handler: Handler): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  }

  onAny(handler: Handler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  recent(filter?: { type?: string; limit?: number }): VesperEvent[] {
    const list = filter?.type
      ? this.events.filter((event) => event.type === filter.type)
      : this.events;
    return list.slice(-(filter?.limit ?? 20));
  }

  /** The whole retained window, for correlation. */
  all(): VesperEvent[] {
    return this.events.slice();
  }
}
