/**
 * Lightweight personal knowledge graph.
 *
 * Not a graph database. JSON adjacency on the existing storage adapter. Edges
 * improve recall, contradiction detection, and "what is related to this project".
 * Relating two nodes is data, never a tool call.
 */

import { createId, nowIso } from "../id.ts";
import type { JsonValue } from "../types.ts";
import type { StorageAdapter } from "../storage.ts";

export const GRAPH_NODE_TYPES = [
  "person",
  "project",
  "preference",
  "workflow",
  "skill",
  "device",
  "resource",
  "decision",
  "memory",
] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

export const GRAPH_EDGE_TYPES = [
  "prefers",
  "depends_on",
  "superseded_by",
  "uses",
  "learned_from",
  "belongs_to",
  "related_to",
] as const;
export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number];

const KEY = "intelligence.graph";
const MAX_NODES = 200;
const MAX_EDGES = 400;
const SECRETISH = /(?:api[_-]?key|secret|password|token|credential|private[_-]?key|bearer)/i;

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  createdAt: string;
}

export interface GraphEdge {
  id: string;
  type: GraphEdgeType;
  from: string;
  to: string;
  createdAt: string;
}

export interface GraphState {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphError";
  }
}

export class KnowledgeGraph {
  private readonly storage: StorageAdapter;
  private loaded = false;
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const raw = await this.storage.get(KEY);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const rec = raw as { nodes?: unknown; edges?: unknown };
    if (Array.isArray(rec.nodes)) {
      for (const item of rec.nodes) {
        const node = coerceNode(item);
        if (node) this.nodes.set(node.id, node);
      }
    }
    if (Array.isArray(rec.edges)) {
      for (const item of rec.edges) {
        const edge = coerceEdge(item);
        if (edge && this.nodes.has(edge.from) && this.nodes.has(edge.to)) {
          this.edges.set(edge.id, edge);
        }
      }
    }
  }

  private async persist(): Promise<void> {
    const state: GraphState = {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    };
    await this.storage.set(KEY, state as unknown as JsonValue);
  }

  async upsertNode(input: { id?: string; type: GraphNodeType; label: string }): Promise<GraphNode> {
    return this.run(async () => {
      await this.load();
      if (SECRETISH.test(input.label)) {
        throw new GraphError("Graph labels cannot carry secret-shaped values.");
      }
      const label = input.label.trim().slice(0, 160);
      if (!label) throw new GraphError("A graph node needs a label.");
      if (!GRAPH_NODE_TYPES.includes(input.type)) throw new GraphError("Unknown node type.");
      const existing = input.id ? this.nodes.get(input.id) : [...this.nodes.values()].find((n) => n.type === input.type && n.label === label);
      if (existing) {
        const next = { ...existing, label, type: input.type };
        this.nodes.set(existing.id, next);
        await this.persist();
        return next;
      }
      if (this.nodes.size >= MAX_NODES) throw new GraphError("Graph node cap reached.");
      const node: GraphNode = {
        id: input.id ?? createId("gnode"),
        type: input.type,
        label,
        createdAt: nowIso(),
      };
      this.nodes.set(node.id, node);
      await this.persist();
      return node;
    });
  }

  async relate(input: { type: GraphEdgeType; from: string; to: string }): Promise<GraphEdge> {
    return this.run(async () => {
      await this.load();
      if (!GRAPH_EDGE_TYPES.includes(input.type)) throw new GraphError("Unknown edge type.");
      if (!this.nodes.has(input.from) || !this.nodes.has(input.to)) {
        throw new GraphError("Both ends of an edge must exist.");
      }
      if (input.from === input.to) throw new GraphError("A node cannot relate to itself.");
      const duplicate = [...this.edges.values()].find(
        (edge) => edge.type === input.type && edge.from === input.from && edge.to === input.to,
      );
      if (duplicate) return duplicate;
      if (this.edges.size >= MAX_EDGES) throw new GraphError("Graph edge cap reached.");
      const edge: GraphEdge = {
        id: createId("gedge"),
        type: input.type,
        from: input.from,
        to: input.to,
        createdAt: nowIso(),
      };
      this.edges.set(edge.id, edge);
      await this.persist();
      return edge;
    });
  }

  async neighbors(nodeId: string): Promise<{ node: GraphNode; edge: GraphEdge }[]> {
    await this.load();
    const out: { node: GraphNode; edge: GraphEdge }[] = [];
    for (const edge of this.edges.values()) {
      if (edge.from === nodeId) {
        const node = this.nodes.get(edge.to);
        if (node) out.push({ node, edge });
      } else if (edge.to === nodeId) {
        const node = this.nodes.get(edge.from);
        if (node) out.push({ node, edge });
      }
    }
    return out;
  }

  async conflictingPreferences(): Promise<{ a: GraphNode; b: GraphNode }[]> {
    await this.load();
    const prefers = [...this.edges.values()].filter((edge) => edge.type === "prefers");
    const byFrom = new Map<string, GraphEdge[]>();
    for (const edge of prefers) {
      const list = byFrom.get(edge.from) ?? [];
      list.push(edge);
      byFrom.set(edge.from, list);
    }
    const conflicts: { a: GraphNode; b: GraphNode }[] = [];
    for (const edges of byFrom.values()) {
      if (edges.length < 2) continue;
      for (let i = 0; i < edges.length; i++) {
        for (let j = i + 1; j < edges.length; j++) {
          const a = this.nodes.get(edges[i]!.to);
          const b = this.nodes.get(edges[j]!.to);
          if (a && b && a.label !== b.label) conflicts.push({ a, b });
        }
      }
    }
    return conflicts;
  }

  async snapshot(): Promise<GraphState> {
    await this.load();
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }
}

function coerceNode(item: unknown): GraphNode | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.label !== "string") return null;
  if (!GRAPH_NODE_TYPES.includes(rec.type as GraphNodeType)) return null;
  if (SECRETISH.test(rec.label)) return null;
  return {
    id: rec.id,
    type: rec.type as GraphNodeType,
    label: rec.label.slice(0, 160),
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : nowIso(),
  };
}

function coerceEdge(item: unknown): GraphEdge | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.from !== "string" || typeof rec.to !== "string") return null;
  if (!GRAPH_EDGE_TYPES.includes(rec.type as GraphEdgeType)) return null;
  return {
    id: rec.id,
    type: rec.type as GraphEdgeType,
    from: rec.from,
    to: rec.to,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : nowIso(),
  };
}
