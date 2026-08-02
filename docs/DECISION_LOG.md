# Rally, decision log

## What this is

A running record of the assumptions Rally is operating under, the decisions that have been made or
defended, the scope that has already been cut, and the kill criteria (there are none yet, and this
document says so plainly rather than inventing one).

**Rally is built by one person, Nik Jain, working solo.** The reviews referenced throughout this
document, recorded in [`STAKEHOLDERS.md`](STAKEHOLDERS.md), are **simulated**: one person
role-playing three senior reviewers against his own code. No lawyer, security engineer,
accessibility specialist, or any other external party has reviewed Rally or approved anything. Every
"decision" below was made by one person; the reviewer names are roles being argued from, not people.

This is not a set of ADRs. It is an index and a change record. Per-decision ADRs do not exist
anywhere in the repo, which is finding A-P1-3 and is still open. When they are written, this file
should point at them rather than replace them.

Last updated 2026-08-02 against commit `8bca84e`, then amended the same day to add DL-6, which
supersedes DL-3 and closes finding D-P0-3, and amended again the same day to add DL-7 through DL-11
from a security and operations pass (findings SH1, SH3, SH8, SH9, SH10 and GEN1, recorded in
[`STAKEHOLDERS.md`](STAKEHOLDERS.md#amendment-2026-08-02-security-and-operations-pass)).

---

## Assumptions in force

Each of these is load-bearing, unverified or only partly verified, and would change the product if it
turned out to be false. Listing them is the point: an assumption that is written down can be attacked.

| # | Assumption | Status | What would falsify it |
|---|---|---|---|
| AS-1 | Peer confirmation is enough to make recognition trustworthy | **False, and no longer relied on.** Confirmation alone stops self-award and client-minted points, both proven by `tests/rules/firestore.test.ts`, and it never stopped a cooperating pair (finding D-P0-3). Since DL-6 the economy no longer rests on confirmation alone: a per-pair rolling allowance bounds it | Already falsified for the pair case, which is why the guard exists. It would be falsified again by a ring of manufactured accounts, which nothing in Rally defends against. The absolute claim in `README.md` should still be narrowed |
| AS-2 | Members will actually confirm the recognitions suggested to them | **Unverified.** Nothing in the app records the suggested-to-confirmed rate, though `docs/PRD.md` names it as a supporting metric | Measuring it. If the conversion is low, the north-star metric has no supply and the whole loop is decorative |
| AS-3 | Cohort scale is representative enough to defer scaling work | **Holds today, will not hold later, and is now measurable.** The full ledger scan in `lib/leaderboard-admin.ts` is still O(all events ever). Since DL-9 it carries `LEADERBOARD_P95_BUDGET_MS` and `LEADERBOARD_BUDGET_LEDGER_EVENTS`, and `tests/integration/perf.test.ts` measures p95 at that 20,000-event ceiling rather than at today's few hundred | The budget test going red, which is the first version of this assumption that can actually fail. Note it fails against a seeded emulator, so it catches an algorithmic regression, not a real-user percentile |
| AS-4 | The model layer improves on the regex baseline | **Never measured.** With no API key the model falls back to the baseline, so the CI comparison compares the baseline to itself | One eval run with a live key. Until then, no claim in either direction is supported |
| AS-5 | GitHub handle is a stable cross-app identity key | **Unverified and structurally untestable today.** A renamed GitHub handle silently splits a person's history, and with only one app on the bus nothing can detect it | A renamed handle, or a second app joining the bus |
| AS-6 | Rate limiting bounds model spend | **Weak, and now at least visible.** `lib/rate-guard.ts` line 13 is still in-memory per warm instance, so the real ceiling is limit times instance count. DL-10 adds a spend threshold (`model_spend_usd_per_hour`, 5) that reads the same per-instance meter and inherits the same limitation, so it detects a runaway loop on one instance and nothing about the fleet | Any traffic pattern that spins up many instances. A shared Firestore counter remains the fix for both the limit and the meter |
| AS-9 | The retention windows in `lib/retention.ts` are set where the product stops needing the data | **Chosen, not measured**, exactly like the DL-6 constants. Nothing in Rally records how far back anyone scrolls, how old a read message is, or whether a 90-day assistant thread is ever referenced | Any usage data at all on read recency. Also falsified in the other direction by a legal or contractual requirement, since no counsel has read this (DL-7) |
| AS-10 | The SLO thresholds in `lib/slo.ts` mark the point where Rally is broken | **Chosen, not calibrated.** Rally has never run under sustained load with a live key, so 0.20 degrade, 0.05 invalid output and $5/hour are derived from where Rally's own contract stops holding, not from observed distributions | The first week of real traffic with a key set. If any threshold fires routinely it was too tight; if a real incident passes under all three it was too loose (DL-10) |
| AS-7 | Recognition points will not be read as a performance signal by an adopting org | **Untested.** True in a cohort of peers; entirely unknown once a manager is in the workspace | The first organisation where someone screenshots the leaderboard into a review |
| AS-8 | The four screens are usable by keyboard and screen reader users | **No evidence either way.** Manual `aria-label` work exists; zero automated or assistive-technology verification (finding D-P1-4) | Running an accessibility check. Two specific defects are already provable from source: `components/onboarding.tsx` line 36 and `app/channels/page.tsx` line 454 |

---

## Decisions these reviews changed

One at review time, and one since, from the three simulated reviews. That is the honest count for
them. DL-7 through DL-11 come from a separate security and operations pass on the same day and are
kept in the same list so the reasoning sits together, but they should not be read as output of the
role-play exercise. Their findings are recorded under
[a clearly-marked amendment](STAKEHOLDERS.md#amendment-2026-08-02-security-and-operations-pass).

### DL-1 The hosted MCP transport claim is corrected

- **Decision:** `docs/ARCHITECTURE.md` no longer states in the present tense that a hosted deployment
  fronts the MCP SSE transport. It now says stdio is the only transport that ships and points at
  `docs/MCP.md`.
- **Why:** `docs/MCP.md` line 64 already said "Status: not shipped" and listed what would be needed.
  `docs/ARCHITECTURE.md` line 233 contradicted it, in the document a reader opens first. Verified:
  `lib/mcp/` contains only `rally-server.ts`, `rally-tools.ts` and `stdio-entry.ts`, and no route
  under `app/api/` mentions SSE.
- **Scope:** documentation only. No code changed.

### DL-6 The recognition economy gets a boundary: self-authored thanks pay zero, and each pair has a daily allowance

**This supersedes DL-3, which defended leaving the farming vector alone.** DL-3 is left below with
the reasoning that produced this shape, because a reversed decision is more useful with its original
argument attached than without it.

- **Decision:** two guards, both inside the existing confirm transaction in
  `lib/recognition-admin.ts`.
  1. A recognition now records `authorUid`, the person who wrote the message the credit came from
     (`app/api/detect/route.ts` sets it to the verified author). The confirmer's small thank-you,
     `CONFIRM_THANKS`, is paid only when the confirmer is *not* that author. Today's detector always
     makes the author the helped peer, so confirming your own "thanks @bob" now pays you zero.
  2. One helper can bank points from the same helped peer at most three times per rolling 24 hours,
     tracked per ordered pair in a new server-only `recognitionPairs` collection, read and written in
     the same transaction as the award. Past the allowance the recognition **still confirms and still
     posts to the pulse feed**; it is worth zero XP and is marked `capped`.

- **Why this shape:** the alternative that actually kills farming outright is requiring a third-party
  confirmer, and that was rejected because in a two-person conversation nobody would be able to
  confirm anything. That is not a hardened loop, it is no loop. Zeroing the self-confirm thank-you
  alone was also rejected as insufficient: it removes 2 points from the author and leaves the
  helper's 12, so a pair alternating still mints 12 a message. Only the pair allowance turns the
  farm's yield from "grows with every message" into "a constant per day", and only the "still
  confirms, just worth nothing" behaviour keeps it from punishing real pairs.

- **The tradeoff accepted, stated plainly:** two teammates who genuinely help each other more than
  three times in one direction in one day will see later recognitions pay nothing. That is a real
  cost and it lands on Rally's best users. It is accepted because what those users lose is the
  points, not the recognition: the confirm still lands, the pulse feed still announces it, and the
  record still shows it. A points ceiling on one relationship is a defensible thing for the product
  to say out loud, in a way that "your thanks did not register" would never be.

- **Rejected alongside:** reciprocity damping in `lib/leaderboard-admin.ts`. The DL-3 objection to it
  stands unchanged: a rank nobody can explain erodes exactly the trust the ledger exists to build. A
  flat, statable rule beats a smooth one here.

- **Also accepted:** the numbers, three per day per direction, are chosen not measured. Nothing in
  Rally records how often a real pair recognises each other, per AS-2 and finding D-P1-8, so the cap
  was set well above plausible behaviour rather than tuned. When the recognition funnel is finally
  instrumented, this is the first number that should be re-derived from data, and it is the reason
  both constants are exported and unit-tested rather than buried.

- **What is still not solved:** the allowance is per pair, so a ring of many accounts still scales
  linearly with the number of accounts. Rally has no defence against manufactured identities and
  this decision does not add one. At a cohort where every account is a known person, that is an
  accepted limit, not a solved problem.

- **Scope:** `lib/recognition-admin.ts`, `app/api/detect/route.ts`, and a deny-all rule for the new
  `recognitionPairs` collection in `firestore.rules`. The confirm and award logic is where the fix
  belongs; the rules were never wrong here, which is why 45 of the 48 rules tests are untouched.
  Verified with `tests/unit/recognition-economy.test.ts`, the new group in
  `tests/integration/recognition.test.ts`, and three added rules tests. Every new integration test
  was confirmed to fail with the cap removed.

### DL-7 Retention is enforced code, and erasure keeps the ledger while losing the person

Closes finding SH9.

- **Decision:** windows per data type live in `lib/retention.ts` as data, and `sweepRetention`
  enforces them. Messages and commitments 400 days, pulse events 180, assistant memory 180, assistant
  thread messages 90, unresolved recognitions 30, `recognitionPairs` 7. `xpEvents` and `profiles` are
  indefinite and say so. `eraseMember` deletes one member's identity, own content, reads, reactions,
  commitments, quests, assistant data and every recognition that names them, from
  `POST /api/me/erase`.

- **The decision that actually needed making, and it is a tradeoff, not a fix:** what erasure does to
  the append-only ledger. Three options were on the table.
  1. **Delete the rows.** Cleanest privacy story, and it silently rewrites team totals and rank
     history. Worse, it makes "delete rows from the ledger" a supported operation, and the system
     cannot distinguish deleting rows to honour a request from deleting rows to flatter someone.
     Rejected.
  2. **Re-key to a hash of the uid.** Stable, tidy, and false: a hash over a known 65-person uid set
     is reversible by enumerating it. Rejected, because it is pseudonymisation presented as
     anonymisation, which is the exact class of overclaim this repository keeps trying to remove.
  3. **Re-key to a fresh random tombstone**, generated at erasure time and stored in no lookup table.
     Chosen. The arithmetic survives, the link to the person does not.

- **The cost accepted, stated plainly:** the leaderboard keeps a participant nobody can name, and two
  separately erased members are not linkable to each other but are both visible as ghosts. That is
  asserted in `tests/integration/retention.test.ts` rather than left as prose, so it cannot quietly
  stop being true.

- **What deletion cannot reach, and why that is a decision too.** Other members' message bodies are
  not rewritten. If Ana wrote "thanks @bob", that is Ana's sentence. Editing one member's words to
  satisfy another member's request would corrupt the record while leaving the meaning perfectly
  legible: strictly worse than both leaving it and deleting the whole message. Also unreachable:
  Firebase backups and point-in-time recovery, Vercel logs, GitHub issues, and the cross-app bus. All
  of it is returned in the API response on every erasure, not only written here.

- **Rejected alongside:** a per-member "download my data" export. It is the natural companion and it
  is a different piece of work with its own disclosure surface, and shipping a thin version of it
  alongside this would have been the weaker half of two features rather than one done properly.

- **Still open:** nothing schedules the sweep, so the policy is enforceable and not enforced. The
  Firebase Auth user is not deleted (separate credential store, deliberately a separate decision).
  The windows are chosen, not measured (AS-9). And no lawyer has read any of this, so none of it is a
  compliance claim.

- **Scope:** `lib/retention.ts`, `lib/ops-auth.ts`, `app/api/ops/retention/route.ts`,
  `app/api/me/erase/route.ts`. Verified by `tests/unit/retention-policy.test.ts` and 17 emulator tests
  in `tests/integration/retention.test.ts`.

### DL-8 Suppressing an advisory requires a reason and an expiry date, and the expiry fails the build

Closes finding SH10.

- **Decision:** `npm audit` runs in CI through `scripts/audit-gate.mts`. It fails on high and
  critical, reports moderate and low, and every exception lives in `security/audit-allowlist.json`
  with a package, GHSA id, reason, link and **expiry date**.

- **Why not plain `npm audit --audit-level=high`:** because it would fail on the first unfixable
  transitive advisory and stay red forever, and a permanently red check is a check everyone learns to
  ignore. That is a worse outcome than no check, because it looks like coverage.

- **The load-bearing rule:** an entry past its expiry **fails the build even when the advisory it
  covers has since been fixed**. That looks pedantic and it is the whole point. A suppression is a
  promise to look again on a date; if nobody looked, the promise was not kept, and the build is the
  only thing that will ever collect on it. Deleting the entry is a perfectly good resolution, but it
  has to be a thing someone does, not a thing that decays. Also failed: an expiry more than 180 days
  out, so nobody can write "expires 2099", and a reason under 40 characters, so nobody can write
  "known".

- **What decides severity here is reachability, not npm's label.** The triage table in
  `STAKEHOLDERS.md` records the verdict per high. The one that mattered: `sharp` could not be
  upgraded without forcing a 0.x major outside the range `next` declares, so instead
  `next.config.ts` sets `images: { unoptimized: true }`, which switches off the only endpoint that
  loads it. Turning an argued non-reachability into a structural one was worth more than the version
  bump, and the version bump is flagged rather than applied.

- **Scope:** `.github/workflows/ci.yml`, `scripts/audit-gate.mts`, `security/audit-allowlist.json`,
  `.gitleaks.toml`, `next.config.ts`, `package.json`. Verified by 23 tests in
  `tests/unit/audit-gate.test.ts`, one of which runs the committed allowlist against the real clock.

### DL-9 The ledger scan gets a p95 budget rather than a rollup

Narrows findings A-P0-1, A-P1-6 and GEN1. **This does not supersede DL-2; it is DL-2 with a number
attached.**

- **Decision:** `LEADERBOARD_P95_BUDGET_MS` (1500) and `LEADERBOARD_BUDGET_LEDGER_EVENTS` (20,000) in
  `lib/leaderboard-admin.ts`, enforced by `tests/integration/perf.test.ts`, which grows the ledger to
  that ceiling and measures p95 over repeated calls.

- **Why not the rollup, given DL-2 already promised reconciliation first.** Because doing it properly
  means writing a mutable per-member total from three transactions
  (`lib/recognition-admin.ts`, `lib/commitment-admin.ts`, `lib/quest-admin.ts`), each of which
  currently carries an anti-gaming invariant, plus the reconciliation job that proves the rollup still
  equals the ledger. Without that job the rollup is a second source of truth for the number the
  product's credibility rests on. Shipping the fast version and deferring the correctness check to
  close a finding would trade a measured slow path for an unmeasured wrong one, which is the opposite
  of what this audit is for.

- **Why not a cache.** Per warm instance on a serverless deployment, so it flatters the p95 while
  doing nothing for the cold call that is actually slow, and it puts a staleness window on a screen
  whose appeal is that the number is live.

- **What this genuinely buys, stated narrowly:** the defence in DL-2 can now fail. Before, AS-3 said
  "this will not hold at scale" and nothing could ever contradict it. What it does **not** buy is an
  answer to A-P1-6's actual question: this is a seeded emulator, so it catches an algorithmic
  regression and says nothing about the 95th-percentile real user. No API route emits a duration.

### DL-10 The threshold is defined and the alert is not, and the gap is stated rather than blurred

Closes the measurement half of finding SH3.

- **Decision:** three thresholds in `lib/slo.ts` (degrade rate 0.20, invalid-output rate 0.05, spend
  $5/hour), each with its reasoning in place, computed at `GET /api/ops/slo` and reduced to one
  unauthenticated boolean on `GET /api/health`.

- **The choice worth recording is `no_key`.** An absent `ANTHROPIC_API_KEY` is the model switched
  off, which is a configuration state, so it is excluded from every denominator. Counting it would
  make local dev and CI, where there is never a key, look like a permanent outage, and a signal that
  is always red is a signal nobody reads. The cost is that "somebody deleted the key in production"
  does not trip the degrade rate; it shows as samples going to zero, which the runbook names as the
  confirmation signal for rung 1.

- **Why the invalid-output rate is separate and tighter.** It is a different diagnosis, not a stricter
  version of the same one. A provider blip cannot make a model return well-formed prose that fails a
  type guard; a prompt change, a model swap, or input reshaping the prompt can. Splitting them is
  what lets the runbook say "if this one moved, look at the last deploy" instead of "something is
  wrong somewhere".

- **What is deliberately not claimed: this is not alerting.** No pager, no email, no webhook, nothing
  polls it. `/api/ops/slo` returns its own `caveats` array saying so, so a reader cannot mistake a
  number for an alarm. Calling a route that computes a boolean "monitoring" would be exactly the
  overclaim `STAKEHOLDERS.md` exists to catch.

- **Inherited limitation, not solved:** the meters are in-process ring buffers, so every number
  describes one warm instance (AS-6, AS-10). A breach is real; a clean report proves nothing.

### DL-11 Injection gets a case set, not a filter

Closes the test half of finding SH1.

- **Decision:** 13 injection cases in `tests/evals/data/recognition.labeled.jsonl` under a new
  `injection` band, covering instruction override, role override and exfiltration, asserted
  individually in `tests/evals/detection.test.ts` because an aggregate F1 cannot see 13 cases in 64.

- **No input filtering was added, and that is the decision.** Screening message text for "ignore
  previous instructions" is a defence an attacker rephrases around on the first attempt, and shipping
  it would let Rally claim protection it does not have while adding a new way for a real message to be
  silently mangled. The actual defence is structural and already existed: the model holds no
  side-effecting tools, output is type-guarded and confidence-gated, and detection produces a
  suggestion that the helped peer must confirm, capped per pair by DL-6. A fully successful injection
  buys a suggestion. The band exists to keep that true, not to replace it.

- **The weakness is asserted, not hidden.** A 14th case in an `injection-mixed` band shows the
  deterministic baseline crediting a handle smuggled after a real thank-you, because it matches one
  verb and every `@handle`. The test asserts that behaviour with the containment argument attached, so
  if anyone later adds screening, that assertion is what fails and the design gets re-argued rather
  than drifting.

- **Still open:** 13 hand-written shapes prove those shapes are handled and nothing about shapes
  nobody thought of. No injection coverage exists for the assistant or the Brief, which read the same
  corpus. And with no key in CI the model half of the assertion holds by construction, per E-P1-3.

---

## Decisions these reviews defended (deliberately not changed)

These were attacked, examined, and left alone with a reason. Leaving something alone with a written
reason is a decision; leaving it alone silently is drift.

### DL-2 The ledger stays a full scan, for now

Attacked by A-P0-1: `lib/leaderboard-admin.ts` line 45 reads the entire `xpEvents` collection on
every call, and `app/home/page.tsx` line 77 refetches on every XP change.

**Defended, with a caveat.** At 65 members the scan is correct and cannot drift. A per-user rollup
introduces a second source of truth for the number the entire product's credibility rests on, and a
rollup that disagrees with the ledger is a worse failure than a slow query. The ordering is therefore
reconciliation first, rollup second, not the reverse. The caveat is AS-3: this defence expires at
scale and nothing currently triggers a re-examination.

### DL-3 Peer confirmation stays as the only anti-gaming control on the economy: SUPERSEDED by DL-6

Attacked by D-P0-3: two members can pump each other indefinitely, 12 points per message each way,
bounded only by a per-instance rate limit.

**Defended as code, conceded as a claim.** The obvious fix, a per-pair cap per window, punishes the
two people who genuinely pair most often, which is the exact behaviour Rally exists to reward.
Reciprocity damping makes rank harder to explain, eroding the trust the ledger was built to earn. At
cohort scale, where everyone can see the pulse feed, social visibility is a real deterrent and the
cure may be worse than the disease.

What is **not** defensible is the absolute phrasing. "Recognition that can't be gamed" is not what
the code delivers. The narrower true claim, which is still a strong one, is that no client can mint
points and nobody can award themselves, both proven by the rules tests. Rewording is an open item
against `README.md` and `docs/PRD.md`.

**Reversed on 2026-08-02 by DL-6.** The defence assumed a cap that refuses the recognition. A cap
that zeroes only the points, while the confirm and the pulse still happen, does not carry the cost
this entry was protecting against. The wording item above is still open, and DL-6 does not close it.

### DL-4 The 50-case labelled set stays

Attacked by E-P0-1 and E-P0-2: 66 percent positives against a stream that is mostly negatives, and
too small to resolve the difference its own contract test asserts.

**Defended as an artifact, conceded as a headline.** A hand-written set sectioned by difficulty band
makes the designed failure modes auditable at a glance and turns a regression in any band red, which
a scraped sample would not. The mistake is quoting precision 0.825 in `README.md` line 98 as a result
without the base rate attached. Keep the set, fix the framing, and fold in labelled pilot messages
alongside rather than instead.

### DL-5 The retry ladder stays per call, not per turn

Attacked by A-P1-7: six agent steps at a 20-second budget each means one assistant turn can spend
about 120 seconds, with no `maxDuration` set on the route and no `vercel.json` in the repo.

**Partly defended.** Per-call budgets are the right shape, and `lib/retry.ts` lines 84 to 109 name
them per call site with reasoning at each. The gap is real and is not a design disagreement: a turn
needs a deadline, and the routes need an explicit platform timeout. Recorded open rather than
defended, and deliberately not patched here, because guessing at a `maxDuration` without measuring
real turn latency would be inventing a number.

---

## Scope cuts already visible in the repo

These were cut before these reviews existed. They are recorded because an undocumented cut looks
identical to an oversight.

| Cut | Where it is visible | Why |
|---|---|---|
| Voice, video, enterprise SSO and SCIM, native mobile | `docs/PRD.md` non-goals | Out of scope for a cohort pilot |
| A production cross-app bus on a dedicated shared Firebase project | `docs/SHARED-CONTEXT.md` "Current state"; the bus falls back to Rally's own database | Needs a second app to exist. Rally-side contract is complete |
| Hosted MCP over HTTP and SSE | `docs/MCP.md` "Roadmap: hosted HTTP/SSE (not deployed, not routed)" | stdio covers the actual use, and the hosted path needs an SDK dependency and two routes |
| LLM judge for brief and assistant quality | `docs/EVALS.md` layer 4, marked roadmap | No harness built. Finding E-P1-6 argues the brief does not need one and the assistant does |
| A/B testing | `docs/EVALS.md` layer 5 | Requires a population to split. One 65-person cohort, no external users |
| Conduit `evaluate` and `usage` surfaces | `lib/conduit/`, documented as a stub that throws | The seam is used for infer, retrieve and runAgent only |
| A shared, durable rate limit | `lib/rate-guard.ts` line 13, which names the Firestore counter as the next step | In-memory was enough to stop a scripted flood in a pilot |
| Penalties for missed commitments | `lib/commitment-admin.ts`; missing a commitment earns nothing and costs nothing | The "lift, never punish" stance. This one is a product principle, not a deferral |

---

## Kill criteria

**No kill line has been set for Rally. Not one. This is stated plainly rather than filled in with a
plausible-looking number, because inventing a threshold Nik never committed to would be exactly the
kind of false precision the rest of this audit removes.**

What a real kill criterion would have to be, so the gap is specific rather than vague:

1. **A single number, pre-committed in writing, before the data is looked at.** Choosing a threshold
   after seeing the result is not a kill criterion, it is a rationalisation.
2. **Tied to the recognition funnel**, because that is where the product's whole thesis lives. Rally's
   claim is that peer-confirmed recognition is worth building a chat app around. The funnel is:
   messages posted, suggestions generated, suggestions confirmed, and confirmed recognitions per
   active member per week (the north star named in `docs/PRD.md` line 81). The kill line belongs on
   the confirm step, because that is the step that tests whether people actually want this, as opposed
   to whether the detector works.
3. **With a stated window and a stated N**, so the result is interpretable. A conversion rate measured
   over one week in a 65-person cohort has an interval wide enough to contain almost any hypothesis,
   which is the same statistical-power problem finding E-P0-2 raises about the eval set. Whatever
   number gets picked has to come with the sample size that makes it mean something.
4. **Honestly checked, including when the answer is unwelcome**, and written down either way. A kill
   criterion that is only consulted when things are going well is not one.
5. **Distinguishing "the loop does not work" from "the loop was never instrumented".** Right now
   Rally cannot fail this test, because it cannot take it: per assumption AS-2 and finding D-P1-8,
   nothing in the app records the suggested-to-confirmed transition or the time to confirm. The
   instrumentation is a prerequisite for the criterion, not a follow-up to it.

**Status: open decision, owned by Nik, unresolved.** Two things have to happen in order, and neither
has: instrument the recognition funnel so the number exists, then pre-commit a threshold on it before
reading the first result. Until both are done, Rally has no kill criteria and should not claim to.

---

## What each review did not look at

Recorded because the boundary of a review is part of its result.

- **Design review:** did not look at the live deployment at rally-nikjain15.vercel.app. No browser
  was opened, nothing was rendered, and no keyboard or screen reader was used, so every accessibility
  finding comes from reading source only.
- **Architecture review:** did not look at the vendored Conduit tree beyond its seam into
  `lib/agent.ts`, the GitHub webhook HMAC path, `firestore.rules` beyond three collection blocks, or
  the emulator-backed integration and e2e suites, which were not run.
- **Eval review:** did not look at the rules tests, which `docs/EVALS.md` itself calls Rally's most
  important evals, nor at the 50 labelled cases individually, so no claim is made about label
  correctness.
