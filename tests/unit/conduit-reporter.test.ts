import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { reportDecision } from '@/lib/conduit/reporter';

/**
 * Live-usage reporter (lib/conduit/reporter.ts).
 *
 * The reporter is a fire-and-forget TAP on the metered record. These tests
 * assert the two contract halves:
 *  1. env SET  → a single POST to `${URL}/v1/decisions` with the right shape and
 *     `Authorization: Bearer <token>` header.
 *  2. env UNSET → nothing is sent and nothing throws (byte-identical to today).
 */

const decision = {
  useCase: 'ask',
  model: 'claude-sonnet-5',
  provider: 'anthropic',
  costUsd: 0.0012,
  latencyMs: 42,
  tokensIn: 12,
  tokensOut: 34,
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.CONDUIT_GATEWAY_URL;
  delete process.env.CONDUIT_GATEWAY_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CONDUIT_GATEWAY_URL;
  delete process.env.CONDUIT_GATEWAY_TOKEN;
  vi.restoreAllMocks();
});

describe('conduit reporter · live-usage tap', () => {
  it('POSTs the decision with the right shape + bearer header when env is set', async () => {
    process.env.CONDUIT_GATEWAY_URL = 'https://gateway.example/'; // trailing slash on purpose
    process.env.CONDUIT_GATEWAY_TOKEN = 'tok_123';

    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await reportDecision(decision);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // Trailing slash on the base URL is normalised (no double slash).
    expect(url).toBe('https://gateway.example/v1/decisions');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok_123');
    expect(headers['content-type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      useCase: 'ask',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      costUsd: 0.0012,
      latencyMs: 42,
      tokensIn: 12,
      tokensOut: 34,
    });
    // A timestamp is stamped on the wire; tenant is NOT sent (derived from token).
    expect(typeof body.at).toBe('string');
    expect(Number.isNaN(Date.parse(body.at))).toBe(false);
    expect(body).not.toHaveProperty('tenant');
  });

  it('is a no-op (no fetch, no throw) when the gateway env vars are unset', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(reportDecision(decision)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows a gateway failure so the answer path never sees it', async () => {
    process.env.CONDUIT_GATEWAY_URL = 'https://gateway.example';
    process.env.CONDUIT_GATEWAY_TOKEN = 'tok_123';
    globalThis.fetch = vi.fn(async () => {
      throw new Error('gateway down');
    }) as unknown as typeof fetch;

    // Must resolve, never reject.
    await expect(reportDecision(decision)).resolves.toBeUndefined();
  });
});
