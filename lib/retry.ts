/**
 * Bounded retry with exponential backoff and full jitter, plus a hard per-attempt timeout.
 *
 * WHY THIS EXISTS. Rally is deliberately "AI-optional": every model path degrades to a
 * deterministic baseline (`lib/agent.ts`, `lib/detect-model.ts`). That degrade is a feature and it
 * stays. But before this module, a single transient 429 or a hung socket degraded the user's result
 * to the baseline instantly and silently, and a call with no timeout could hang a user-facing
 * request until the SDK's own 10-minute default gave up. This is the rung the failure ladder was
 * missing: retry the transient thing a bounded number of times, THEN degrade. The degrade is the
 * final rung, never the first.
 *
 * WHAT IT WILL NOT DO.
 *  - It never retries a permanent failure. A 400 (bad request, e.g. sending `temperature` to a
 *    reasoning tier) and a 401 (bad key) will fail identically forever; retrying them burns the
 *    user's latency budget to reach the same answer. Only 429/500/502/503/504/529 and
 *    network/timeout errors are transient.
 *  - It never retries forever. Both the attempt count AND the total elapsed time are capped,
 *    because several of these calls sit inside a user-facing HTTP request.
 *  - It never obeys an absurd `Retry-After`. A header asking us to wait an hour is honoured only up
 *    to `maxRetryAfterMs`; past that we give up and degrade rather than hang the request.
 *
 * LAYERING WITH THE SDK'S OWN RETRIES. `@anthropic-ai/sdk` retries internally by default
 * (`maxRetries: 2`). Two retry layers multiply: 3 SDK attempts inside 3 of ours is 9 calls and a
 * latency budget nobody chose. `lib/agent.ts` therefore constructs the client with `maxRetries: 0`
 * and this module is the single, explicit retry authority. See the comment at the client
 * construction site.
 *
 * TESTABILITY. `sleep`, `now`, `random`, and the attempt timer are all injectable, so the unit
 * tests assert real backoff and timeout behaviour with no real timers and no flakiness.
 */

export type Sleep = (ms: number) => Promise<void>;
export type Now = () => number;
export type Random = () => number;

/** A cancellable deadline for one attempt. Injectable so tests need no real timers. */
export type Timer = { expired: Promise<void>; cancel: () => void };
export type StartTimer = (ms: number) => Timer;

export type RetryDeps = {
  sleep?: Sleep;
  now?: Now;
  random?: Random;
  startTimer?: StartTimer;
};

export type RetryPolicy = {
  /** Retries AFTER the first attempt. 2 means at most 3 calls. */
  maxRetries: number;
  /** Hard cap on a single attempt. The call is aborted past this. */
  attemptTimeoutMs: number;
  /** Hard cap on everything: all attempts plus all backoff sleeps. */
  totalBudgetMs: number;
  /** First backoff ceiling; doubles per attempt, jittered to [0, ceiling). */
  baseDelayMs: number;
  /** Ceiling the doubling stops at. */
  maxDelayMs: number;
  /** Longest `Retry-After` we are willing to honour. */
  maxRetryAfterMs: number;
};

/**
 * Per-call-site budgets. The right numbers differ by who is waiting:
 *
 *  - `interactive` (the Ask route): a human is watching a spinner. Two retries is enough to ride out
 *    a single rate-limit blip or one bad edge node; a third would mostly add latency to a request
 *    that is already failing. 15s per attempt comfortably covers a 700-token grounded summary on
 *    Sonnet while still being well inside a serverless function limit, and the 25s total budget is
 *    the real bound: it is what a user will tolerate before "unavailable" is the kinder answer.
 *
 *  - `agentStep` (the Home assistant loop): the same human is waiting, but the loop runs up to
 *    MAX_AGENT_STEPS = 6 model calls. An `interactive` budget per step would compound to ~150s for
 *    one turn. So one retry and a 20s step budget: transient blips are still absorbed, and the
 *    worst case for a full turn stays bounded rather than multiplying.
 *
 *  - `background` (recognition detection): bulk and post-hoc. Nobody is blocked on it; the message
 *    is already posted and the worst case is a suggestion appearing a few seconds later. So it gets
 *    the most patience: longer backoff ceilings (its 429s are the ones worth actually waiting out),
 *    a longer per-attempt timeout, and a 45s total budget.
 *
 * Every profile keeps maxRetries small. Retries are a blip absorber, not a queue: if the provider is
 * genuinely down, the deterministic baseline is the correct answer and it is one rung away.
 */
export const RETRY_PROFILES = {
  interactive: {
    maxRetries: 2,
    attemptTimeoutMs: 15_000,
    totalBudgetMs: 25_000,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
    maxRetryAfterMs: 5_000,
  },
  agentStep: {
    maxRetries: 1,
    attemptTimeoutMs: 15_000,
    totalBudgetMs: 20_000,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
    maxRetryAfterMs: 4_000,
  },
  background: {
    maxRetries: 2,
    attemptTimeoutMs: 20_000,
    totalBudgetMs: 45_000,
    baseDelayMs: 500,
    maxDelayMs: 8_000,
    maxRetryAfterMs: 10_000,
  },
} as const satisfies Record<string, RetryPolicy>;

export type RetryProfileName = keyof typeof RETRY_PROFILES;

/** The default when a call site does not say. Interactive is the conservative choice: it assumes a
 *  human is waiting, so a mis-labelled call site errs toward answering sooner, not hanging longer. */
export const DEFAULT_RETRY_PROFILE: RetryProfileName = 'interactive';

/** Resolve a profile name plus optional overrides into a concrete policy. */
export function resolveRetryPolicy(
  profile: RetryProfileName = DEFAULT_RETRY_PROFILE,
  overrides?: Partial<RetryPolicy>,
): RetryPolicy {
  return { ...RETRY_PROFILES[profile], ...overrides };
}

/** Thrown when one attempt blew its deadline. Transient by definition, so it is retryable. */
export class AttemptTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`model call exceeded its ${timeoutMs}ms attempt timeout`);
    this.name = 'AttemptTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The only status codes worth calling again. 429 is rate limiting, 529 is Anthropic's
 * "overloaded", and 5xx here are the gateway/edge failures that succeed on a second try.
 * Everything absent from this set (400, 401, 403, 404, 413, 422, ...) describes the request, not
 * the moment, so a retry would reproduce it exactly.
 */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 529]);

/** Error `name`s that mean "the connection failed", not "the request was wrong". */
const TRANSIENT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'AttemptTimeoutError',
  'AbortError',
  'TimeoutError',
  'FetchError',
]);

/** Node/undici socket-level codes. All of these are "try again", none describe the request. */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** The HTTP status an error carries, across the shapes the SDK and fetch produce. */
export function statusOf(err: unknown): number | undefined {
  const e = asRecord(err);
  if (!e) return undefined;
  const response = asRecord(e.response);
  for (const candidate of [e.status, e.statusCode, response?.status]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

/** Read one header off an error, tolerating a `Headers` instance or a plain object. */
function headerOf(err: unknown, name: string): string | undefined {
  const e = asRecord(err);
  if (!e) return undefined;
  const response = asRecord(e.response);
  for (const bag of [e.headers, response?.headers]) {
    if (!bag) continue;
    const getter = asRecord(bag)?.get;
    if (typeof getter === 'function') {
      const v = (getter as (k: string) => unknown).call(bag, name);
      if (typeof v === 'string' && v !== '') return v;
      continue;
    }
    const plain = asRecord(bag);
    if (!plain) continue;
    for (const [k, v] of Object.entries(plain)) {
      if (k.toLowerCase() === name && typeof v === 'string' && v !== '') return v;
    }
  }
  return undefined;
}

/**
 * The `Retry-After` the server asked for, in ms, or undefined when it did not ask. Accepts both
 * legal forms (delta-seconds and an HTTP date). Returns the RAW request; the CAP is applied by the
 * caller, because "the server asked" and "we are willing" are two different facts and conflating
 * them is how a request ends up sleeping for an hour.
 */
export function retryAfterMsOf(err: unknown, nowMs: number = Date.now()): number | undefined {
  const raw = headerOf(err, 'retry-after');
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
  return undefined;
}

/**
 * Is this worth calling again? A known status decides on its own: if the server told us what was
 * wrong, we believe it, and an unlisted status is permanent. Only when there is NO status do we
 * look at the connection-level hints, because that is exactly the shape of "we never got an
 * answer". Anything we do not recognise is treated as permanent, so a bug in our own code (a
 * TypeError while parsing, say) fails fast to the deterministic baseline instead of being
 * hammered three times.
 */
export function isTransient(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);

  const e = asRecord(err);
  if (!e) return false;
  if (typeof e.name === 'string' && TRANSIENT_ERROR_NAMES.has(e.name)) return true;
  if (typeof e.code === 'string' && TRANSIENT_ERROR_CODES.has(e.code)) return true;
  const cause = e.cause;
  if (cause && cause !== err && isTransient(cause)) return true;
  // Last resort: undici surfaces a bare `TypeError: fetch failed` for a dead connection.
  return typeof e.message === 'string' && /fetch failed|socket hang up|network error/i.test(e.message);
}

/**
 * Full jitter (AWS's formulation): sleep a uniform random amount in [0, ceiling), where the ceiling
 * doubles per attempt up to `maxDelayMs`. Full jitter rather than "backoff plus a little noise"
 * because the failure we are retrying is usually correlated across callers: a 429 hits everyone at
 * once, and equal backoff just reconvenes the same thundering herd one second later.
 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random: Random = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle: unknown = setTimeout(resolve, ms);
    (handle as { unref?: () => void })?.unref?.();
  });
}

function defaultStartTimer(ms: number): Timer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
    (handle as unknown as { unref?: () => void })?.unref?.();
  });
  return { expired, cancel: () => { if (handle !== undefined) clearTimeout(handle); } };
}

/** How long to wait before the next attempt: the server's request if it made one (capped), else jittered backoff. */
function nextDelayMs(err: unknown, attempt: number, policy: RetryPolicy, random: Random, nowMs: number): number {
  const asked = retryAfterMsOf(err, nowMs);
  if (asked !== undefined) return Math.min(asked, policy.maxRetryAfterMs);
  return backoffDelayMs(attempt, policy, random);
}

/** Run one attempt under a hard deadline, aborting the in-flight call if the deadline wins. */
async function runAttempt<T>(
  fn: (ctx: { signal: AbortSignal; attempt: number }) => Promise<T>,
  attempt: number,
  timeoutMs: number,
  startTimer: StartTimer,
): Promise<T> {
  const controller = new AbortController();
  const timer = startTimer(timeoutMs);
  try {
    return await Promise.race([
      fn({ signal: controller.signal, attempt }),
      timer.expired.then(() => {
        // Abort the socket before throwing: a hung request that nobody is waiting for should not
        // keep consuming a connection (or, worse, land tokens we already gave up on).
        controller.abort();
        throw new AttemptTimeoutError(timeoutMs);
      }),
    ]);
  } finally {
    timer.cancel();
  }
}

/**
 * Run `fn` with bounded retry. Returns its value on the first success. Throws the LAST error when
 * every attempt failed, when the error is permanent (immediately, without retrying), or when the
 * total budget ran out. Callers that own a deterministic fallback simply catch and degrade, which
 * is what `callClaudeDetailed` does: this layer sits IN FRONT of the degrade, never instead of it.
 */
export async function withRetry<T>(
  fn: (ctx: { signal: AbortSignal; attempt: number }) => Promise<T>,
  policy: RetryPolicy,
  deps: RetryDeps = {},
): Promise<T> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const startTimer = deps.startTimer ?? defaultStartTimer;

  const startedAt = now();
  let lastError: unknown;
  let ran = false;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    const remaining = policy.totalBudgetMs - (now() - startedAt);
    if (remaining <= 0) break; // total elapsed is a hard bound, even mid-ladder.

    ran = true;
    // An attempt never outlives the total budget, so the LAST attempt cannot overshoot it.
    const attemptTimeoutMs = Math.min(policy.attemptTimeoutMs, remaining);
    try {
      return await runAttempt(fn, attempt, attemptTimeoutMs, startTimer);
    } catch (err) {
      lastError = err;
      // Permanent: a second identical request gets a second identical failure. Fail now.
      if (!isTransient(err)) throw err;
      if (attempt === policy.maxRetries) break;
      const delay = nextDelayMs(err, attempt, policy, random, now());
      // Do not sleep into (or past) the budget: waking up only to be refused is pure added latency.
      if (now() - startedAt + delay >= policy.totalBudgetMs) break;
      await sleep(delay);
    }
  }

  if (ran) throw lastError;
  throw new Error('retry budget was exhausted before any attempt could run');
}
