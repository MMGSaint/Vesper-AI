import type { VesperConfig } from "./config.ts";
import type { WorkspaceDefinition } from "./types.ts";

export class WorkspaceManager {
  private currentId: string;
  private readonly workspaces: Map<string, WorkspaceDefinition>;

  constructor(config: VesperConfig) {
    this.workspaces = new Map(config.workspaces.map((ws) => [ws.id, ws]));
    this.currentId = config.defaultWorkspaceId;
    if (!this.workspaces.has(this.currentId)) {
      const first = config.workspaces[0];
      this.currentId = first?.id ?? "general";
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

  switchTo(idOrName: string): WorkspaceDefinition | undefined {
    const needle = idOrName.trim().toLowerCase();
    const match = this.list().find(
      (ws) => ws.id === needle || ws.name.toLowerCase() === needle,
    );
    if (!match) return undefined;
    this.currentId = match.id;
    return match;
  }
}
