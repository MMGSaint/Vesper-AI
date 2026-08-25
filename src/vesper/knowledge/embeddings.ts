export interface EmbeddingProvider {
  id: string;
  available(): boolean;
  embed(texts: string[]): Promise<number[][] | null>;
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
