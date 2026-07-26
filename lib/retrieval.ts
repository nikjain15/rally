/**
 * Retrieval for the grounded read paths (Ask, channel summary).
 *
 * The problem this fixes: "load the last N and stuff the window" surfaces the most RECENT messages,
 * not the most RELEVANT — so a question about a decision made 200 messages ago gets an out-of-window
 * transcript and an unfaithful answer. This is a small, dependency-free BM25 ranker: score the
 * candidate messages against the question, keep the top matches, and widen each with a few
 * neighbours so the answer keeps its conversational context.
 *
 * It also gives the *bad-retrieval* failure mode a first-class exit: when nothing scores above zero,
 * `relevant` is false and the caller abstains ("no relevant messages") instead of asking the model
 * to answer from an irrelevant window. Recency mode (empty query) preserves the old behaviour for
 * an unfocused summary, where "most recent" IS the right selection.
 */

export type RankableMessage = { author: string; body: string };

export type SelectResult<T> = {
  /** False only in keyword mode when no candidate matched the query — the abstention signal. */
  relevant: boolean;
  /** Chosen messages, in the original (chronological) order. */
  selected: T[];
};

export type SelectOptions = {
  /** How many top-scoring messages to anchor on. */
  topK?: number;
  /** Neighbours to include on each side of an anchor, for context. */
  window?: number;
};

// Common words that carry no retrieval signal. Small on purpose — this is ranking, not NLP.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'about', 'as', 'by', 'from', 'that', 'this',
  'it', 'its', 'we', 'you', 'i', 'they', 'he', 'she', 'do', 'did', 'does', 'what', 'when',
  'who', 'why', 'how', 'where', 'which', 'our', 'my', 'me', 'us', 'them', 'their', 'so',
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

const K1 = 1.5;
const B = 0.75;

/**
 * Rank `messages` against `query` with BM25 and return an ordered slice. Pure and synchronous.
 * - Empty/whitespace query → recency mode: the last `topK` messages, `relevant` true.
 * - Otherwise → keyword mode: anchors on the top `topK` scoring messages, widens by `window`
 *   neighbours, returns them chronologically. `relevant` is false iff nothing scored.
 */
export function selectRelevant<T extends RankableMessage>(
  messages: T[],
  query: string,
  opts: SelectOptions = {},
): SelectResult<T> {
  const topK = opts.topK ?? 12;
  const window = opts.window ?? 2;

  const queryTerms = tokenize(query);
  if (messages.length === 0) return { relevant: queryTerms.length === 0, selected: [] };

  // Recency mode: no usable query terms → keep the most recent slice, in order.
  if (queryTerms.length === 0) {
    return { relevant: true, selected: messages.slice(-topK) };
  }

  const docs = messages.map((m) => tokenize(m.body));
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
  const N = docs.length;

  // Document frequency per query term, then IDF (BM25's non-negative form).
  const uniqueTerms = [...new Set(queryTerms)];
  const df = new Map<string, number>();
  for (const term of uniqueTerms) {
    df.set(term, docs.reduce((c, d) => c + (d.includes(term) ? 1 : 0), 0));
  }
  const idf = new Map<string, number>();
  for (const term of uniqueTerms) {
    const n = df.get(term) ?? 0;
    idf.set(term, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  const scored = docs.map((d, i) => {
    const dl = d.length;
    let score = 0;
    for (const term of uniqueTerms) {
      const tf = d.reduce((c, t) => c + (t === term ? 1 : 0), 0);
      if (tf === 0) continue;
      score += (idf.get(term) ?? 0) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (dl / avgdl))));
    }
    return { i, score };
  });

  const anchors = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.i);

  if (anchors.length === 0) return { relevant: false, selected: [] };

  // Widen each anchor into a small window, dedupe, and return in chronological order.
  const keep = new Set<number>();
  for (const i of anchors) {
    for (let j = Math.max(0, i - window); j <= Math.min(N - 1, i + window); j++) keep.add(j);
  }
  const selected = [...keep].sort((a, b) => a - b).map((i) => messages[i]);
  return { relevant: true, selected };
}
