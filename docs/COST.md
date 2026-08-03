# Cost

What one use of Rally's AI costs, at a stated volume, and what each cost decision is actually worth.

Regenerate with `npm run cost:model`. The numbers below are produced by
[`scripts/cost-model.mjs`](../scripts/cost-model.mjs), which reads the real pricing table out of
`lib/agent.ts` and the real system prompt out of `lib/detect-model.ts`, so a repricing or a prompt
edit moves the model rather than leaving a stale figure in a document.

## Where the money goes

Rally makes model calls on one hot path: **recognition detection**, which runs on every posted
message. It scales with chat volume rather than with team size, so it is the path that decides the
bill. Everything else in Rally is deterministic.

Detection runs a cost cascade already:

| Tier | Model | When |
|---|---|---|
| bulk | `claude-haiku-4-5` | every message, at `temperature: 0` |
| escalate | `claude-opus-4-8` | once, only for a message the cheap tier reads as ambiguous |

## The numbers

Scenario: 30 members posting 12 messages a day, so **360 messages/day**. 8% of messages escalate.
35% of messages have text this process has seen before.

| Scenario | Model calls/day | Cost/day | Over 30 days |
|---|---|---|---|
| Everything on `claude-opus-4-8` | 360 | $1.93 | **$57.83** |
| Cascade, no cache | 389 | $0.28 | **$8.48** |
| Cascade + cache | 253 | $0.18 | **$5.51** |

Per call: `claude-haiku-4-5` is **$0.00036**, `claude-opus-4-8` is **$0.00536**, a 15x gap on
roughly 157 input and 40 output tokens.

## What each decision is worth, including the unflattering answer

**The cascade is the whole story: it saves about $49 of every $58.** Routing bulk classification to
the cheap tier and reserving the strong tier for genuinely ambiguous messages is a 7x reduction. That
decision predates this document.

**The cache saves about $3 more, and that is a small number.** It is worth writing down plainly
rather than dressing up. At this volume, caching is a rounding error next to tier routing. It was
still worth building for two reasons that are not the headline figure:

- Its value grows with the thing that grows. Cache savings scale with repetition, and repetition
  rises with team size and with how templated chat becomes. Cascade savings are already banked.
- It removes duplicate spend on the *expensive* path. An ambiguous message costs a Haiku call plus
  an Opus call, and that pair is the one worth never buying twice.

If the assumed 35% hit rate turns out to be 10%, the cache saves under a dollar a month and should be
described as a correctness convenience rather than a cost control. The counters in
`lib/detect-cache.ts` exist so that is answerable rather than arguable.

## What is measured, estimated, and assumed

This section is the point of the document. A cost table without it is decoration.

| | |
|---|---|
| **Measured from source** | the system prompt's exact length (507 chars), both model ids, and the per-million-token prices in `lib/agent.ts` |
| **Estimated** | token counts, as characters / 4. Anthropic's tokenizer is not available offline and the count-tokens endpoint needs a key |
| **Assumed** | message volume, the 35% cache hit rate, the 8% escalation rate, and a 40-token typical reply |

**Every dollar figure here is an order of magnitude, not a bill.** The chars/4 approximation is the
largest source of error and it is not calibrated against Anthropic's tokenizer.

Rally already meters the truth. `recordUsage` in `lib/agent.ts` records real input and output token
counts and a per-call cost for every live call, keyed by feature. One run with a real key replaces
the estimates above with metered numbers. Until that happens, this is a model, and it says so.

## What would change these numbers

- **A metered sample.** The single highest-value follow-up. It removes the chars/4 estimate entirely.
- **A measured cache hit rate.** `detectCacheStats()` reports hits, misses and rate. Nothing surfaces
  it yet; the honest state is that the 35% is assumed.
- **A tested cheaper tier.** The cascade routes bulk work to Haiku because it is the cheap tier, not
  because Haiku was measured as good enough on Rally's own examples. `tests/evals/detection.test.ts`
  is where that comparison belongs, and it needs a keyed run. Until then the routing is a reasonable
  design choice rather than a validated one, and this document should not claim otherwise.

## Not cached, deliberately

A detection that fell back to the deterministic baseline is never cached. Those returns mean the
model was absent or the call failed, and storing a degraded answer would turn one transient rate
limit into a permanently worse reading for that message text. `tests/unit/cascade.test.ts` pins this.

The cache is also in-process only. It warms per server instance and empties on deploy. A shared cache
means a shared store, an eviction policy and a privacy question about retaining message text, and
none of those are worth taking on before the in-process hit rate is known.
