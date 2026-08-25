import { createId, nowIso } from "./id.ts";
import type { Logger } from "./logging.ts";
import type { VesperEvent } from "./types.ts";

type Handler = (event: VesperEvent) => void;

export class EventBus {
  private events: VesperEvent[] = [];
  private handlers = new Map<string, Set<Handler>>();
  private anyHandlers = new Set<Handler>();
  private readonly log: Logger;
  private readonly limit: number;

  constructor(log: Logger, limit = 500) {
    this.log = log;
    this.limit = limit;
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
}
