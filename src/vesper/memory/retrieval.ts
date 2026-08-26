import type { MemoryEntry } from "../types.ts";

/**
 * Filler words appear in nearly every stored value, so scoring them would let a long
 * unrelated memory outrank a short exact one on a natural-language question like
 * "what did I say about streaming on Fridays".
 */
const STOPWORDS = new Set([
  "about", "after", "again", "all", "and", "any", "are", "back", "been", "before",
  "but", "can", "did", "does", "doing", "for", "from", "get", "had", "has", "have",
  "her", "here", "him", "his", "how", "into", "its", "just", "know", "like", "me",
  "more", "most", "my", "not", "now", "of", "off", "on", "once", "one", "only",
  "or", "other", "our", "out", "over", "please", "said", "same", "say", "she",
  "should", "so", "some", "still", "such", "tell", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "to", "too", "under",
  "until", "up", "us", "use", "very", "was", "we", "were", "what", "when", "where",
  "which", "while", "who", "why", "will", "with", "would", "you", "your",
]);

const WEIGHT_KEY_EXACT = 100;
const WEIGHT_KEY_CONTAINS_QUERY = 40;
const WEIGHT_QUERY_MENTIONS_KEY = 20;
const WEIGHT_VALUE_CONTAINS_QUERY = 25;
const WEIGHT_TOKEN_KEY = 6;
const WEIGHT_TOKEN_TAG = 4;
const WEIGHT_TOKEN_VALUE = 3;
const WEIGHT_TOKEN_CATEGORY = 2;
const WEIGHT_COVERAGE = 6;
const WEIGHT_WORKSPACE_EXACT = 2;
const WEIGHT_WORKSPACE_GLOBAL = 0.5;
const WEIGHT_RECENCY = 1.5;
const RECENCY_HALF_LIFE_DAYS = 30;
/** Below this, a prefix match is more likely a coincidence than a shared stem. */
const MIN_STEM_LENGTH = 4;

export interface PreparedQuery {
  raw: string;
  tokens: string[];
  workspaceId?: string;
  now: number;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 1);
}

export function prepareQuery(
  query: string,
  options?: { workspaceId?: string; now?: number },
): PreparedQuery | null {
  const raw = query.trim().toLowerCase();
  if (!raw) return null;
  const all = tokenize(raw);
  const content = all.filter((token) => !STOPWORDS.has(token));
  return {
    raw,
    // A query made entirely of filler ("what is it") still deserves its literal terms
    // rather than silently becoming an empty query that matches everything.
    tokens: content.length ? content : all,
    workspaceId: options?.workspaceId,
    now: options?.now ?? Date.now(),
  };
}

export function scoreMemory(entry: MemoryEntry, query: PreparedQuery): number {
  const key = entry.key.toLowerCase();
  const value = entry.value.toLowerCase();
  let score = 0;

  if (key === query.raw) score += WEIGHT_KEY_EXACT;
  else if (key.includes(query.raw)) score += WEIGHT_KEY_CONTAINS_QUERY;
  else if (mentionsWholeWord(query.raw, key)) score += WEIGHT_QUERY_MENTIONS_KEY;
  if (value.includes(query.raw)) score += WEIGHT_VALUE_CONTAINS_QUERY;

  const keyTokens = new Set(tokenize(entry.key));
  const valueTokens = new Set(tokenize(entry.value));
  const tagTokens = new Set((entry.tags ?? []).flatMap((tag) => tokenize(tag)));
  const categoryTokens = new Set(tokenize(entry.category));

  let matched = 0;
  for (const token of query.tokens) {
    let best = 0;
    if (hasTerm(keyTokens, token)) best = WEIGHT_TOKEN_KEY;
    if (best < WEIGHT_TOKEN_TAG && hasTerm(tagTokens, token)) best = WEIGHT_TOKEN_TAG;
    if (best < WEIGHT_TOKEN_VALUE && hasTerm(valueTokens, token)) best = WEIGHT_TOKEN_VALUE;
    if (best < WEIGHT_TOKEN_CATEGORY && hasTerm(categoryTokens, token)) best = WEIGHT_TOKEN_CATEGORY;
    if (best > 0) {
      // Distinct terms only: a value that repeats a word cannot inflate its own rank.
      score += best;
      matched += 1;
    }
  }
  if (score === 0) return 0;
  if (query.tokens.length) score += (matched / query.tokens.length) * WEIGHT_COVERAGE;

  if (query.workspaceId) {
    if (entry.workspaceId === query.workspaceId) score += WEIGHT_WORKSPACE_EXACT;
    else if (!entry.workspaceId) score += WEIGHT_WORKSPACE_GLOBAL;
  }
  score += recencyBoost(entry.updatedAt, query.now);
  return score;
}

function recencyBoost(updatedAt: string, now: number): number {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return 0;
  const ageDays = Math.max(0, (now - at) / 86_400_000);
  return WEIGHT_RECENCY / (1 + ageDays / RECENCY_HALF_LIFE_DAYS);
}

function hasTerm(field: Set<string>, token: string): boolean {
  if (field.has(token)) return true;
  if (token.length < MIN_STEM_LENGTH) return false;
  for (const term of field) {
    if (term.length < MIN_STEM_LENGTH) continue;
    if (term.startsWith(token) || token.startsWith(term)) return true;
  }
  return false;
}

/**
 * A bare `includes` would match "on" inside "tone", so a key only counts as mentioned
 * when it stands alone in the sentence.
 */
function mentionsWholeWord(haystack: string, needle: string): boolean {
  if (needle.length < MIN_STEM_LENGTH) return false;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = haystack[index - 1];
    const after = haystack[index + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = index + 1;
  }
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9]/.test(char);
}
