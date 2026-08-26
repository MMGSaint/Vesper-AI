export interface EmbeddingProvider {
  id: string;
  available(): boolean;
  embed(texts: string[]): Promise<number[][] | null>;
  /**
   * Only lexical providers can embed without I/O. A model-backed provider omits this,
   * which is why retrieval has both a synchronous and an awaitable search path.
   */
  embedSync?(text: string): number[];
  /** Human-readable state for diagnostics. */
  detail?(): string;
}

export function createUnavailableEmbeddings(): EmbeddingProvider {
  return {
    id: "none",
    available: () => false,
    async embed() {
      return null;
    },
  };
}

export function createHashEmbeddings(dimensions = 64): EmbeddingProvider {
  return {
    id: "lexical-hash",
    available: () => true,
    embedSync(text: string) {
      return hashEmbed(text, dimensions);
    },
    async embed(texts: string[]) {
      return texts.map((text) => hashEmbed(text, dimensions));
    },
  };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function hashEmbed(text: string, dim: number): number[] {
  const vec = new Array(dim).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 1);
  for (const token of tokens) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % dim;
    const sign = (h >>> 31) === 0 ? 1 : -1;
    vec[idx] += sign;
    if (token.length >= 4) {
      const gram = token.slice(0, 3);
      let g = 2166136261;
      for (let i = 0; i < gram.length; i += 1) {
        g ^= gram.charCodeAt(i);
        g = Math.imul(g, 16777619);
      }
      vec[Math.abs(g) % dim] += sign * 0.5;
    }
  }
  let norm = 0;
  for (const value of vec) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((value) => value / norm);
}

/**
 * Embeddings produced by a local model backend (currently Ollama's `/api/embed`).
 *
 * The provider is injected rather than constructed here so knowledge retrieval does
 * not grow its own HTTP client, and so tests can drive it with a fake.
 */
export function createProviderEmbeddings(input: {
  id: string;
  model: string;
  embed: (texts: string[], model: string) => Promise<number[][] | null>;
  isAvailable: () => boolean;
  /** Ollama handles batching well, but an unbounded batch is still a bad request. */
  batchSize?: number;
}): EmbeddingProvider {
  const batchSize = Math.max(1, input.batchSize ?? 64);
  let lastError: string | null = null;

  return {
    id: input.id,
    available: () => input.isAvailable(),
    detail() {
      if (!input.isAvailable()) return `${input.id} is not reachable; embeddings are unavailable.`;
      if (lastError) return `${input.id} last failed: ${lastError}`;
      return `${input.id} embeddings via ${input.model}.`;
    },
    async embed(texts: string[]) {
      if (texts.length === 0) return [];
      if (!input.isAvailable()) return null;
      const out: number[][] = [];
      try {
        for (let i = 0; i < texts.length; i += batchSize) {
          const batch = texts.slice(i, i + batchSize);
          const vectors = await input.embed(batch, input.model);
          // A partial batch is not a usable index: fail the whole call rather than
          // silently returning a shorter vector list than documents.
          if (!vectors || vectors.length !== batch.length) {
            lastError = `backend returned ${vectors ? vectors.length : 0} vectors for ${batch.length} inputs`;
            return null;
          }
          out.push(...vectors);
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        return null;
      }
      lastError = null;
      return out;
    },
  };
}

/**
 * Prefer a real embedding model, degrade to lexical hashing when it is absent or
 * failing. Retrieval keeps working either way; only its quality changes, and the
 * active mode is reported rather than hidden.
 */
export function createFallbackEmbeddings(
  primary: EmbeddingProvider,
  fallback: EmbeddingProvider = createHashEmbeddings(),
): EmbeddingProvider {
  let usingFallback = false;
  let reason = "not attempted yet";

  return {
    get id() {
      return usingFallback ? `${fallback.id} (fallback from ${primary.id})` : primary.id;
    },
    available: () => primary.available() || fallback.available(),
    detail() {
      return usingFallback
        ? `Using ${fallback.id} because ${primary.id} is unavailable: ${reason}`
        : (primary.detail?.() ?? `Using ${primary.id}.`);
    },
    // Only the lexical path can answer synchronously, so a sync caller always gets
    // lexical vectors. Mixing the two would compare vectors from different spaces.
    embedSync: fallback.embedSync ? (text: string) => fallback.embedSync!(text) : undefined,
    async embed(texts: string[]) {
      if (primary.available()) {
        const vectors = await primary.embed(texts);
        if (vectors) {
          usingFallback = false;
          return vectors;
        }
        reason = primary.detail?.() ?? "embedding call failed";
      } else {
        reason = primary.detail?.() ?? "backend not reachable";
      }
      usingFallback = true;
      return fallback.embed(texts);
    },
  };
}
