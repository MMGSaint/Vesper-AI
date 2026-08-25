export interface EmbeddingProvider {
  id: string;
  available(): boolean;
  embed(texts: string[]): Promise<number[][] | null>;
  embedSync?(text: string): number[];
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
