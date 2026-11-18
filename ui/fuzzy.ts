/**
 * Small fuzzy matcher for pickers. Every whitespace-separated token must match
 * the text as a subsequence (one dropped or mistyped letter is tolerated for
 * tokens of 4+ letters). Word starts and consecutive runs score higher, so
 * "grc" ranks "Groceries" first and "food din" finds "Food / Dining".
 */
export interface FuzzyResult {
  score: number;
  /** Matched character positions in the text, for highlighting. */
  indices: number[];
}

const isWordStart = (text: string, i: number) => {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  const cur = text[i]!;
  if (!/[a-z0-9]/i.test(prev)) return true;
  return /[a-z]/.test(prev) && /[A-Z]/.test(cur); // camelCase boundary
};

function scoreToken(token: string, text: string, lower: string): FuzzyResult | null {
  let best: FuzzyResult | null = null;
  for (let start = lower.indexOf(token[0]!); start !== -1; start = lower.indexOf(token[0]!, start + 1)) {
    const indices = [start];
    let pos = start;
    for (let k = 1; k < token.length; k++) {
      pos = lower.indexOf(token[k]!, pos + 1);
      if (pos === -1) break;
      indices.push(pos);
    }
    if (indices.length !== token.length) break; // later starts can only match less
    let score = 0;
    indices.forEach((i, k) => {
      score += 1;
      if (isWordStart(text, i)) score += 8;
      if (k > 0) {
        const gap = i - indices[k - 1]! - 1;
        score += gap === 0 ? 6 : -Math.min(gap * 0.5, 5);
      }
    });
    if (start === 0) score += 6;
    if (!best || score > best.score) best = { score, indices };
  }
  return best;
}

function matchToken(token: string, text: string, lower: string): FuzzyResult | null {
  const exact = scoreToken(token, text, lower);
  if (exact || token.length < 4) return exact;
  // One typo: try dropping each letter of the token, at a cost.
  let best: FuzzyResult | null = null;
  for (let i = 0; i < token.length; i++) {
    const r = scoreToken(token.slice(0, i) + token.slice(i + 1), text, lower);
    if (r && (!best || r.score > best.score)) best = r;
  }
  return best && { score: best.score - 12, indices: best.indices };
}

export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { score: 0, indices: [] };
  const lower = text.toLowerCase();
  let score = 0;
  const indices = new Set<number>();
  for (const token of tokens) {
    const r = matchToken(token, text, lower);
    if (!r) return null;
    score += r.score;
    r.indices.forEach((i) => indices.add(i));
  }
  if (lower.startsWith(query.trim().toLowerCase())) score += 10;
  return { score, indices: [...indices].sort((a, b) => a - b) };
}
