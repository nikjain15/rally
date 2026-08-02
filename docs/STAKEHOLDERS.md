# Rally, stakeholder reviews

## Read this first: what this document is, and what it is not

**These reviews are simulated. Rally is built by one person, Nik Jain, working solo. Nobody else
reviewed this code.** What follows is Nik role-playing three senior reviewers against his own
repository: a product designer, a staff engineer, and a data and research lead. The findings are
real, in the sense that each one quotes a real file and line that anyone can check out and verify.
The reviewers are not real.

Specifically:

- **No lawyer, no privacy counsel, and no data protection officer has read any part of Rally.**
- **No security engineer has reviewed `firestore.rules`, the MCP surface, or the auth path.**
- **No accessibility specialist has audited the UI, and no assistive technology was used.**
- **No external party has signed off on anything. There are zero approvals of any kind.**
- The "Sign-offs" section below lists approvals that *would be needed*. All of them are unobtained.

A self-review is not a substitute for the real thing, and this document must never be read or cited
as evidence that outside review happened. What it is worth is narrower and still real: it forces the
uncomfortable questions to be written down with file references, and it separates what Rally has
verified from what Rally has only asserted.

Everything below was produced on 2026-08-02 against commit `8bca84e`, with `npm run typecheck`,
`npm run lint`, `npm run test:unit` and `npm run test:evals` green.

---

## Roles that would need to be involved

Rally today is a cohort pilot with no external users. This table is the honest map of who would have
to be in the room before it could be anything else.

| Role | What they need from Rally | The decision they own | What they block on |
|---|---|---|---|
| **Privacy / data protection counsel** | The shared context bus records a person's memory and cross-app history keyed by GitHub handle (`docs/SHARED-CONTEXT.md`, `lib/shared-context.ts`); the erasure path is `DELETE /api/assistant/memory` | Whether the data model, retention, and the erasure claim are lawful and sufficient for the jurisdictions of the users | A written retention policy (none exists), a record of what is stored where, and proof that erasure actually purges both the bus and app-local data |
| **Security engineer** | `firestore.rules` (268 lines), `lib/auth-server.ts`, the Admin SDK routes, the bearer-token model described for a hosted MCP surface | Whether the rules and the server-only write model hold under an adversary who is a legitimate member | The `xpEvents` / `recognitions` client-read exposure (A-P0-2 below) and a real rules review, not just the self-written rules test suite |
| **Accessibility specialist** | The four screens, keyboard traversal, screen reader output, WCAG AA contrast | Whether Rally can be used by a keyboard-only or screen reader user at all | There is no evidence either way today: some manual `aria-label` work exists, zero automated or assistive-technology verification (D-P1-4) |
| **People / culture owner at the adopting org** | The points schedule (`lib/recognition-admin.ts` lines 20 to 28), the leaderboard shape, the "lift never punish" stance | Whether a recognition score is acceptable in their culture at all, and whether it can ever be visible to a manager | A stated policy that recognition data is not used in performance review, and an answer to the reciprocal-farming vector (D-P0-3) |
| **Platform / cost owner** | The model cost cascade (`lib/detect-model.ts`), the meter in `lib/agent.ts`, the rate limit in `lib/rate-guard.ts` | The spend ceiling, and who gets paged when it is breached | The rate limit is per warm instance and in-memory (`lib/rate-guard.ts` line 13), so no real ceiling exists; and there is no alerting on the meter |
| **Whoever runs the second app (interop)** | The bus contract in `@cohort/core/shared-context` and Rally's adapter | Whether to adopt the contract, and who owns the shared Firebase project | Nothing on Rally's side; the contract is complete and untested across a real project boundary (A-P1-5) |
| **Engineering peer reviewer** | The whole repo | Whether the architecture decisions were the right ones | No ADRs exist, so every decision has to be reconstructed from prose (A-P1-3) |

### The single biggest misalignment risk

**Rally's headline promise is "recognition that can't be gamed", and the code does not deliver that
promise against a cooperating pair.** Every stakeholder above would arrive believing the guarantee is
absolute, because `README.md`, `docs/PRD.md` and `docs/ARCHITECTURE.md` all state it in absolute
terms. What the code actually guarantees is narrower and worth being precise about: a client cannot
*mint* points, and a person cannot award *themselves*. Those are both true and both proven by the
rules tests. What is not guaranteed is that two consenting members cannot pump each other, which
finding D-P0-3 below walks through with file references.

The risk is not the vulnerability. A cohort of 65 people who know each other is not where this gets
exploited. The risk is the gap between the absolute claim and the narrower guarantee, because that
gap is what a security reviewer, a culture owner, or a first external customer would find on day one,
after the claim had already been used to win their trust.

---

## Review A: product designer, design critique

**In character: senior product designer.** Attacking the flow, the states, the recognition confirm
loop, accessibility, and the social design.

**Not looked at:** the live deployment at rally-nikjain15.vercel.app. No browser session was run, no
page was rendered, no screen reader or keyboard was used. Every accessibility statement below comes
from reading source only, which is exactly why D-P1-4 is worded the way it is. Also not looked at:
the quests, profile and leaderboard screens in any depth, and the narrow and mobile layouts beyond
reading the two CSS breakpoints.

### D-P0-1 The failure state of the brief renders as a reassuring lie

`app/home/page.tsx` line 176 renders `brief?.quiet ?? "You're all caught up. Nothing needs you."`
when `brief` is null. `lib/data.ts` lines 572 to 581 return null on a non-ok response *and* on a
thrown fetch, catching everything. So a user whose brief request 503'd, timed out, or failed on an
expired token is told, in plain confident language, that nothing needs them. The same collapse
happens on the leaderboard (`lib/data.ts` line 558; `app/home/page.tsx` line 113 renders a dash).

Of the four states a user can be in on this card, only two are distinguishable. Loading and error
both render as empty, and empty carries a factual claim about the user's world.

**Fix:** make the fetchers return a discriminated result (`{status: 'loading' | 'error' | 'ok'}`) in
`lib/data.ts`, and render a distinct line in `app/home/page.tsx` for the error case. Open.

### D-P0-2 The most important tap in the product has no state machine

`app/home/page.tsx` lines 155 and 156 call `confirmRecognition(r.id)` and `declineRecognition(r.id)`
from an onClick with no await, no in-flight disable, no optimistic update, and no error surface.
`lib/data.ts` line 449 already returns a boolean that says whether the server accepted it; the caller
discards it.

On success the card vanishes only when the Firestore snapshot arrives, so there is a visible dead
window with no feedback. On failure, and 401-after-token-expiry and 503-no-admin-credential are both
reachable, absolutely nothing happens: the card sits there, the user taps again. The server is
idempotent (`lib/recognition-admin.ts` line 88), so no double award results, which is good design
paying off. But the user cannot tell a slow success from a silent failure.

**Fix:** await the promise in `app/home/page.tsx`, disable the pair of buttons while in flight, and
render the failure from the boolean `lib/data.ts` already returns. Open.

### D-P0-3 A cooperating pair can farm the ledger, and the guard only blocks the narrow case

This is the social-design attack, and it lands.

`app/api/detect/route.ts` treats the verified message **author as the helped party** and any handle
they credit as the helper. `lib/recognition-admin.ts` lines 84 and 85 then permit exactly the person
who wrote the message to confirm it, blocking only `helperUid === actingUid`.

So: I post "thanks @bob". Bob becomes the helper, I become the helped, and I am the one authorized to
confirm. I confirm. Bob receives 12 points and I receive `CONFIRM_THANKS = 2` for confirming
(`lib/recognition-admin.ts` lines 20 to 28). Bob posts "thanks @nik" and we repeat in the other
direction. `suggestRecognition` dedupes on (helper, helped, sourceMsgRef) at line 46, so a fresh
message is a fresh award every time. The only ceiling anywhere is the 30-per-minute per-user rate
limit at `app/api/detect/route.ts` line 24, which is a flood guard, not an economy guard, and is
per warm instance anyway.

Note precisely what still holds: no client wrote a point, nobody awarded themselves, and every rules
test stays green. The append-only ledger is intact. The *economy* on top of it is not.

**Fix:** a per-pair cap per rolling window, enforced inside `lib/recognition-admin.ts` where the
transaction already runs, plus reciprocity damping in `lib/leaderboard-admin.ts` so mutual pairs
contribute sublinearly. Neither exists. Open, and deliberately not fixed in this pass, because it is
a product economics decision, not a bug fix.

### D-P1-4 Accessibility: partial manual labelling, zero verification, honest verdict is "unknown"

Reporting this honestly as asked, because the answer is genuinely "no evidence either way", and that
is worth stating rather than guessing.

What exists: `aria-label` appears in seven files (13 instances in `app/channels/page.tsx`, 3 in
`components/rally-nav.tsx`, 2 each in `app/page.tsx` and `components/rally-agent.tsx`, 1 each in
`app/leaderboard/page.tsx`, `app/profile/page.tsx`, `components/onboarding.tsx`). `aria-pressed` is
used correctly on the three toggles. The mention autocomplete has `role="listbox"` /
`role="option"` / `aria-selected` at `app/channels/page.tsx` lines 454 to 459.

What does not exist: any automated check. There is no `axe`, no `jest-axe`, no
`@axe-core/playwright` in `package.json`, and no accessibility assertion in any of the six files in
`tests/e2e/`. The word "accessibility" does not appear in the repo.

Two specific gaps that reading alone can prove, without needing a browser:

- `components/onboarding.tsx` line 36 declares `role="dialog"` and `aria-modal="true"` but the
  component has no focus trap, no initial focus move, and no Escape handler. `aria-modal` tells a
  screen reader the rest of the page is inert, which is a promise the code does not keep.
- The mention listbox at `app/channels/page.tsx` line 454 is never associated with the textarea at
  line 476: no `aria-controls`, no `aria-expanded`, no `aria-activedescendant`. Arrow keys move a
  visual highlight (line 440) that a screen reader user is never told about.

**Fix:** add `@axe-core/playwright` to the existing e2e lane and assert zero violations on the four
screens, then fix what it finds. Until that runs, Rally should claim nothing about accessibility.
Open.

### D-P1-5 Focus ring fails the contrast it exists to provide

`app/globals.css` line 313 sets `outline: none` on `.rl-btn`, `.rl-navlink` and `.rl-compose`, and
replaces it with `box-shadow: 0 0 0 4px rgb(99 91 255 / 0.12)`. A 12 percent alpha blurple over a
white card computes to roughly 1.2:1 against its background, well under the 3:1 that WCAG 2.2 SC
1.4.11 and 2.4.11 require of a focus indicator. It is a design that removed the browser's compliant
default and replaced it with something prettier and weaker. Links elsewhere keep the user agent
outline, so the regression is scoped to buttons, nav items, and the composer, which is to say every
primary action including "Yes, that helped".

**Fix:** raise the alpha to at least 0.5 or use a solid two-layer ring in `app/globals.css`. Open.

### D-P1-6 Real content is rendered below AA contrast

`--slate-400` is `#8898aa`, which is about 2.9:1 on both `--paper` (`#ffffff`) and `--bg`
(`#f6f9fc`), under the 4.5:1 AA needs for normal-size text. It is not used decoratively. It carries
content: section subtitles (`app/globals.css` line 207), message timestamps (line 306), the user's
own handle in the nav (line 195), nav section headers (line 183), and the "edited" marker (line 248).
`--slate-500` (`#697386`, about 4.8:1) already exists and passes.

**Fix:** move those five rules to `--slate-500` in `app/globals.css`, or darken `--slate-400` itself.
Open.

### D-P1-7 A decorative checkbox sits on the card that asks the user to act

`app/globals.css` line 226 defines `.rl-chk` as an 18px rounded square with a 2px border, which reads
as exactly one thing: an unchecked checkbox. It is used as a bare `<span>` next to every brief item
(`app/home/page.tsx` line 169) and every open quest (line 229). It is not focusable, has no role, and
clicking it does nothing.

The strongest affordance on the card titled "what needs you" promises an interaction that does not
exist. Either make it real or make it stop looking like a control.

**Fix:** in `app/globals.css`, restyle `.rl-chk` as a dot or bullet, or make it a real button in
`app/home/page.tsx`. Open.

### D-P1-8 When nobody confirms, nothing happens, and nobody is told

Asked directly: what does the flow do when a suggestion is never confirmed? Answer: nothing, forever.

A suggested recognition has no expiry, no reminder, and no aging anywhere in
`lib/recognition-admin.ts`. It surfaces only to the helped peer, via
`subscribeMyPendingRecognitions` and the brief. The **helper is never told a recognition for them
exists**, so the person whose contribution is stuck learns nothing and can chase nothing. Decline is
silent by design (`lib/recognition-admin.ts` line 123), which is a kind choice and the right one, but
it means the two failure modes, declined and ignored, are indistinguishable from every angle.

This matters more than it looks, because it is the denominator of the north-star metric. `docs/PRD.md`
line 87 names "suggested to confirmed conversion rate; median time-to-confirm" as a supporting
metric, and nothing in the app records or exposes either one.

**Fix:** age the suggestion in `lib/brief.ts` so a stale pending confirm rises, and record the
suggested-to-confirmed transition so the funnel is measurable. Open.

### D-P2-9 The kindness guarantee is a convention, not a boundary

`lib/leaderboard-admin.ts` lines 5 to 12 explain, correctly and thoughtfully, that the full ordering
is computed server-side and never leaves the server, so nobody opens Rally and sees themselves at the
bottom of a list of 65. But `firestore.rules` line 192 permits any signed-in client to read the whole
`xpEvents` collection, and line 183 the whole `recognitions` collection. Any member can rank all 65
people from the browser console in about four lines, and can see who declined whose recognition.

The design intent is genuinely good. It is enforced one layer above where it needs to be. See A-P0-2
for the engineering side of the same finding.

**Fix:** `firestore.rules`, with the cost noted in A-P0-2. Open.

---

## Review B: staff engineer, architecture review

**In character: staff engineer.** Attacking the boundaries, the scaling shape, and the gap between
what the docs say ships and what ships.

**Not looked at:** the vendored Conduit tree (`lib/conduit/`, roughly 15 files) beyond its seam into
`lib/agent.ts`; the GitHub webhook HMAC path; `firestore.rules` line by line, only the `xpEvents`,
`recognitions` and `profiles` blocks; the e2e and integration suites, which were not run here (they
need the emulator); and CI configuration beyond confirming no `vercel.json` exists.

### A-P0-1 The leaderboard rescans the entire ledger on every call, and the perf number cannot see it

`lib/leaderboard-admin.ts` line 45 is `db.collection('xpEvents').get()`. Every leaderboard request
reads every document in the ledger, then sums and ranks in memory. There is no cache, no aggregation
query, no rollup, and no pagination.

Now look at who calls it. `app/home/page.tsx` lines 77 to 85 refetch the leaderboard in an effect
keyed on `[user, xp, pending.length]`, so **every XP change any user sees triggers a full ledger scan
for that user**, and the ledger grows by two documents per confirmed recognition forever
(`lib/recognition-admin.ts` lines 96 and 103). It is O(all events ever) per request, in latency and
in billed Firestore document reads, with a request rate that rises with activity.

The 16ms leaderboard figure quoted in `README.md` line 152 was measured against a seeded 65-user,
2,100-message emulator. That is precisely the scale at which an O(n) scan looks free. The number is
honest and the conclusion drawn from it is not load-bearing evidence of anything at growth.

**Fix:** maintain a per-user total in a rollup document written inside the transaction that already
appends to the ledger (`lib/recognition-admin.ts` line 96), keep the full scan as a reconciliation
job, and derive rank from the rollups. Open.

### A-P0-2 The privacy and kindness guarantees are enforced in the API layer while the rules expose the raw data

`firestore.rules` line 192: `xpEvents` is `allow read: if signedIn()`. Line 183: `recognitions` is
`allow read: if signedIn()`. Both are collection-level, so a signed-in client can *list* them.

The server-side care taken in `lib/leaderboard-admin.ts` to never return the full ordering, and the
neighbors-only window, are therefore decorative against anyone willing to open a console. So is the
privacy of a declined recognition.

The honest complication, and the reason this is not a one-line fix: `lib/data.ts` line 414
(`subscribeXpTotal`) queries `xpEvents` directly from the client to drive the realtime XP counter on
Home. Locking the rule down to owner-only reads keeps that working; locking it down to no client
reads breaks it and forces the counter through an API route, losing the realtime snapshot. That
tradeoff has never been written down, which is itself finding A-P1-3.

**Fix:** in `firestore.rules`, scope `xpEvents` reads to `resource.data.profileUid == request.auth.uid`
and `recognitions` reads to the helper or helped party, then extend `tests/rules/firestore.test.ts` to
assert a third party is denied. Open.

### A-P1-3 There are no ADRs anywhere, and the decisions that most need them are the ones already made

Verified: `docs/` holds seven markdown files and none is a decision record; there is no `adr/`
directory and no file matching adr or decision anywhere outside `node_modules`.

The decisions that are now expensive to reverse and are recorded only as scattered prose:

- Firestore `onSnapshot` as the realtime bus instead of a socket layer (`docs/ARCHITECTURE.md` line 3).
- Server-only confirm as one transaction, adopted after an earlier client-flip version produced
  "confirmed-but-unawarded" states (`docs/PRD.md` lines 96 to 99). That is a genuine reversal with a
  genuine cause and it exists as one sentence inside a tradeoffs list.
- Vendoring Conduit rather than depending on it (`lib/conduit/VENDOR.md`).
- Ledger over counters, with rank computed rather than stored.

**Fix:** `docs/adr/0001-*.md` onward, one page each, starting with those four. `docs/DECISION_LOG.md`,
created alongside this review, is an index and a record of what these reviews moved. It is explicitly
not a substitute for per-decision ADRs. Open.

### A-P1-4 The hosted MCP transport is documented in two places that disagreed

`docs/MCP.md` line 64 onward is exemplary: it says "Status: not shipped", states there is no `/sse` or
`/messages` route in `app/`, and lists the three things that would make it real. Verified accurate:
`lib/mcp/` contains only `rally-server.ts`, `rally-tools.ts` and `stdio-entry.ts`, and no route under
`app/api/` mentions SSE.

But `docs/ARCHITECTURE.md` line 233 asserted, in the present tense, that a hosted deployment fronts
the SSE transport with a shared bearer token. That is the document a reader opens first, and it
contradicted the honest one.

**Fixed in this pass** (the only change made to the repo besides these two new documents):
`docs/ARCHITECTURE.md` now states that stdio is the only transport that ships and points at
`docs/MCP.md`. No code changed.

### A-P1-5 The cross-app bus has never run with a second app, and the fallback hides exactly the failures that matter

`docs/SHARED-CONTEXT.md` lines 100 to 106 are honest: Pulse is not integrated and the bus falls back
to Rally's own database. Credit for stating that plainly.

The part the honesty does not yet cover is what the fallback *costs as test coverage*. Because there
is no second project, every test that touches the bus exercises the single-database path. The two
properties that only fail across a real boundary have therefore never been exercised even once:

1. **Identity.** `contextKey(handle)` lower-cases the GitHub login. A renamed GitHub handle silently
   splits one person's history into two keys, and no app can detect it because the uid mapping is
   per-app by design. This is the failure mode of the entire keying decision and it is unreachable
   in a one-app test.
2. **Concurrency.** The transactional claim in `claimTasks` exists precisely so a task is never
   worked twice. It has never had a second concurrent claimer. Its one purpose is untested.

**Fix:** an integration test in `tests/integration/` that stands up two Admin app instances against
one emulator project, playing `fromApp` and `toApp`, and races two claimers. That tests the
concurrency property today, without waiting on Pulse. Open.

### A-P1-6 No p95 latency budget exists, and nothing could enforce one

Grepping `lib`, `app`, `docs` and `tests` for p95, SLO, or latency budget returns nothing at all.

`tests/integration/perf.test.ts` asserts cohort-scale timings, which is real work, but they are
absolute assertions against a seeded emulator on whatever machine runs CI, not a percentile against
real traffic. No API route emits a duration. The only meter that exists, `recordUsage` in
`lib/agent.ts` line 88, records model tokens and estimated cost into an in-process ring buffer capped
at 500 entries (line 85), which is per warm instance and disappears on cold start.

So the answer to "is Rally slow for the 95th-percentile user" is not "no", it is "unanswerable".

**Fix:** name a per-route budget in `docs/`, emit a duration line per API route next to the existing
`[usage]` line, and turn `tests/integration/perf.test.ts` into a budget check. Open.

### A-P1-7 Credit to the retry ladder, and the four things it does not cover

Crediting the work first, because it is good and it is recent. `lib/retry.ts` gives each call site a
named budget (lines 84 to 109), never retries a permanent failure, caps an absurd `Retry-After`,
bounds total elapsed time even when every attempt hangs, and `lib/agent.ts` line 221 constructs the
Anthropic client with `maxRetries: 0` so the two ladders cannot multiply into nine provider calls.
The reasoning for that last one is written down at the call site. `tests/unit/retry.test.ts` asserts
the three load-bearing properties. This is a real resilience layer, not a `catch` and a `setTimeout`.

What it does not cover:

1. **There is no turn-level deadline, only a per-call one.** The assistant loop runs up to
   `MAX_AGENT_STEPS = 6` (`lib/assistant-agent.ts` line 26), each step carrying the `agentStep`
   profile with `totalBudgetMs: 20_000` (`lib/retry.ts` line 96). One assistant turn can legitimately
   spend about 120 seconds inside its own budget. There is no `maxDuration` export on
   `app/api/assistant/route.ts` and no `vercel.json` in the repo, so the platform kills the function
   first and the user gets a platform error, not the safe fallback reply the design promises. The
   same shape applies to `POST /api/detect`, which uses the `background` profile with a 45 second
   budget inside a request-scoped function.
2. **No circuit breaker.** During a provider outage every caller pays the full ladder independently.
   Detection allows 30 calls per user per minute; across 65 members a sustained 529 becomes a
   stampede of retries each budgeted 45 seconds. Retry without a breaker converts one outage into
   sustained load.
3. **It covers the model call only.** The Firestore admin calls, including the full ledger scan of
   A-P0-1 and the confirm transaction, the GitHub adapter in `lib/pm-adapter.ts`, and the gateway
   reporter all sit outside it.
4. **It cannot distinguish a retry that is safe from one that is not**, because today every caller
   happens to be idempotent. That is true by luck of the current call sites, not by contract, and
   nothing in `lib/retry.ts` states the requirement.

**Fix:** thread a per-request deadline through `lib/assistant-run.ts`, add an explicit
`export const maxDuration` to the model-backed routes, and state the idempotency requirement in
`lib/retry.ts`. Open.

### A-P2-8 The rate limit is not a limit

`lib/rate-guard.ts` line 13 keeps state in a module-level `Map`. Its own comment says so plainly and
names the fix. Recording it anyway because the cost cascade's spend story leans on it: on Vercel the
real ceiling is limit times warm instances, which is unknown and elastic. It converts "unlimited from
one account" into "bounded", which is worth something, but it is not the spend cap it is treated as.

**Fix:** the Firestore counter already named in `lib/rate-guard.ts`. Open.

### A-P2-9 The test-count claims in the README have drifted

`README.md` line 14 carries a "tests 137 passing" badge, line 143 says "unit (130)", and line 157
explains the badge as 130 unit plus 7 evals. The actual run on this commit is 160 unit plus 7 evals.
This is an underclaim rather than an overclaim, so it is a P2, but a stale number in the first screen
of the README is drift that erodes the credibility of the numbers next to it.

**Fix:** `README.md` lines 14, 143, 157. Open, deliberately not touched here.

---

## Review C: data and research lead, eval review

**In character: data and research lead.** Attacking whether the numbers mean what they are used to
mean.

All metrics below are from one local run of `npm run test:evals` on this commit with no
`ANTHROPIC_API_KEY` present:

```
[eval] baseline  precision=0.825 recall=0.917 f1=0.868 fpRate=0.140 (tp=33 fp=7 fn=3, n=50)
[eval] smart     precision=0.825 recall=0.917 f1=0.868 fpRate=0.140 (tp=33 fp=7 fn=3, n=50)
```

Set composition, counted directly from `tests/evals/data/recognition.labeled.jsonl`: 50 cases, 33
positive and 17 negative, 36 gold (helper, kind) pairs.

**Not looked at:** the rules tests, which `docs/EVALS.md` line 19 calls Rally's most important evals
and which were not re-audited here; the integration perf pass; and the 50 labelled cases one by one,
so no claim is made about label correctness. Metrics come from a single run with no API key, so
nothing here says anything about the model layer's actual behaviour.

### E-P0-1 The set's class balance is inverted relative to the stream the detector runs on

66 percent of the cases are positives. The detector runs on **every posted message**
(`app/channels/page.tsx` line 431 calls `runDetection` after every send), where messages expressing
gratitude with a mention are a small minority of traffic.

Precision is the metric most sensitive to base rate, and it is the headline number. Seven false
positives across 17 negative cases is roughly 0.4 false positives per negative message. Hold that
rate and move to a stream that is 5 percent gratitude: precision falls from 0.83 to roughly 0.1.
Even assuming the labelled negatives are ten times harder than average, so a real per-negative rate
of 0.04, precision lands near 0.5. Either way the reported 0.83 is a property of the sample, not a
prediction about production.

This is not an argument that the detector is bad. The suggestion is peer-confirmed, so a false
positive costs a declined card, which is the containment argument `docs/EVALS.md` line 14 makes
correctly. It is an argument that **0.83 precision should not be quoted without the base rate it was
measured at**, and `README.md` line 98 quotes it as a result.

**Fix:** report precision conditioned on a stated base rate, or resample once pilot messages are
labelled, which `docs/EVALS.md` line 94 already names as the next step. Open.

### E-P0-2 Fifty cases cannot resolve the difference the contract asserts

`tests/evals/detection.test.ts` lines 79 to 83 assert that the model layer is never worse than the
baseline on F1 and adds no false positives.

With 36 gold pairs and 40 predictions, one case flipping moves F1 by roughly 1.5 points and the
false-positive rate by 2 points. A Wilson interval on recall 0.917 at n=36 runs roughly 0.78 to 0.97;
on precision 0.825 at n=40, roughly 0.68 to 0.92. So any real model-versus-baseline difference
smaller than about 10 F1 points is indistinguishable from noise on this set.

The assertion as written is `smart.f1 >= baseline.f1 - 1e-9`, which is a strict inequality with an
epsilon that only absorbs floating-point error. On a set this size that has two consequences: a
single unlucky case will fail CI and read as a regression, and a genuine one-case improvement can
never be certified as one. The test is simultaneously too sensitive and unable to measure.

What a real regression looks like at this size, stated so it can be pre-committed: a drop of 3 or
more gold pairs, sustained across two runs, on a set where the labels did not change. Anything
smaller is one relabelled case.

**Fix:** either grow the set to a few hundred labelled cases, or replace the point comparison with a
bootstrap confidence bound in `lib/eval-detect.ts` and state the resolvable effect size in
`docs/EVALS.md`. Open.

### E-P1-3 The contract test is vacuous in CI, and only the prose says so

With no API key, `detectRecognitionsSmart` falls back to `detectRecognitions`, so
`tests/evals/detection.test.ts` line 79 compares a function to itself. The run above proves it: the
two log lines are byte-identical.

`README.md` lines 102 to 104 and `docs/EVALS.md` lines 71 to 75 both disclose this clearly and in
strong language, which is the right call and is genuinely rare. The remaining gap is that **the
disclosure lives only in prose while the test reports green**. A reader of CI output sees "7 passed"
and a passing contract assertion. Nothing in the machine-readable signal distinguishes "verified"
from "not measured".

**Fix:** branch on `hasModel()` in `tests/evals/detection.test.ts` and skip the contract case with an
explanatory message when no key is present, so CI shows it as skipped rather than passed. Open.

### E-P1-4 The false-positive rate is per message, which makes it incomparable

`lib/eval-detect.ts` line 27 defines `falsePositiveRate` as FP over all messages. At 0.140 that is
7/50. Because the denominator includes positives, the number moves whenever the positive-to-negative
mix moves, so it cannot be compared across two differently composed sets, cannot be compared to any
published FPR, and will shift on its own the moment real pilot messages are folded in per E-P0-1.

The definition is documented at the line, so this is a clarity problem rather than a hidden one. But
`docs/EVALS.md` line 119 calls it "the error Rally cares most about", and the number chosen to carry
that weight should be the one that is stable: false positives per negative case, which is 7/17 = 0.41
here.

**Fix:** report both in `lib/eval-detect.ts` and name them distinctly in `docs/EVALS.md`. Open.

### E-P1-5 Scoring on (handle, kind) hides the error the product says it cares about most

`lib/eval-detect.ts` lines 34 to 36 key a match on `helperHandle::kind`, so crediting the right
person with the wrong verb scores as one false positive plus one false negative, exactly the same as
crediting the wrong person entirely.

The product consequences are not remotely equal. Wrong kind changes the points from 8 to 12
(`lib/recognition-admin.ts` lines 20 to 25) on a card a human still has to confirm. Wrong person is
the trust-eroding error that `docs/EVALS.md` line 118 singles out. Because both are folded into one
number, the headline metrics cannot tell you how often the thing Rally actually fears happens, and
nothing else reports it either.

**Fix:** add a second, handle-only scoring pass in `lib/eval-detect.ts` and report wrong-person
count on its own. Open.

### E-P1-6 There is no LLM judge, and the gap is narrower but sharper than the roadmap implies

`docs/EVALS.md` lines 96 to 100 list brief quality and assistant faithfulness as roadmap. Verified:
no judge harness exists anywhere in the repo.

Splitting the gap honestly, because the roadmap entry overstates one half and understates the other:

- **The brief does not need a judge.** `docs/EVALS.md` line 15 argues it is fully deterministic and
  calls no model, so it cannot invent urgency. That argument is correct and is checkable from
  `lib/brief.ts`. A judge here would be measuring a property that is true by construction.
- **The assistant needs one badly.** It is the single surface that generates free text a user reads
  and acts on. `tests/unit/assistant.test.ts` covers routing and proposal-shape validation, which is
  structure, not content. There is no measurement of any kind on whether a reply is faithful to what
  the tools returned, or whether it claims to have done something it only drafted. That second
  failure mode is named in `docs/EVALS.md` line 100 and is exactly the one the confirm-before-act
  guardrail cannot catch, because the guardrail governs the action and not the sentence describing it.

**Fix:** a small rubric-scored judge over a fixed set of assistant transcripts, or an explicit,
written decision not to build one and to accept the exposure. Either is honest; the current state,
listed as roadmap with no date, is neither. Open.

### E-P2-7 Nothing distinguishes drift from noise over time

`tests/evals/detection.test.ts` lines 72 to 74 assert floors of precision 0.7, recall 0.8, F1 0.75,
sitting roughly 10 points below current performance. That catches a catastrophe and nothing else. No
run's metrics are recorded anywhere, so a slow decline across a year of prompt and grammar edits is
invisible until it crosses a floor set far below where the system has ever operated.

**Fix:** append each run's metrics to a committed results file and diff against the previous
committed run, so the series exists. Open.

---

## Sign-offs

**None. Zero approvals have been obtained, from anyone, for anything.** Nik Jain is the only person
who has read this code.

Rally has been piloted with the 65-person cohort. It has no external users. Before a team outside the
cohort could use it, these approvals would be required, and the honest status of each is the same:

| Approval | Who would give it | Status | What has to happen first |
|---|---|---|---|
| Privacy and data-handling review | Data protection counsel | **Not obtained. Not sought.** | Write a data inventory and retention policy; prove the erasure path actually purges both the bus and app-local data |
| Security review of the trust boundary | Security engineer | **Not obtained. Not sought.** | Resolve A-P0-2, then have someone other than the author read `firestore.rules` and try to break it |
| Accessibility conformance (WCAG 2.2 AA) | Accessibility specialist | **Not obtained. Not sought.** | Resolve D-P1-5, D-P1-6, D-P1-7; get automated coverage in place per D-P1-4; then a manual assistive-technology pass |
| Recognition-data policy | The adopting org's people or culture owner | **Not obtained. Not sought.** | Resolve D-P0-3; write down whether recognition data may ever inform performance perception |
| Cost and operational ownership | Whoever pays the model bill | **Not obtained. Not sought.** | A real shared rate limit per A-P2-8 and an alert on the meter |
| Third-party terms and licensing | Legal | **Not obtained. Not sought.** | Confirm the vendored Conduit tree and the Anthropic and GitHub terms permit the intended deployment |

**The plan.** Not a schedule, because a solo builder committing dates for other people's reviews would
be its own false claim. The ordering, and the trigger for each:

1. Fix what a self-review can legitimately fix: D-P0-1, D-P0-2, D-P1-5, D-P1-6, D-P1-7, A-P0-2. These
   need no outside party and remove the findings most likely to embarrass a real reviewer.
2. Decide D-P0-3 as a product question, because it changes the economy and not just the code.
3. Get automated accessibility coverage running (D-P1-4), so the eventual specialist starts from
   findings rather than from zero.
4. Only then approach a real reviewer, and only for the two that genuinely cannot be self-served:
   security and privacy. Approaching them before step 1 wastes the one review a solo project is
   likely to get.
5. Until step 4 completes, Rally's documentation must keep saying, in these words, that no external
   review has occurred.

---

## Pushback

What the three reviews moved, what they did not, and where Nik would argue back.

### What changed as a result

| Finding | Rank | What changed |
|---|---|---|
| A-P1-4 | P1 | `docs/ARCHITECTURE.md` line 233 no longer claims a hosted SSE transport exists. It now states stdio is the only shipped transport and points at `docs/MCP.md`. This was the only substantive edit; no code changed. |
| All others | P0 to P2 | Nothing. Recorded open, each named with the file that would fix it. |

That ratio is deliberate and is the point of the exercise. Twenty-five findings, one change. A review
pass that "fixed" twenty-four findings in an afternoon would mean either the findings were trivial or
the fixes were invented, and inventing fixes is the failure mode this audit exists to remove.

### Findings by rank (25 total)

**P0 (7):** D-P0-1 brief failure state reads as reassurance; D-P0-2 confirm loop has no state
machine; D-P0-3 a cooperating pair can farm the ledger; A-P0-1 leaderboard rescans the full ledger
per call; A-P0-2 privacy and kindness guarantees enforced above the layer that exposes the data;
E-P0-1 eval class balance inverted relative to the stream; E-P0-2 fifty cases cannot resolve the
asserted difference.

**P1 (14):** D-P1-4 no accessibility evidence; D-P1-5 focus ring below contrast; D-P1-6 content
below AA contrast; D-P1-7 decorative checkbox; D-P1-8 no path when nobody confirms; A-P1-3 no ADRs;
A-P1-4 MCP transport doc contradiction; A-P1-5 bus never run with a second app; A-P1-6 no p95 budget;
A-P1-7 retry gaps; E-P1-3 vacuous contract test reports green; E-P1-4 FP rate incomparable; E-P1-5
scoring hides wrong-person error; E-P1-6 no judge for the assistant.

**P2 (four):** D-P2-9 kindness guarantee is a convention; A-P2-8 rate limit is not a limit; A-P2-9
README test counts drifted; E-P2-7 no drift-versus-noise protocol.

### Where Nik would defend the design

Recording the counterarguments, because a review where the author agrees with everything is a review
that was not adversarial.

- **On D-P0-3, the farming vector.** The defence is not "it is not exploitable", because it is. The
  defence is that the fix is not obviously good. A per-pair cap punishes the two people who genuinely
  do pair most often, which is precisely the behaviour Rally exists to reward, and reciprocity damping
  makes rank harder to explain, which erodes the trust the ledger was built to earn. The vulnerability
  is real; the cure may be worse than the disease at cohort scale. What is not defensible is the
  absolute phrasing of the claim in the README, and that should change regardless of whether the code
  does.
- **On A-P0-1, the ledger scan.** At 65 users, correct and simple beats fast and derived, and a rollup
  introduces a second source of truth for the number the entire product's credibility rests on. The
  scan cannot drift. A rollup can. Nik would ship the reconciliation job before the rollup, not after.
- **On E-P0-1 and E-P0-2, the eval set.** A 50-case hand-written set was the right first artifact,
  because it makes the designed failure bands auditable at a glance and turns any regression in one of
  them red. The mistake is not building it; it is quoting 0.83 precision as a result in the README
  without the base rate attached. The set should stay, the framing should change.
- **On D-P1-4 and accessibility.** Rally is a cohort pilot, and a solo builder cannot credibly claim
  WCAG conformance no matter how much aria they write. The right move is not to fix accessibility
  quietly and claim conformance; it is to get automated coverage in and then state exactly what is
  and is not verified. That is the same principle as everything else here.
