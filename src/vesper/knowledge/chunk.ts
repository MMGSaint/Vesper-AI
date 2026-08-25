export interface TextChunk {
  text: string;
  offset: number;
  length: number;
}

export function chunkText(text: string, size = 800, overlap = 120): TextChunk[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= size) {
    return [{ text: normalized, offset: 0, length: normalized.length }];
  }
  const chunks: TextChunk[] = [];
  let offset = 0;
  while (offset < normalized.length) {
    const end = Math.min(normalized.length, offset + size);
    let sliceEnd = end;
    if (end < normalized.length) {
      const breakAt = normalized.lastIndexOf("\n\n", end);
      if (breakAt > offset + size / 3) sliceEnd = breakAt;
    }
    const slice = normalized.slice(offset, sliceEnd).trim();
    if (slice) {
      chunks.push({ text: slice, offset, length: slice.length });
    }
    if (sliceEnd >= normalized.length) break;
    offset = Math.max(offset + 1, sliceEnd - overlap);
  }
  return chunks;
}
