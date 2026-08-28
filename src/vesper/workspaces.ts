import type { VesperConfig } from "./config.ts";
import type { Logger } from "./logging.ts";
import type { StorageAdapter } from "./storage.ts";
import type { WorkspaceDefinition } from "./types.ts";

/**
 * Which workspace Vesper is currently in.
 *
 * The choice used to live entirely in memory: switch worked for the running process,
 * survived nothing. "Switched to Gaming." followed by a restart put the owner back in
 * General with no notice, so a `workspace_switch` from a script or a scheduled task did
 * nothing durable. The `data-remote` code path did not exist here — remote sessions get
 * their own live re-check, and this is only the local, persistent choice.
 *
 * Persistence is best-effort. The store may not be writable during a shutdown; if it
 * isn't, the switch still takes effect *now* and is logged. That is the same shape as
 * `persistConfirmations` — the current process gets the truth, the next process gets a
 * fresh best-effort read at startup. Nothing is authoritatively held in storage that
 * cannot be reconstructed from the config's default.
 */

const STORAGE_KEY = "workspace.current";

interface StoredCurrent {
  currentId: string;
}

export class WorkspaceManager {
  private currentId: string;
  private readonly workspaces: Map<string, WorkspaceDefinition>;
  private readonly storage?: StorageAdapter;
  private readonly log?: Logger;
  private loaded = false;

  constructor(config: VesperConfig, options?: { storage?: StorageAdapter; log?: Logger }) {
    this.workspaces = new Map(config.workspaces.map((ws) => [ws.id, ws]));
    this.currentId = config.defaultWorkspaceId;
    if (!this.workspaces.has(this.currentId)) {
      const first = config.workspaces[0];
      this.currentId = first?.id ?? "general";
    }
    this.storage = options?.storage;
    this.log = options?.log;
  }

  /**
   * Read the last stored choice, if any. Idempotent, safe to call from anywhere — but
   * `current()` and `switchTo` also call it lazily so a caller does not have to. Never
   * throws: an unreadable store falls back to the configured default.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storage) return;
    try {
      const raw = await this.storage.get(STORAGE_KEY);
      if (!raw || typeof raw !== "object") return;
      const id = (raw as Partial<StoredCurrent>).currentId;
      // Ignore an id the current config does not know about. A workspace can be removed
      // from the config file at any time; the stored value must not resurrect it.
      //
      // Mutation-honest note: the `this.workspaces.has(id)` half is defence-in-depth. If
      // it were removed, `currentId` would take the stored id, but `current()` already
      // falls back to a synthesised "general" for an unknown id — so no test in this
      // file catches the difference. Kept because a future edit that removes the
      // fallback in `current()` would otherwise silently start honouring stored ids
      // that no longer exist.
      if (typeof id === "string" && this.workspaces.has(id)) {
        this.currentId = id;
      }
    } catch (error) {
      // Best-effort. Fall back to the configured default and stay quiet unless the
      // caller passed a logger.
      this.log?.warn?.("lifecycle", "Could not read the stored workspace choice", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  current(): WorkspaceDefinition {
    return this.workspaces.get(this.currentId) ?? {
      id: "general",
      name: "General",
      description: "Default workspace",
    };
  }

  list(): WorkspaceDefinition[] {
    return [...this.workspaces.values()];
  }

  get(id: string): WorkspaceDefinition | undefined {
    return this.workspaces.get(id);
  }

  /**
   * Switch to a workspace and persist the choice.
   *
   * Persistence is fire-and-forget: the switch takes effect in memory before the write
   * starts, and a write failure is logged rather than surfaced. The alternative would
   * be to make callers await a disk write on every switch — including from a tool call
   * inside a turn — for a value that is easily reconstructed from the default. Losing
   * the write costs "workspace forgotten across restart"; blocking the caller would
   * cost every turn during a slow disk.
   */
  switchTo(idOrName: string): WorkspaceDefinition | undefined {
    const needle = idOrName.trim().toLowerCase();
    const match = this.list().find(
      (ws) => ws.id === needle || ws.name.toLowerCase() === needle,
    );
    if (!match) return undefined;
    this.currentId = match.id;
    this.persist();
    return match;
  }

  private persist(): void {
    if (!this.storage) return;
    const payload: StoredCurrent = { currentId: this.currentId };
    void this.storage.set(STORAGE_KEY, payload as unknown as import("./types.ts").JsonValue).catch(
      (error: unknown) => {
        this.log?.warn?.("lifecycle", "Could not persist the workspace choice", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }
}
