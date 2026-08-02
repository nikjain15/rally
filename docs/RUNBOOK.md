# Rally, incident runbook

## What this is

The rollback procedure for one specific incident, written before it happens: **a prompt or model
change is live and recognition detection is mislabelling right now.** Generic advice was not worth
writing, so every step below names the file, the constant, the env var or the collection it touches,
and says how long it takes and what tells you it worked.

Closes finding **SH8**. It has never been rehearsed. Nobody has run a game day against Rally, and
the timings below are estimates from the shape of the work, not stopwatch numbers. That is the
honest state; see docs/STAKEHOLDERS.md for the rest of what is unverified.

**Rally is run by one person.** There is no rota, no pager, and no second responder. "Escalate" is
not a step that exists.

---

## The thing that makes this survivable

Read this before the ladder, because it changes what "urgent" means.

**Detection cannot award anything.** `lib/detect-model.ts` produces a *suggested* recognition;
`lib/recognition-admin.ts` is the only code that writes `xpEvents`, and it does so only when the
helped peer confirms. A mislabelling model therefore produces wrong SUGGESTIONS at model speed and
wrong POINTS only at human confirm speed. Since DL-6 a pair can bank at most three awards per
rolling day in one direction, so even a fully mislabelling detector cannot inflate the ledger
faster than `pairs x 3 per day`.

So the blast radius during an incident is: noise in people's inboxes, and a bounded trickle into the
ledger. That is the difference between rolling back carefully and rolling back frantically. Roll
back carefully.

**The deterministic baseline is the bottom rung.** `lib/detect.ts` is a pure, dependency-free regex
matcher that needs no key, no network and no deploy-time configuration. Every intelligence in Rally
is built to fall back to it. It is measured: `npm run test:evals` scores it at precision >= 0.7 and
recall >= 0.8 against the committed labeled set. It is not as good as a working model, and it is a
known-quality floor that cannot be moved by anything happening to a provider or a prompt. **Every
rung of the ladder below is a way of getting to it faster or more precisely.**

---

## 0. Confirm it is real, 5 minutes

Do not roll anything back on a hunch. Three signals, in order of how quickly they answer:

| Signal | Where | What "bad" looks like |
|---|---|---|
| `model_invalid_output_rate` | `GET /api/ops/slo` with `X-Rally-Ops-Secret` | Above 0.05. This is the number a bad prompt moves FIRST: the model is answering but the answer fails `isDetections`. A provider blip cannot cause it. |
| `[degrade]` log lines | Vercel logs, `lib/agent.ts:recordOutcome` | A run of `reason=invalid_output` starting at a deploy time. |
| The suggestions themselves | `recognitions` where `status == 'suggested'`, ordered by `createdAt` | The actual test. Read ten. If the helper handle is wrong or the `kind` is wrong, it is real. |

The third one is the only one that detects the WORST case, which is a change that produces
well-formed, confidently-scored, wrong output. That passes the type guard, passes the confidence
gate, moves no SLO indicator, and is invisible to everything except reading it. **If the SLO is
clean and the suggestions are wrong, believe the suggestions.**

Write down the deploy SHA and the timestamp of the first bad suggestion now. Step 5 needs both.

---

## The ladder

Ordered by speed and certainty, not by elegance. Take rung 1 first even if you are fairly sure
rung 2 is the real fix, because rung 1 cannot fail in a new way and rung 2 can.

### Rung 1. Switch the model off. ~3 minutes.

**Unset `ANTHROPIC_API_KEY` in the Vercel project and redeploy.**

`hasModel()` in `lib/agent.ts` reads the env var, and with no key `callClaudeDetailed` returns
before any client is constructed. Detection falls to `detectRecognitions`, the Brief falls to its
deterministic gather, the assistant falls to its scripted path. The provider is not contacted at
all.

- **Time:** a Vercel env change needs a redeploy to take effect, which is a build. Call it three
  minutes. It is still the fastest rung because there is nothing to review, nothing to merge, and no
  new code enters production.
- **What it costs:** every model-backed feature gets worse at once, not just detection. Accept that.
  A blunt rollback that definitely works beats a precise one that might.
- **Signal it worked:** `[usage]` lines stop appearing in the logs entirely. `/api/ops/slo` shows
  `model_degrade_rate` with `samples: 0`, because `no_key` is deliberately excluded from the
  denominator. New suggestions match what `lib/detect.ts` would produce: a verb from the fixed list
  plus an `@handle`.
- **If it did not work:** the suggestions are not coming from the model. Check whether something is
  re-running detection over old messages, and go to step 4 rather than up the ladder.

### Rung 2. Revert the change. ~10 minutes.

**`git revert <sha>` on `main` and let CI deploy it.**

The candidates, in the order they are worth suspecting:

1. `DETECT_SYSTEM` in `lib/detect-model.ts`, the extraction instruction, shared by both tiers. A
   change here hits every detection immediately.
2. `MODELS` in `lib/agent.ts`, a tier swap. Note `supportsSampling()`: a new model on the sampling
   denylist that is not listed there will be sent a `temperature` and answer with an HTTP 400, which
   shows up as `exhausted`, not as mislabelling.
3. `CONFIDENCE_THRESHOLD` in `lib/detect-model.ts`. Lowering it surfaces guesses that used to be
   dropped, which reads exactly like "the model got worse".

- **Time:** revert, push, CI (`typecheck`, `lint`, `test:unit`, `test:evals`, the audit gate, then
  the emulator job), deploy. Ten minutes if nothing is queued.
- **Signal it worked:** `npm run test:evals` on the reverted tree scores at or above the pre-incident
  numbers, and new suggestions read correctly. If a key is set locally, that eval run is a genuine
  measurement of the model layer; with no key it compares the baseline to itself and proves nothing
  (AS-4), so in that case the signal is reading new suggestions in production.
- **Order matters:** do this AFTER rung 1. Reverting while the model is off is a calm, reviewable
  change. Reverting while it is live is a change under pressure that could ship a second fault.

### Rung 3. Narrow the model back, without turning it off. ~10 minutes.

Only when rung 2 is not available, for example when the fault is in the provider's model rather than
in Rally's diff. Two dials, both in `lib/detect-model.ts`:

- **Raise `CONFIDENCE_THRESHOLD`** toward 0.9. The gate drops anything the model marks below it, so
  the detector abstains rather than guesses. Abstaining costs recall, which costs recognitions
  nobody gets. That is a real cost and the right one to pay during an incident, because a wrong
  recognition erodes trust and a missing one does not.
- **Remove the escalation.** If the ambiguous path is where the mislabelling lives, deleting the
  `ambiguous` branch drops back to the single cheap pass. Bounded change, one function.

Signal: `model_invalid_output_rate` back under 0.05 and the sampled suggestions reading correctly.

### Rung 4. Stop detection running at all. ~3 minutes.

The floor below the floor, if even the regex baseline is producing garbage (a bad `MENTION` or
`VERB_KIND` edit in `lib/detect.ts`). Rally has **no feature flag**, which is a real gap and is
recorded as open below. Today the options are:

- Revert `lib/detect.ts` (the file has no dependencies, so a revert is safe by inspection), or
- have `POST /api/detect` return `{ detected: 0, degraded: true }` before calling the detector,
  which is a two-line change on a path that already has that exact early return for a missing admin
  credential.

Core comms is unaffected either way. `app/api/detect/route.ts` is already documented as
degrade-to-no-op, and the channels screen never waits on it.

---

## 4. Clean up what already landed

Rolling back stops new damage. It does not undo what shipped, and the two halves need different
treatment because of a deliberate design decision.

**Unconfirmed suggestions: delete them.** Bad suggestions sitting in members' inboxes are the
visible harm. Delete `recognitions` with `status == 'suggested'` created inside the incident window.
The retention sweep will do it eventually (`lib/retention.ts`, 30 days for unresolved recognitions)
but 30 days is not an incident response; run a targeted delete on the window.

**Confirmed recognitions: do NOT delete the ledger rows.** `xpEvents` is append-only, and every rank
in Rally is recomputed from it. Deleting rows to tidy up an incident is the same act as deleting
rows to flatter someone, and the system cannot tell them apart. The correction is a **compensating
entry**: a new `xpEvents` row with negative points, `source: 'correction'`, and `refId` pointing at
the recognition it reverses. The ledger then shows both what happened and that it was corrected,
which is what an append-only ledger is for.

Bounded by DL-6: at three awards per pair per day, an incident lasting under a day cannot have
produced many. Count them before deciding it is worth doing at all.

**Tell people.** A wrong recognition is a social event, not just a data one. Post in `#general`
saying detection was wrong for a window, that the points were corrected, and that nobody did
anything wrong. Rally's whole premise is that the ledger is trustworthy; an unexplained correction
costs more trust than the original error.

---

## 5. Make the incident permanent

**This is the step that stops it being the same incident twice, and it is the one most likely to get
skipped once the graphs look fine.**

1. **Pull the real messages.** From the incident window, take the actual `sourceMsgRef` bodies that
   were mislabelled. Real text, not a paraphrase: the phrasing is the finding.
2. **Label them by hand.** What a correct detector should have emitted, in the same shape as the
   rest of the set: `{"helperHandle": ..., "kind": ...}`, or `[]`.
3. **Append them to `tests/evals/data/recognition.labeled.jsonl`** with a band naming the incident,
   for example `"band": "incident-2026-08-14"`. `parseLabeledJsonl` carries `band` through, and the
   existing injection band in that file is the worked example of a band asserted on its own terms
   instead of being averaged away.
4. **Add a band assertion in `tests/evals/detection.test.ts`.** The aggregate score will not protect
   you: six cases out of eighty cannot move an F1 enough to fail a floor. The band needs its own
   `it(...)` that iterates it and asserts each case exactly, exactly like
   `'returns NO recognitions for every injection case'` does.
5. **Verify the fix against it before merging.** The revert plus the new cases must be green
   together. A revert that does not turn the new cases green was not the fix.
6. **Write the decision down.** A new `DL-n` entry in `docs/DECISION_LOG.md`: what changed, why it
   was wrong, and what is now measured that was not before.

Steps 3 and 4 are the whole point. Everything above restores service; only this changes what the
next deploy is allowed to do.

---

## Contact points and configuration

| Thing | Where |
|---|---|
| `ANTHROPIC_API_KEY` | Vercel project env. Unsetting it is rung 1. |
| `RALLY_OPS_SECRET` | Vercel project env. Required by `/api/ops/slo`, `/api/ops/retention`, and operator-mode erasure. |
| SLO readout | `GET /api/ops/slo` with `X-Rally-Ops-Secret`. Thresholds in `lib/slo.ts`. |
| Degraded flag, unauthenticated | `GET /api/health` → `sloBreaching`. One boolean, no numbers. |
| Retention sweep | `POST /api/ops/retention`. Policy readable at `GET` on the same route. |
| Member erasure | `POST /api/me/erase`. Self-service with a member's ID token; operator mode with the ops secret and a `uid`. Deleting the Firebase Auth user is a separate manual step. |

---

## What this runbook does not have

Stated rather than implied, because a runbook that reads as complete when it is not is worse than a
short one:

- **No alerting.** Nothing pages, emails or posts anywhere. `/api/ops/slo` and `/api/health` compute
  the numbers and something outside Rally would have to poll them. Nothing does. In practice
  detection today is "somebody noticed", and step 0 assumes a human already suspects a problem.
- **No feature flag.** Every rung is an env change or a deploy. A kill switch for detection alone,
  readable at runtime, is the smallest thing that would most improve this document.
- **No rehearsal.** No game day has been run. Every timing is an estimate.
- **No second responder.** One person, no rota.
- **No automated compensating-entry tool.** Step 4's ledger correction is described but not written;
  today it is a manual write through the Admin SDK.
