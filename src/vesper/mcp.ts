import type { ToolRegistry } from './tools/registry.ts';
import type { JsonObject, ToolSpec } from './types.ts';

/**
 * MCP-compatible projection over Vesper's existing ToolRegistry.
 *
 * We intentionally do not add a second authorization system here. MCP is the
 * mature transport/schema, while the existing registry remains the authority
 * for validation, confirmation, scopes, remote-origin narrowing and audit.
 *
 * This module is transport-neutral: a stdio or local IPC host can feed parsed
 * JSON-RPC messages into handleMcpRequest without giving MCP direct machine
 * authority.
 */

interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export function createMcpProjection(registry: ToolRegistry, workspaceId: string) {
  return {
    async handle(request: McpRequest): Promise<McpResponse> {
      try {
        if (request.jsonrpc !== '2.0') return error(request.id, -32600, 'Invalid JSON-RPC version.');

        if (request.method === 'tools/list') {
          return ok(request.id, {
            tools: registry.list(workspaceId).map(toMcpTool),
          });
        }

        if (request.method === 'tools/call') {
          const params = request.params ?? {};
          const name = typeof params.name === 'string' ? params.name : null;
          const args = isObject(params.arguments) ? params.arguments : {};
          if (!name) return error(request.id, -32602, 'tools/call requires a tool name.');

          const record = await registry.invoke({
            name,
            args,
            workspaceId,
            confirmed: params['confirmed'] === true,
            dryRun: params['dryRun'] === true,
            origin: { kind: 'local' },
          });

          return ok(request.id, {
            content: [{ type: 'text', text: record.result?.summary ?? record.decision.reason }],
            structuredContent: record.result?.data ?? null,
            isError: record.result?.ok === false,
          });
        }

        return error(request.id, -32601, 'Method not supported.');
      } catch (cause) {
        return error(request.id, -32603, cause instanceof Error ? cause.message : String(cause));
      }
    },
  };
}

function toMcpTool(spec: ToolSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.parameters,
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ok(id: string | number, result: Record<string, unknown>): McpResponse {
  return { jsonrpc: '2.0', id, result };
}

function error(id: string | number, code: number, message: string): McpResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
