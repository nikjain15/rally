import type { Firestore } from 'firebase-admin/firestore';

/**
 * Leaderboard — computed server-side, neighbors-only by design.
 *
 * The kindness rule (memory be-kind-to-the-quiet, guardrail #5) forbids a full public ranking:
 * nobody should open Rally and see themselves at the bottom of a list of 65. So the FULL
 * ordering is computed here and never leaves the server — a caller gets only their own rank,
 * a ±2 window of neighbors, and the cooperative team total. That's motivating (you can always
 * see the rung above you) without being a public scoreboard of who's behind.
 *
 * XP is summed from the append-only ledger, never a stored total — same anti-gaming spine as
 * everywhere else.
 */

export type LeaderRow = { uid: string; total: number; rank: number };
export type LeaderboardResult = {
  me: LeaderRow | null;
  neighbors: LeaderRow[];
  /**
   * The top of the board — present ONLY when the caller opts in (see `includeTop`). This is the
   * one exception to "never return the full ordering", and a deliberately kind one: it celebrates
   * the LEADERS (being near the top is not a shame) and never enumerates who's at the bottom. The
   * full ranking still never leaves the server.
   */
  leaders?: LeaderRow[];
  teamTotal: number;
  teamGoal: { target: number; current: number };
  participants: number;
};

/**
 * The performance budget for `computeLeaderboard` (finding GEN1).
 *
 * `computeLeaderboard` reads the whole `xpEvents` collection on every call. DL-2 defended that and
 * AS-3 admits it is O(all events ever), but neither of them wrote down a number, so the admission
 * was unfalsifiable: there was nothing a run could violate. These two constants are that number,
 * and `tests/integration/perf.test.ts` enforces them.
 *
 * Why a budget rather than a rollup or a cache, stated plainly, because "we chose the easy one" is
 * the wrong reason and this is not it:
 *
 *  - A MATERIALISED ROLLUP means a mutable per-member total, written from `lib/recognition-admin.ts`,
 *    `lib/commitment-admin.ts` and `lib/quest-admin.ts`. Each of those writes inside a transaction
 *    that carries an anti-gaming invariant, and a stored total is exactly the thing Rally's design
 *    refuses to have ("XP is summed from the append-only ledger, never a stored total"). Done
 *    properly it also needs a reconciliation check proving the rollup still equals the ledger, or
 *    it is a second source of truth that can silently disagree with the first. That is a real piece
 *    of work with a real correctness surface, and doing it badly to close a finding would trade a
 *    measured slow path for an unmeasured wrong one.
 *  - A CACHE on a serverless deployment is per warm instance, so it would make the p95 look better
 *    while doing nothing for the cold call that is actually slow, and it would put a staleness
 *    window on a screen whose whole appeal is that the number is live.
 *
 * So: the scan stays, and it now has a stated ceiling that a test can fail. When the ledger passes
 * `LEADERBOARD_BUDGET_LEDGER_EVENTS`, the rollup is the correct next piece of work and the failing
 * test is what says so, on a date, rather than a paragraph nobody re-reads.
 */
export const LEADERBOARD_P95_BUDGET_MS = 1500;

/**
 * Measured 2026-08-02 on the Firestore emulator, 12 runs over a 20,000-event ledger:
 * **p95 677ms, about 34ms per 1,000 events.** So the budget has roughly 2.2x headroom today, and on
 * that slope it is reached somewhere near 44,000 events. Two things that reading cannot support: it
 * is an emulator on one machine, not production, and it is the algorithm's cost, not a real user's
 * latency (finding A-P1-6 is narrowed by this, not closed).
 */

/**
 * The ledger size the budget above is claimed to hold at. Above this, nothing has been measured and
 * no claim is being made. Set at roughly 20x the ledger a 65-person cohort accumulates in a year of
 * heavy use, so it is a genuine headroom statement rather than a restatement of today.
 */
export const LEADERBOARD_BUDGET_LEDGER_EVENTS = 20_000;

const NEIGHBOR_RADIUS = 2;

/** How many leaders the opt-in "full board" reveals. Small — a podium, not the whole ladder. */
const TOP_N = 5;

/** Per-team-member XP target; the cooperative goal scales with the cohort so it stays shared. */
const PER_MEMBER_GOAL = 50;

export async function computeLeaderboard(
  db: Firestore,
  uid: string,
  opts: { includeTop?: boolean } = {},
): Promise<LeaderboardResult> {
  const snap = await db.collection('xpEvents').get();
  const totals = new Map<string, number>();
  let teamTotal = 0;
  for (const d of snap.docs) {
    const x = d.data();
    const p = x.profileUid as string;
    const pts = (x.points as number) ?? 0;
    totals.set(p, (totals.get(p) ?? 0) + pts);
    teamTotal += pts;
  }

  // Rank by total desc; ties broken by uid for a stable, deterministic order.
  const ranked: LeaderRow[] = [...totals.entries()]
    .map(([u, total]) => ({ uid: u, total, rank: 0 }))
    .sort((a, b) => b.total - a.total || (a.uid < b.uid ? -1 : 1))
    .map((row, i) => ({ ...row, rank: i + 1 }));

  const meIdx = ranked.findIndex((r) => r.uid === uid);
  const me = meIdx >= 0 ? ranked[meIdx] : null;

  // A ±2 window around the caller. If the caller has no XP yet, show the bottom of the board
  // as an on-ramp rather than an empty panel.
  let neighbors: LeaderRow[];
  if (meIdx >= 0) {
    neighbors = ranked.slice(Math.max(0, meIdx - NEIGHBOR_RADIUS), meIdx + NEIGHBOR_RADIUS + 1);
  } else {
    neighbors = ranked.slice(Math.max(0, ranked.length - NEIGHBOR_RADIUS - 1));
  }

  const participants = ranked.length;
  const goalMembers = Math.max(participants, 1);

  return {
    me,
    neighbors,
    // Only the podium, and only when asked. Never the bottom of the board.
    ...(opts.includeTop ? { leaders: ranked.slice(0, TOP_N) } : {}),
    teamTotal,
    teamGoal: { target: goalMembers * PER_MEMBER_GOAL, current: teamTotal },
    participants,
  };
}
