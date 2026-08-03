/**
 * The kill line. R1.
 *
 * ## What this closes
 *
 * `docs/DECISION_LOG.md` §Kill criteria used to say Rally had none, and gave the
 * reason it could not simply write one:
 *
 *   "Right now Rally cannot fail this test, because it cannot take it. Nothing in
 *    the app records the suggested-to-confirmed transition or the time to confirm.
 *    The instrumentation is a prerequisite for the criterion, not a follow-up."
 *
 * That was exactly right, and the missing piece was one field. `confirmRecognition`
 * flipped `status` in place and wrote no timestamp, so the transition left no trace
 * in time. `confirmedAt` now exists, and this module is the criterion it unblocks.
 *
 * ## Why a cohort and not a ratio
 *
 * The tempting measurement is "confirmed / total, right now". It is the wrong one.
 * A snapshot ratio pools suggestions from every week together, so it is dragged
 * down by suggestions made yesterday that nobody has had time to confirm, and it
 * moves when posting volume changes even if behaviour does not. A product getting
 * busier would look like a product getting worse.
 *
 * So this measures a COHORT: of the suggestions CREATED in a window, what share
 * were ever confirmed. That question has a stable answer that does not drift with
 * volume, and it is the question the kill line is actually about.
 *
 * ## The line, pre-committed
 *
 *   Kill or pivot if fewer than 30% of suggestions created in a 4-week window are
 *   ever confirmed, over at least 100 suggestions.
 *
 *   Consequence: the recognition loop is not the product. Stop building on the
 *   confirm step and either drop the economy to a plain feed, or pivot to whatever
 *   people did use.
 *
 * The window and the sample come from the decision log's own requirements: a rate
 * over one week in a 65-person cohort has an interval wide enough to contain almost
 * any hypothesis, so the window is four weeks and the sample floor is 100.
 *
 * The line sits on the CONFIRM step deliberately. `docs/PRD.md` names confirmed
 * recognitions per active member per week as the north star, but that number moves
 * with posting volume as well as with confirm behaviour. The confirm rate isolates
 * the step that tests whether people actually want this, as opposed to whether the
 * detector works, which `tests/evals/detection.test.ts` already measures separately.
 *
 * Pure: no Firestore, no network, no clock of its own.
 */

/** Days of suggestion history the kill line is evaluated over. */
export const KILL_WINDOW_DAYS = 28;

/** Confirm rate below which the recognition loop is judged not to work. */
export const KILL_CONFIRM_RATE = 0.3;

/** Suggestions required in the cohort before the rate is readable. */
export const KILL_MIN_SUGGESTIONS = 100;

/**
 * A suggestion, as the funnel sees it. Timestamps are epoch ms so the module
 * stays free of Firestore types and is trivially testable.
 */
export type SuggestionRecord = {
  id: string;
  createdAtMs: number;
  /** When the helped peer confirmed, or null if they never did. */
  confirmedAtMs: number | null;
};

export type KillStatus = "not_enough_data" | "holding" | "crossed";

export type FunnelStats = {
  /** Suggestions created inside the window. */
  suggested: number;
  /** How many of those were ever confirmed. */
  confirmed: number;
  /** confirmed / suggested, or null when the cohort is empty. */
  confirmRate: number | null;
  /** Median hours from suggestion to confirm, over confirmed ones only. */
  medianHoursToConfirm: number | null;
};

export type KillVerdict = {
  status: KillStatus;
  reason: string;
  stats: FunnelStats;
  action: string;
};

/**
 * The suggestions created inside the window ending at `nowMs`.
 *
 * Cohort membership is decided by CREATION time only. A suggestion made inside
 * the window counts even if it was confirmed after the window closed, which is
 * the point: the question is whether a suggestion ever gets confirmed, not
 * whether it got confirmed quickly.
 */
export function cohort(
  records: readonly SuggestionRecord[],
  nowMs: number,
  windowDays = KILL_WINDOW_DAYS,
): SuggestionRecord[] {
  const start = nowMs - windowDays * 86_400_000;
  return records.filter((r) => r.createdAtMs >= start && r.createdAtMs <= nowMs);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Funnel stats for a cohort. */
export function funnelStats(records: readonly SuggestionRecord[]): FunnelStats {
  const suggested = records.length;
  const confirmedRecords = records.filter((r) => r.confirmedAtMs !== null);
  const hours = confirmedRecords
    // A confirm stamped before its suggestion is a clock problem, not a fast user.
    // Excluded from the latency statistic and still counted as confirmed.
    .filter((r) => (r.confirmedAtMs as number) >= r.createdAtMs)
    .map((r) => ((r.confirmedAtMs as number) - r.createdAtMs) / 3_600_000);

  return {
    suggested,
    confirmed: confirmedRecords.length,
    confirmRate: suggested === 0 ? null : confirmedRecords.length / suggested,
    medianHoursToConfirm: median(hours),
  };
}

/**
 * Evaluate the kill line against the suggestion cohort ending at `nowMs`.
 *
 * `nowMs` is injected rather than read from the clock so the verdict is
 * deterministic in tests, which is the same discipline the retry ladder uses.
 */
export function evaluateKillLine(
  records: readonly SuggestionRecord[],
  nowMs: number,
): KillVerdict {
  const window = cohort(records, nowMs);
  const stats = funnelStats(window);

  if (stats.suggested < KILL_MIN_SUGGESTIONS) {
    return {
      status: "not_enough_data",
      reason:
        `${stats.suggested} suggestion(s) in the ${KILL_WINDOW_DAYS}-day cohort, below the ` +
        `${KILL_MIN_SUGGESTIONS} needed for the rate to mean anything in a 65-person cohort.`,
      stats,
      action:
        "Keep running. The confirm rate is reported and not acted on: a rate over too few " +
        "suggestions has an interval wide enough to contain almost any hypothesis.",
    };
  }

  const rate = stats.confirmRate as number;
  if (rate < KILL_CONFIRM_RATE) {
    return {
      status: "crossed",
      reason:
        `${(rate * 100).toFixed(1)}% of ${stats.suggested} suggestions were confirmed, below the ` +
        `${(KILL_CONFIRM_RATE * 100).toFixed(0)}% kill line.`,
      stats,
      action:
        "The recognition loop is not the product. Stop building on the confirm step: either drop " +
        "the economy to a plain feed, or pivot to whatever people did use. Do not tune the " +
        "detector, which is measured separately and is not what this line tests.",
    };
  }

  return {
    status: "holding",
    reason:
      `${(rate * 100).toFixed(1)}% of ${stats.suggested} suggestions were confirmed, at or above ` +
      `the ${(KILL_CONFIRM_RATE * 100).toFixed(0)}% kill line.`,
    stats,
    action: "Continue. Re-check every four weeks.",
  };
}
