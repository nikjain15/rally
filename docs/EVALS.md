# Rally, Evaluation strategy

Rally's intelligences are low-stakes by construction: the model never writes a points-bearing
row, and every AI path has a deterministic fallback. That shifts the eval burden. The questions
that matter here are not "is the model perfect" but "is the *ungameable* guarantee actually
unbreakable" and "is the deterministic layer correct on its own." This document maps Rally's
current tests onto the standard ladder (unit -> LLM-judge -> model evals -> A/B) and marks what is
implemented vs. roadmap. Nothing here is fabricated, implemented items point at real files.

## What "correct" means for each intelligence

| Intelligence | Failure that matters | Why it is contained |
|---|---|---|
| Recognition detection | false positive (credits the wrong person) or false negative (misses a thank-you) | A detection is only a *suggestion*; the helped peer must confirm before any points, so a bad inference costs nothing |
| Brief ("catch me up") | invents urgency, or buries a real claim | Deterministic ranking is the baseline; the model only reclassifies free-text unread |
| Home assistant | drafts a wrong action, or tries to act on its own | Propose-tools never execute; the user confirms; the model has no awarding tool |

Because the guardrail (not the model) is what protects users, **the rules tests are Rally's most
important evals.**

## Layer 1, Unit / deterministic (IMPLEMENTED)

`npm run test:unit`, pure logic, no model, no Firestore. Covers the exact behaviors an eval set
would target:

- **Detection** (`tests/unit/detect.test.ts`): the gratitude grammar, correct helper/kind
  extraction, dedupe, and the critical negative cases (a message that credits no one yields
  nothing; the author never credits themselves).
- **Brief ranking** (`tests/unit/brief.test.ts`): recognition-awaiting-confirm outranks a due
  commitment outranks unread; at most three items; the "all quiet" line.
- **Assistant routing** (`tests/unit/assistant.test.ts`): safe vs. propose split; `toProposal`
  validation rejects malformed model output.
- **Model-output parsing** (`extractJson`): tolerates fences/prose, rejects invalid shapes -
  the untrusted-output backstop.
- Plus rate-limit, unread, @mention, search, commitment-nudge, shared-context lifecycle.

These are effectively a **precision/recall harness for the deterministic baseline** already: the
detection negative cases are exactly the false-positive guards an eval would score.

## Layer 2, Anti-gaming / rules evals (IMPLEMENTED, the load-bearing layer)

`npm run test:rules` runs `tests/rules/firestore.test.ts` against the Firestore emulator. These
assert the trust guarantees directly: a client cannot write `xpEvents`, cannot flip a recognition
to `confirmed`, cannot confirm as anyone but the helped peer, cannot self-award, cannot inflate a
reaction or uid-list count, cannot read a channel it is not a member of, and cannot read another
user's assistant thread. **If one of these goes red, the product is gameable.** This is a
model-eval in spirit: it evaluates the *system's* safety property, not a prompt.

`npm run test:integration` adds a real-SDK adversarial "break it" pass plus assistant-memory
persistence and a ~65-user / ~2,100-message perf pass (channel load ~73ms, brief ~69ms,
leaderboard ~16ms, numbers from the README's documented run).

## Layer 3, E2E behavioral (IMPLEMENTED)

`npm run test:e2e` drives signed-in browser flows on the emulator: send/react/edit/delete,
thread reactions, two-client @mention and realtime, search, onboarding, leaderboard opt-in, and
the assistant panel. This validates the confirm-before-act loop end-to-end from the UI.

## Layer 4, LLM-judge and model evals (ROADMAP)

Not yet implemented; the design:

- **Recognition-detection precision/recall/F1.** A labeled JSONL set of ~100 messages (positive:
  varied gratitude phrasings and multi-mention; negative: self-credit, sarcasm, "thanks in
  advance", no-mention) scored against both `detectRecognitions` (baseline) and
  `detectRecognitionsSmart` (model layer). Target: the model layer must never do *worse* than
  the baseline (that is the contract in `lib/detect-model.ts`). Report precision, recall, F1, and
  the false-positive rate specifically, since a false positive is the costly error.
- **Brief quality via LLM-judge.** Given a synthetic inbox, judge the brief on: did it surface
  every real claim, invent zero urgency, and stay within three items. Scored by a judge model
  with a rubric; report pass rate and the invented-urgency rate (must be ~0).
- **Assistant faithfulness.** Judge that a proposal matches the user's intent and that the reply
  never claims to have *done* something it only drafted.

## Layer 5, A/B (ROADMAP, needs external users)

The pilot is a single 65-person cohort with no external users, so no A/B has run. When there is
population to split, the experiments worth running:

- Detection baseline-only vs. baseline+model: effect on suggested->confirmed conversion.
- Assistant on vs. off: effect on the north-star (confirmed recognitions per active member/week)
  and on commitments kept on time.
- Brief phrasing variants: effect on brief->action click-through.

## Metrics glossary (named, for the roadmap harness)

- **Precision** = confirmed-correct detections / all detections proposed. Guards against crediting
  the wrong person.
- **Recall** = thank-yous detected / thank-yous present. Guards against missing recognition.
- **F1** = harmonic mean; the single number for the detection set.
- **False-positive rate** = the error Rally cares most about (a wrong suggestion erodes trust),
  tracked separately from F1.
- **Invented-urgency rate** (brief) = briefs that surface an item with no real claim; target ~0.
- **Guarantee-violation count** (rules) = must be exactly 0; any nonzero means gameable.

## How to run today

```bash
npm run gate        # typecheck, lint, unit, rules, integration, e2e smoke
npm run test:e2e    # full signed-in browser flows against the emulator
```

Everything above runs offline against the Firebase emulator with the model switched off, which is
itself an eval of the core guarantee: **Rally is fully correct and fully safe with no model at
all.**
