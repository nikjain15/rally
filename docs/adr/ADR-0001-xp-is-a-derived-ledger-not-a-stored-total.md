# ADR-0001: XP is summed from an append-only ledger, never a stored total

Date: 2026-08-02
Status: accepted, in force since the first version of the economy

**Written after the fact, and consolidating rather than inventing.** The reasoning below already
existed in the repo, split across the header comment in `lib/leaderboard-admin.ts`, decision-log
entries DL-2, DL-9 and DL-3/DL-6, and assumption AS-3. None of those is a single place a reader can
go to ask "what was the big call here, and what did it cost". This is that place. Every claim is
cited to the thing that already said it.

## The fork

Rally's entire product claim is that a peer-confirmed recognition is worth building a chat app
around. That makes one number, a member's XP, the thing the product's credibility rests on. There
are two ways to hold it:

1. **A stored total.** A `points` field per member, incremented inside each award transaction.
   O(1) to read.
2. **A derived reduction.** An append-only `xpEvents` ledger, with every total computed by query
   and reduce at read time. O(all events ever) to read.

Rally does the second.

## What was picked

`xpEvents` is append-only and server-written. `firestore.rules` allows `read: if signedIn()` and
denies `create, update, delete` outright, which is the rule that makes "clients can never write
points" a fact about the system rather than a claim in a README. Every total, rank and reputation
figure is summed from it.

The append-only shape is what lets the anti-gaming invariants be enforced at the point of award
rather than reconciled afterwards: ledger rows carry deterministic ids keyed to the recognition
(`xp_help_${recognitionId}`), so even a rules-bypassing re-run cannot create a second award for the
same recognition.

## What was rejected

**A materialised rollup**, and it was rejected repeatedly rather than once, most recently under
direct attack from a review finding (A-P0-1, answered in DL-2).

The argument, from `lib/leaderboard-admin.ts`: a rollup means a mutable per-member total written
from three separate places (`recognition-admin`, `commitment-admin`, `quest-admin`), each inside a
transaction already carrying an anti-gaming invariant. Done properly it also needs a reconciliation
check proving the rollup still equals the ledger, or it is a second source of truth that can
silently disagree with the first. **A rollup that disagrees with the ledger is a worse failure than
a slow query**, because the number it disagrees about is the one thing members are being asked to
trust.

**A cache** was rejected separately and for a different reason: on a serverless deployment it is
per warm instance, so it would improve the p95 while doing nothing for the cold call that is
actually slow, and it would put a staleness window on a screen whose whole appeal is that the
number is live.

## What it gives up

**Read cost that grows without bound.** `lib/leaderboard-admin.ts` reads the entire `xpEvents`
collection on every call, and `app/home/page.tsx` refetches on every XP change. This is O(all events
ever) and it will not hold at scale. That is not a hypothetical: AS-3 records it as an assumption
that "holds today, will not hold later".

What was bought back, under DL-9, is that the cost is now **bounded and testable** rather than
merely acknowledged: `LEADERBOARD_P95_BUDGET_MS` and `LEADERBOARD_BUDGET_LEDGER_EVENTS` give the
scan a stated ceiling, and `tests/integration/perf.test.ts` measures p95 against a seeded 20,000
event ledger rather than against today's few hundred.

The honest limit on that reassurance, which DL-9 states itself: the test runs against a seeded
emulator, so it catches an **algorithmic regression**, not a real-user percentile.

## What would change my mind

- **The budget test going red.** This is the concrete trigger, and it is the first version of AS-3
  that can actually fail. Before DL-9 the assumption could only be asserted; now it can be
  falsified by CI.
- **When it does, the ordering is fixed: reconciliation first, rollup second, never the reverse.**
  DL-2 commits to this. Shipping the rollup before the check that proves it equals the ledger would
  create exactly the silent second source of truth this decision exists to avoid, and it would do
  so at the moment the system is under the most load.
- **Not user-visible slowness on its own.** A slow leaderboard is the cost that was knowingly
  accepted. Reversing on discomfort rather than on the measured ceiling would mean the budget was
  theatre.

## Related

- `lib/leaderboard-admin.ts`, the scan and the full argument against the alternatives.
- `docs/DECISION_LOG.md` DL-2 (rollup defended, with the caveat), DL-9 (the p95 budget), AS-3 (the
  assumption that expires).
- `firestore.rules` §xpEvents, the rule that makes the guarantee real.
- ADR is separate from DL-3/DL-6, which govern the anti-gaming economy rather than how totals are
  stored.
