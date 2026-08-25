import type { PermissionLevel, ToolSpec } from "../types.ts";

export interface McpBridgeStatus {
  enabled: boolean;
  required: boolean;
  servers: string[];
  detail: string;
}

export function mcpBridgeStatus(input?: { enabled?: boolean }): McpBridgeStatus {
  const enabled = Boolean(input?.enabled);
  return {
    enabled,
    required: false,
    servers: enabled ? [] : [],
    detail: enabled
      ? "Optional MCP bridge is enabled in config, but no cloud MCP server is required at runtime. Tools still pass the permission gate."
      : "MCP integrations are optional and disabled. Vesper stays local-first.",
  };
}

export function mcpToolPermission(_spec: ToolSpec): PermissionLevel {
  return "confirm";
}
