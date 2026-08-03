import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Provider resilience: the rung of the failure ladder between "the call failed" and "degrade to the
 * deterministic baseline". Each test below states a promise Rally makes to a user:
 *
 *   1. a transient blip (429, 529, a dropped socket) costs you a moment, not your smarter answer;
 *   2. a permanent failure (400, 401) costs you nothing extra, it degrades immediately;
 *   3. nothing here can hang a request: the attempt count, each attempt, and the total elapsed time
 *      are all bounded, and an absurd Retry-After is capped rather than obeyed;
 *   4. the deterministic baseline is still the last rung, exactly as before;
 *   5. with no API key the provider is never contacted at all.
 *
 * The clock, the sleep and the attempt timer are injected, so these assertions are exact and no
 * test waits on a real timer.
 */

const { createCalls, createOptions, constructorArgs, script } = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
  createOptions: [] as Array<Record<string, unknown> | undefined>,
  constructorArgs: [] as Array<Record<string, unknown>>,
  // Each entry is one scripted attempt outcome, consumed in order.
  script: [] as Array<{ text?: string; throws?: unknown }>,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(args: Record<string, unknown>) {
      constructorArgs.push(args);
    }
    messages = {
      create: async (args: Record<string, unknown>, options?: Record<string, unknown>) => {
        createCalls.push(args);
        createOptions.push(options);
        const next = script.shift() ?? { text: '[]' };
        if (next.throws) throw next.throws;
        return {
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'text', text: next.text ?? '' }],
        };
      },
    };
  },
}));

import { MODELS, callClaudeDetailed, resetUsage, usageFromError, usageTotals } from '@/lib/agent';
import { resetDetectCache } from '@/lib/detect-cache';
import { detectRecognitionsSmart } from '@/lib/detect-model';
import {
  AttemptTimeoutError,
  RETRY_PROFILES,
  backoffDelayMs,
  isTransient,
  resolveRetryPolicy,
  retryAfterMsOf,
  withRetry,
  type RetryDeps,
  type RetryPolicy,
} from '@/lib/retry';

/** An error shaped like the SDK's APIError: a status, and optionally response headers. */
function httpError(status: number, headers?: Record<string, string>): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number; headers?: Record<string, string> };
  err.status = status;
  if (headers) err.headers = headers;
  return err;
}

/** A virtual clock: `sleep` advances it, `now` reads it, and nothing waits on a real timer. */
function fakeClock(opts: { random?: number; timerFires?: boolean } = {}) {
  let now = 0;
  const sleeps: number[] = [];
  const deps: RetryDeps = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    random: () => opts.random ?? 0.5,
    // Default: the attempt deadline never fires, so a resolving call is never raced by a timer and
    // the success-path tests are deterministic. `timerFires` opts into the hanging-call scenario:
    // the attempt burns its full deadline on the virtual clock, then expires.
    startTimer: opts.timerFires
      ? (ms: number) => ({
          expired: (async () => {
            now += ms;
          })(),
          cancel: () => {},
        })
      : () => ({ expired: new Promise<void>(() => {}), cancel: () => {} }),
  };
  return { deps, sleeps, elapsed: () => now };
}

const TEST_POLICY: RetryPolicy = {
  maxRetries: 2,
  attemptTimeoutMs: 10_000,
  totalBudgetMs: 25_000,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
  maxRetryAfterMs: 5_000,
};

const OLD_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  createCalls.length = 0;
  createOptions.length = 0;
  constructorArgs.length = 0;
  script.length = 0;
  resetUsage();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  // The detection cache is process-global and would otherwise carry readings between
  // tests, so a second test using the same message body would assert zero model calls
  // and fail for a reason that has nothing to do with what it is testing.
  resetDetectCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (OLD_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = OLD_KEY;
});

describe('bounded retry with backoff (lib/retry)', () => {
  it('calls the provider exactly once when the first attempt succeeds', async () => {
    const { deps, sleeps } = fakeClock();
    const fn = vi.fn(async () => 'answer');

    await expect(withRetry(fn, TEST_POLICY, deps)).resolves.toBe('answer');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]); // a success costs a user no extra latency at all.
  });

  it('rides out a transient 429 and still returns the real answer', async () => {
    const { deps, sleeps } = fakeClock();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw httpError(429);
      return 'answer';
    };

    await expect(withRetry(fn, TEST_POLICY, deps)).resolves.toBe('answer');

    expect(calls).toBe(2);
    expect(sleeps).toHaveLength(1); // it waited once, then got the good answer.
  });

  it('treats an overloaded 529 and a failing edge 5xx as worth trying again', async () => {
    for (const status of [500, 502, 503, 504, 529]) {
      const { deps } = fakeClock();
      let calls = 0;
      const fn = async () => {
        calls += 1;
        if (calls === 1) throw httpError(status);
        return 'answer';
      };
      await expect(withRetry(fn, TEST_POLICY, deps)).resolves.toBe('answer');
      expect(calls, `status ${status} should be retried`).toBe(2);
    }
  });

  it('never retries a 400, because a malformed request fails identically forever', async () => {
    const { deps, sleeps } = fakeClock();
    const fn = vi.fn(async () => {
      throw httpError(400);
    });

    await expect(withRetry(fn, TEST_POLICY, deps)).rejects.toMatchObject({ status: 400 });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('never retries a 401, because a rejected key is not a blip', async () => {
    const { deps } = fakeClock();
    const fn = vi.fn(async () => {
      throw httpError(401);
    });

    await expect(withRetry(fn, TEST_POLICY, deps)).rejects.toMatchObject({ status: 401 });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry cap so a sustained outage cannot stall a request', async () => {
    const { deps } = fakeClock();
    const fn = vi.fn(async () => {
      throw httpError(503);
    });

    await expect(withRetry(fn, TEST_POLICY, deps)).rejects.toMatchObject({ status: 503 });

    // maxRetries: 2 means three provider calls in total, never a fourth.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('honours a Retry-After the server asked for instead of guessing a delay', async () => {
    const { deps, sleeps } = fakeClock();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw httpError(429, { 'retry-after': '2' });
      return 'answer';
    };

    await expect(withRetry(fn, TEST_POLICY, deps)).resolves.toBe('answer');

    expect(sleeps).toEqual([2_000]); // exactly what was asked, not the jittered guess.
  });

  it('caps an absurd Retry-After rather than hanging a request on it', async () => {
    const { deps, sleeps } = fakeClock();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw httpError(429, { 'retry-after': '3600' }); // "come back in an hour"
      return 'answer';
    };

    await expect(withRetry(fn, TEST_POLICY, deps)).resolves.toBe('answer');

    expect(sleeps).toEqual([TEST_POLICY.maxRetryAfterMs]); // 5s, not an hour.
  });

  it('reads a Retry-After given as an HTTP date, not just as seconds', () => {
    const nowMs = Date.parse('2026-01-01T00:00:00Z');
    const err = httpError(429, { 'Retry-After': 'Thu, 01 Jan 2026 00:00:30 GMT' });
    expect(retryAfterMsOf(err, nowMs)).toBe(30_000);
  });

  it('spreads retries with full jitter so throttled callers do not resynchronise', () => {
    const policy = { ...TEST_POLICY, baseDelayMs: 1_000, maxDelayMs: 4_000 };
    // Full jitter: uniform in [0, ceiling), with the ceiling doubling per attempt and then capped.
    expect(backoffDelayMs(0, policy, () => 0)).toBe(0);
    expect(backoffDelayMs(0, policy, () => 0.999)).toBeLessThan(1_000);
    expect(backoffDelayMs(1, policy, () => 0.999)).toBeLessThan(2_000);
    expect(backoffDelayMs(1, policy, () => 0.999)).toBeGreaterThanOrEqual(1_000);
    expect(backoffDelayMs(9, policy, () => 0.999)).toBeLessThan(4_000); // ceiling holds.
  });

  it('gives up on a hanging call instead of waiting on it forever', async () => {
    const { deps } = fakeClock({ timerFires: true });
    const hangs = vi.fn(() => new Promise<string>(() => {})); // never settles

    await expect(withRetry(hangs, { ...TEST_POLICY, maxRetries: 0 }, deps)).rejects.toBeInstanceOf(
      AttemptTimeoutError,
    );

    expect(hangs).toHaveBeenCalledTimes(1);
  });

  it('aborts the hung request so a call nobody is waiting on stops consuming a socket', async () => {
    const { deps } = fakeClock({ timerFires: true });
    let seen: AbortSignal | undefined;
    const hangs = ({ signal }: { signal: AbortSignal }) => {
      seen = signal;
      return new Promise<string>(() => {});
    };

    await expect(withRetry(hangs, { ...TEST_POLICY, maxRetries: 0 }, deps)).rejects.toBeInstanceOf(
      AttemptTimeoutError,
    );

    expect(seen?.aborted).toBe(true);
  });

  it('keeps total elapsed time inside the budget even when every attempt hangs', async () => {
    const { deps, elapsed } = fakeClock({ timerFires: true });
    const hangs = vi.fn(() => new Promise<string>(() => {}));

    await expect(
      withRetry(hangs, { ...TEST_POLICY, maxRetries: 5, attemptTimeoutMs: 10_000, totalBudgetMs: 25_000 }, deps),
    ).rejects.toBeInstanceOf(AttemptTimeoutError);

    // Five retries would be 60s of attempts; the total budget stops it far sooner.
    expect(elapsed()).toBeLessThanOrEqual(25_000);
    expect(hangs.mock.calls.length).toBeLessThan(6);
  });

  it('never sleeps past the budget only to be refused on waking', async () => {
    const { deps, sleeps } = fakeClock();
    const fn = vi.fn(async () => {
      throw httpError(429, { 'retry-after': '30' });
    });

    // A 30s Retry-After capped to 5s still exceeds a 4s total budget, so we stop rather than sleep.
    await expect(
      withRetry(fn, { ...TEST_POLICY, totalBudgetMs: 4_000 }, deps),
    ).rejects.toMatchObject({ status: 429 });

    expect(sleeps).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('treats a dropped socket as transient and a programming bug as permanent', () => {
    expect(isTransient(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransient(new TypeError('fetch failed'))).toBe(true);
    expect(isTransient(new AttemptTimeoutError(1_000))).toBe(true);
    // No status, no connection hint: a malformed-response TypeError must fail fast to the baseline.
    expect(isTransient(new TypeError('cannot read properties of undefined'))).toBe(false);
    expect(isTransient(httpError(404))).toBe(false);
  });

  it('gives the interactive path a tighter total budget than the bulk background path', () => {
    // The promise: a human waiting on Ask is never made to wait as long as a background classify.
    expect(RETRY_PROFILES.interactive.totalBudgetMs).toBeLessThan(RETRY_PROFILES.background.totalBudgetMs);
    // An agent step retries less, because one turn can run several of them.
    expect(RETRY_PROFILES.agentStep.maxRetries).toBeLessThan(RETRY_PROFILES.interactive.maxRetries);
    // Every profile is bounded: no profile may retry indefinitely.
    for (const policy of Object.values(RETRY_PROFILES)) {
      expect(policy.maxRetries).toBeLessThanOrEqual(2);
      expect(policy.totalBudgetMs).toBeGreaterThan(policy.attemptTimeoutMs);
    }
    expect(resolveRetryPolicy('background', { maxRetries: 0 }).maxRetries).toBe(0);
  });
});

describe('the failure ladder around a model call (lib/agent)', () => {
  const opts = {
    model: MODELS.default,
    system: 'sys',
    prompt: 'hi',
    feature: 'test',
  };

  it('returns the answer with no retry when the model responds first time', async () => {
    const { deps } = fakeClock();
    script.push({ text: 'hello' });

    const res = await callClaudeDetailed({ ...opts, retryDeps: deps });

    expect(res?.text).toBe('hello');
    expect(createCalls).toHaveLength(1);
  });

  it('recovers a real answer after a transient 429 instead of degrading on the first blip', async () => {
    const { deps } = fakeClock();
    script.push({ throws: httpError(429) });
    script.push({ text: 'hello' });

    const res = await callClaudeDetailed({ ...opts, retryDeps: deps });

    expect(res?.text).toBe('hello');
    expect(createCalls).toHaveLength(2);
  });

  it('degrades to null only after the retries are spent', async () => {
    const { deps } = fakeClock();
    for (let i = 0; i < 5; i++) script.push({ throws: httpError(503) });

    const res = await callClaudeDetailed({ ...opts, retryDeps: deps });

    expect(res).toBeNull(); // the contract callers depend on is unchanged.
    expect(createCalls).toHaveLength(3); // and it only degraded after trying three times.
  });

  it('degrades immediately on a 400, without spending a user\'s time on a doomed retry', async () => {
    const { deps } = fakeClock();
    for (let i = 0; i < 5; i++) script.push({ throws: httpError(400) });

    const res = await callClaudeDetailed({ ...opts, retryDeps: deps });

    expect(res).toBeNull();
    expect(createCalls).toHaveLength(1);
  });

  it('degrades immediately on a 401, because a rejected key will reject every retry too', async () => {
    const { deps } = fakeClock();
    for (let i = 0; i < 5; i++) script.push({ throws: httpError(401) });

    expect(await callClaudeDetailed({ ...opts, retryDeps: deps })).toBeNull();
    expect(createCalls).toHaveLength(1);
  });

  it('never calls the model at all when there is no API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { deps } = fakeClock();
    script.push({ text: 'should never be reached' });

    const res = await callClaudeDetailed({ ...opts, retryDeps: deps });

    expect(res).toBeNull();
    expect(createCalls).toHaveLength(0);
    expect(constructorArgs).toHaveLength(0); // no client is even constructed.
  });

  it('meters the tokens a failed attempt burned, so retries cannot hide spend', async () => {
    const { deps } = fakeClock();
    const err = Object.assign(httpError(500), { usage: { input_tokens: 40, output_tokens: 7 } });
    script.push({ throws: err });
    script.push({ text: 'hello' });

    await callClaudeDetailed({ ...opts, retryDeps: deps });

    const totals = usageTotals('test');
    expect(totals.calls).toBe(2); // the failed attempt is on the meter alongside the good one.
    expect(totals.inputTokens).toBe(50); // 40 burned by the failure + 10 by the success.
    expect(totals.costUsd).toBeGreaterThan(0);
  });

  it('finds usage nested inside a provider error body, not just at the top level', () => {
    expect(usageFromError({ error: { usage: { input_tokens: 3, output_tokens: 1 } } })).toEqual({
      inputTokens: 3,
      outputTokens: 1,
    });
    expect(usageFromError(httpError(500))).toBeNull(); // the common case: nothing was billed.
  });

  it('leaves the SDK\'s own retries switched off so the two layers cannot multiply', async () => {
    const { deps } = fakeClock();
    script.push({ throws: httpError(429) });
    script.push({ text: 'hello' });

    await callClaudeDetailed({ ...opts, retryDeps: deps });

    expect(constructorArgs.length).toBeGreaterThan(0);
    for (const args of constructorArgs) expect(args.maxRetries).toBe(0);
  });

  it('gives every attempt a hard deadline, so no model call can hang a request', async () => {
    const { deps } = fakeClock();
    script.push({ text: 'hello' });

    await callClaudeDetailed({ ...opts, retryDeps: deps, retryProfile: 'interactive' });

    // The per-request timeout handed to the SDK matches the attempt deadline we enforce ourselves,
    // and an abort signal is handed down so a hung socket is released, not just abandoned.
    expect(createOptions).toHaveLength(1);
    expect(createOptions[0]?.timeout).toBe(RETRY_PROFILES.interactive.attemptTimeoutMs);
    expect(createOptions[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('recognition detection under provider failure', () => {
  beforeEach(() => {
    // Pin jitter to zero so the ladder runs instantly: this suite exercises the real detect path,
    // which chooses its own budget, and we are asserting attempt COUNTS, not wall-clock delays.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  it('recovers the smarter model read after one transient 429 rather than dropping to regex', async () => {
    script.push({ throws: httpError(429) });
    script.push({ text: '[{"helperHandle":"alice","kind":"reviewed","confidence":0.9}]' });

    const out = await detectRecognitionsSmart('thanks @alice for the help!');

    expect(createCalls).toHaveLength(2);
    // The model said "reviewed"; the regex baseline would have said "answered". We kept the better read.
    expect(out).toEqual([{ helperHandle: 'alice', kind: 'reviewed' }]);
  });

  it('still falls back to the deterministic baseline once the retry ladder is exhausted', async () => {
    for (let i = 0; i < 5; i++) script.push({ throws: httpError(529) });

    const out = await detectRecognitionsSmart('thanks @alice for the help!');

    expect(createCalls).toHaveLength(3); // tried three times on the bulk path...
    expect(out).toEqual([{ helperHandle: 'alice', kind: 'answered' }]); // ...then the baseline answered.
  });

  it('does not retry a permanent 401 before falling back to the baseline', async () => {
    for (let i = 0; i < 5; i++) script.push({ throws: httpError(401) });

    const out = await detectRecognitionsSmart('thanks @alice for the help!');

    expect(createCalls).toHaveLength(1);
    expect(out).toEqual([{ helperHandle: 'alice', kind: 'answered' }]);
  });

  it('calls no model and returns the baseline when there is no API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const out = await detectRecognitionsSmart('thanks @alice for the help!');

    expect(createCalls).toHaveLength(0);
    expect(out).toEqual([{ helperHandle: 'alice', kind: 'answered' }]);
  });
});
