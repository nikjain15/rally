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
