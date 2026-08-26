/**
 * BM25 over the in-memory document set. IDF and length normalisation are the whole
 * point: without them a document that is mostly filler words outranks a short, exact
 * answer simply because it repeats "the" more often.
 */

const K1 = 1.2;
const B = 0.75;

export interface LexicalDocument {
  tf: Map<string, number>;
  length: number;
}

export interface LexicalIndex {
  docs: LexicalDocument[];
  df: Map<string, number>;
  avgdl: number;
  count: number;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 1);
}

export function buildLexicalIndex(texts: string[]): LexicalIndex {
  const docs: LexicalDocument[] = [];
  const df = new Map<string, number>();
  let total = 0;
  for (const text of texts) {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    docs.push({ tf, length: tokens.length });
    total += tokens.length;
  }
  return { docs, df, avgdl: docs.length ? total / docs.length : 0, count: docs.length };
}

export function bm25(queryTokens: string[], index: LexicalIndex, docIndex: number): number {
  const doc = index.docs[docIndex];
  if (!doc || doc.length === 0 || index.avgdl === 0) return 0;
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const tf = doc.tf.get(token);
    if (!tf) continue;
    const df = index.df.get(token) ?? 0;
    const idf = Math.log(1 + (index.count - df + 0.5) / (df + 0.5));
    score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + B * (doc.length / index.avgdl)));
  }
  return score;
}
