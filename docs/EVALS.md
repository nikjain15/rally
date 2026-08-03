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
| Brief ("catch me up") | invents urgency, or buries a real claim | Ranking is fully deterministic (`buildBrief`); it surfaces only real claims (a pending confirm, a due commitment, the busiest unread) and never calls a model, so it cannot invent urgency |
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

## Layer 4, model evals

- **Recognition-detection precision/recall/F1 (IMPLEMENTED).** `npm run test:evals` runs
  `tests/evals/detection.test.ts` against a committed, synthetic labeled JSONL set
  (`tests/evals/data/recognition.labeled.jsonl`, 50 cases: varied gratitude phrasings and
  multi-mention positives; self-credit, sarcasm, "thanks in advance", requests, and no-mention
  negatives; plus keyword-free gratitude to stress recall). The scorer (`lib/eval-detect.ts`) is
  pure and network-free — it runs in the same lane as unit, no emulator or model key needed. It
  scores both `detectRecognitions` (baseline) and `detectRecognitionsSmart` (model layer) as
  (helper, kind) pairs and reports precision, recall, F1, and the false-positive rate (the costly
  error, tracked alone). The current baseline scores **precision 0.83 / recall 0.92 / F1 0.87 /
  FP-rate 0.14**. The test asserts the contract in `lib/detect-model.ts`: the model layer is
  **never worse** than the baseline on F1 and adds **no** false positives. With `ANTHROPIC_API_KEY`
  absent (as in CI) the model layer falls back to the baseline, so the contract holds by
  construction; with a key present the same test genuinely measures whether the model beats regex.
  Publishing one run with a live key is the next step, and until then the model-vs-baseline delta is
  unmeasured.

### Provenance of the labeled set

**The 50 cases are synthetic and hand-written, not sampled from production usage.** Every handle is
an invented placeholder (`@alice`, `@bob`, `@carol`, `@tina`, and so on down the alphabet); no real
member, message, or channel appears in the file.

The set was authored to cover named difficulty bands, and the file is sectioned by them so coverage
is auditable at a glance: clean single-mention positives, multi-mention positives sharing one verb,
dedupe (same helper mentioned twice yields one recognition), clean negatives with no mention, clean
negatives with a mention but no credit, self-credit negatives, hard negatives (thanks-in-advance,
requests, sarcasm), and hard positives that express gratitude with no keyword verb to stress recall.

What that buys is real: the bands are exactly the failure modes the detector is designed around, so
a regression in any one of them turns the suite red, and the false-positive guards are explicit
rather than incidental. What it does not buy is distributional realism. Hand-written cases cannot
tell you how often each band actually occurs, and they miss the phrasings nobody thought to invent.

Next step: fold in real pilot messages, sampled from the 65-person cohort and labeled by hand, so
the set reflects observed phrasing frequency alongside the designed bands.
- **Brief quality via LLM-judge (ROADMAP).** Given a synthetic inbox, judge the brief on: did it surface
  every real claim, invent zero urgency, and stay within three items. Scored by a judge model
  with a rubric; report pass rate and the invented-urgency rate (must be ~0).
- **Assistant faithfulness.** Judge that a proposal matches the user's intent and that the reply
  never claims to have *done* something it only drafted.

### How the grading is graded, and why there is no judge to validate

The standard question here is "you grade with an LLM judge, so how do you know the judge is any
good". Rally's answer is that there is no judge on the detection path. Grading is `scoreCase` in
`lib/eval-detect.ts`: exact, multiplicity-aware set matching on `(helperHandle, kind)`, order
independent. No model, no prompt, no rubric. An exact check cannot drift between runs, cannot be
argued out of a verdict, and costs nothing, so it runs on every commit rather than on a schedule
somebody has to remember. The scorer's own behaviour is pinned by four cases in
`tests/evals/detection.test.ts` covering the perfect prediction, the wrong helper (which must count
as both a false positive and a false negative), the miss, and the spurious detection.

Choosing exact matching over a judge is the point, not a shortcut taken for lack of one. The LLM
judge in the roadmap items above is for *brief quality* and *assistant faithfulness*, where the
output is prose and there is nothing exact to compare against. When that lands it will need its own
validation against human labels, and it does not exist yet.

What still needs showing is that the labels are being beaten by more than a trivial strategy would
beat them. A score reported on its own measures the dataset as much as the detector: on a set that
is mostly positives, firing on every `@handle` looks like good recall, and on a set that is mostly
negatives, returning nothing looks like a flawless false-positive rate. So every number is reported
next to the number it has to beat.

**Measured 2026-08-02 on the committed 64-case set:**

| | F1 | case agreement | Cohen's kappa |
|---|---|---|---|
| **shipped detector** | **0.861** | **0.844** | **0.684** (substantial) |
| null: credit every `@handle` | 0.362 | 0.703 | 0.381 |
| null: never propose anything | 0 | 0.469 | 0 |
| best single-answer strategy | n/a | 0.531 | 0 |

Per class, because one good direction is not quality: the detector catches **0.912** of the messages
that genuinely credit someone (31/34) and correctly leaves **0.767** of the rest alone (23/30).

Three things that table is built to make visible:

- **The every-handle null model is genuinely tempting.** It scores 0.703 case agreement, which reads
  as respectable, precisely because half these messages do credit somebody. Its kappa is 0.381 and
  it fires on 5 of every 8 messages. This is the exact shape of a metric that flatters a strategy
  carrying no signal, and it is why raw agreement is never reported alone here.
- **The always-silent null model scores a perfect false-positive rate**, 0.000, and precision 1.0.
  Both are the best possible values. Its kappa is 0 and its F1 is 0. A false-positive rate quoted on
  its own would rank it above the shipped detector.
- **The set is 53% positive**, inside the 40/60 band, so kappa is stable and an always-one-answer
  detector cannot look competent. That balance is asserted, not assumed.

The floors asserted in the suite sit below each of those measurements: kappa at 0.6 (the bottom of
Landis and Koch's *substantial* band, the same floor Conduit and Pulse hold their judges to),
agreement more than 0.2 above the majority baseline, catch rate 0.85, leave-alone rate 0.7, and the
shipped detector strictly ahead of every null model on both F1 and kappa. The null models are
committed as real functions rather than remembered figures, so they are recomputed on every run and
cannot go stale as the labeled set grows.

**What this does not establish.** These are 64 hand-written cases, so the numbers describe designed
bands rather than observed traffic, as the provenance section above says. The kappa is agreement
against one author's labels, not inter-rater agreement between two people, which is the stronger
form and needs a second labeller.

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
npm run gate        # typecheck, lint, unit, evals, rules, integration, e2e smoke
npm run test:evals  # detection precision/recall/F1 vs the labeled set (no emulator needed)
npm run test:e2e    # full signed-in browser flows against the emulator
```

Everything above runs offline against the Firebase emulator with the model switched off, which is
itself an eval of the core guarantee: **Rally is fully correct and fully safe with no model at
all.**
