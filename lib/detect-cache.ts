import { createHash } from 'node:crypto';
import type { DetectedRecognition } from './detect';

/**
 * A content-addressed cache in front of the detection model layer. docs/COST.md.
 *
 * WHY THIS EXISTS. `detectRecognitionsSmart` runs on EVERY posted message. It was the only
 * uncached model path in Rally, and it is the one that scales with chat volume rather than
 * with team size, so it is the path that decides the bill.
 *
 * WHY IT IS SAFE TO CACHE, which is the only question that matters for a cache in front of a
 * model. The cheap tier runs at `temperature: 0` with a fixed system prompt, so the same
 * message text produces the same reading. The cached value is the FINAL gated result, after
 * the confidence gate and after any escalation, so a hit reproduces the exact answer the full
 * path would have returned rather than a partial one. Nothing here changes what a user sees;
 * it only decides whether we pay to compute it twice.
 *
 * WHY THE KEY IS SO WIDE. The key covers the message body AND every input that could change
 * the answer: both model ids, the system prompt, and the confidence threshold. Change any of
 * them and every existing entry misses, which is correct: a prompt edit must not be served
 * stale readings from the old prompt. A cache whose key is narrower than its inputs is a
 * correctness bug that presents as a cost win.
 *
 * WHAT IT DOES NOT DO. It does not persist. This is an in-process LRU, so it warms per server
 * instance and empties on deploy. That is deliberate for now: a shared cache means a shared
 * store, an eviction policy and a privacy question about retaining message text, and none of
 * those are worth taking on before the in-process hit rate is measured in production. The
 * counters below exist so that measurement is possible rather than assumed.
 */

/** Bounded so a long-lived server cannot grow without limit. Roughly a day of chat for a cohort. */
export const CACHE_MAX_ENTRIES = 2_000;

export type CacheStats = {
  hits: number;
  misses: number;
  entries: number;
  /** hits / (hits + misses). 0 when nothing has been asked yet. */
  hitRate: number;
};

/**
 * Everything that can change the answer goes in the key. See the note above on why this is
 * wider than "the message body".
 */
export function detectCacheKey(input: {
  body: string;
  briefModel: string;
  escalateModel: string;
  system: string;
  threshold: number;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.body,
        input.briefModel,
        input.escalateModel,
        input.system,
        input.threshold,
      ])
    )
    .digest('hex');
}

// Map preserves insertion order, which is all an LRU needs: re-insert on read to mark recent,
// and evict the first key when full.
const CACHE = new Map<string, DetectedRecognition[]>();
let hits = 0;
let misses = 0;

/** A cached reading, or null. Records a hit or a miss either way. */
export function getCachedDetections(key: string): DetectedRecognition[] | null {
  const hit = CACHE.get(key);
  if (!hit) {
    misses += 1;
    return null;
  }
  // Mark as recently used.
  CACHE.delete(key);
  CACHE.set(key, hit);
  hits += 1;
  // Copied on the way out so a caller mutating its result cannot poison later hits. A cache
  // that hands out its own storage is a bug waiting for the first caller that sorts in place.
  return hit.map((d) => ({ ...d }));
}

/** Store a final, gated reading. Copies on the way in for the same reason as above. */
export function setCachedDetections(key: string, value: DetectedRecognition[]): void {
  CACHE.set(
    key,
    value.map((d) => ({ ...d }))
  );
  while (CACHE.size > CACHE_MAX_ENTRIES) {
    const oldest = CACHE.keys().next().value;
    if (oldest === undefined) break;
    CACHE.delete(oldest);
  }
}

/** Hit rate so far. The number that decides whether a persistent cache is worth building. */
export function detectCacheStats(): CacheStats {
  const asked = hits + misses;
  return { hits, misses, entries: CACHE.size, hitRate: asked === 0 ? 0 : hits / asked };
}

/** Test seam. Also used by the cost model script so a run starts from a known state. */
export function resetDetectCache(): void {
  CACHE.clear();
  hits = 0;
  misses = 0;
}
