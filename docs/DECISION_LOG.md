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
supersedes DL-3 and closes finding D-P0-3.

---

## Assumptions in force

Each of these is load-bearing, unverified or only partly verified, and would change the product if it
turned out to be false. Listing them is the point: an assumption that is written down can be attacked.

| # | Assumption | Status | What would falsify it |
|---|---|---|---|
| AS-1 | Peer confirmation is enough to make recognition trustworthy | **False, and no longer relied on.** Confirmation alone stops self-award and client-minted points, both proven by `tests/rules/firestore.test.ts`, and it never stopped a cooperating pair (finding D-P0-3). Since DL-6 the economy no longer rests on confirmation alone: a per-pair rolling allowance bounds it | Already falsified for the pair case, which is why the guard exists. It would be falsified again by a ring of manufactured accounts, which nothing in Rally defends against. The absolute claim in `README.md` should still be narrowed |
| AS-2 | Members will actually confirm the recognitions suggested to them | **Unverified.** Nothing in the app records the suggested-to-confirmed rate, though `docs/PRD.md` names it as a supporting metric | Measuring it. If the conversion is low, the north-star metric has no supply and the whole loop is decorative |
| AS-3 | Cohort scale is representative enough to defer scaling work | **Holds today, will not hold later.** The full ledger scan in `lib/leaderboard-admin.ts` line 45 is O(all events ever) and the 16ms measurement was taken at exactly the scale that hides it | Any deployment past a few hundred active members, or a long-lived cohort where the ledger keeps growing |
| AS-4 | The model layer improves on the regex baseline | **Never measured.** With no API key the model falls back to the baseline, so the CI comparison compares the baseline to itself | One eval run with a live key. Until then, no claim in either direction is supported |
| AS-5 | GitHub handle is a stable cross-app identity key | **Unverified and structurally untestable today.** A renamed GitHub handle silently splits a person's history, and with only one app on the bus nothing can detect it | A renamed handle, or a second app joining the bus |
| AS-6 | Rate limiting bounds model spend | **Weak.** `lib/rate-guard.ts` line 13 is in-memory per warm instance, so the real ceiling is limit times instance count | Any traffic pattern that spins up many instances |
| AS-7 | Recognition points will not be read as a performance signal by an adopting org | **Untested.** True in a cohort of peers; entirely unknown once a manager is in the workspace | The first organisation where someone screenshots the leaderboard into a review |
| AS-8 | The four screens are usable by keyboard and screen reader users | **No evidence either way.** Manual `aria-label` work exists; zero automated or assistive-technology verification (finding D-P1-4) | Running an accessibility check. Two specific defects are already provable from source: `components/onboarding.tsx` line 36 and `app/channels/page.tsx` line 454 |

---

## Decisions these reviews changed

One at review time, and one since. That is the honest count.

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
