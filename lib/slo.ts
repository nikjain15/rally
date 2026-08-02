import { getRecentOutcomes, getRecentUsage, type OutcomeRecord, type UsageRecord } from './agent';

/**
 * The "is it broken" numbers (finding SH3).
 *
 * Rally already logged per-call usage and cost and answered a health probe. What none of that did
 * was say what number means BROKEN. A dashboard with no threshold is a dashboard nobody reads: it
 * shows a line going up and leaves every viewer to decide privately whether that is fine, which in
 * practice means it is always fine until it is an incident.
 *
 * So this module states three thresholds, and the reason each one is where it is. They are chosen,
 * not derived: Rally has never run under load with a live key, so nothing here is calibrated. The
 * numbers are set where the product's own contract stops holding, which is a defensible starting
 * point and an explicit invitation to move them once there is data.
 *
 * ## What is NOT built, plainly
 *
 * **Nothing notifies anyone.** There is no pager, no email, no Slack webhook, no alerting channel
 * of any kind wired to these numbers. `GET /api/ops/slo` computes them and `GET /api/health`
 * exposes the single boolean, and something outside Rally would have to poll one of them. Calling
 * this "alerting" would be the exact overclaim docs/STAKEHOLDERS.md exists to stop. The measurement
 * is real; the notification is a TODO with nobody assigned.
 *
 * **These are per-instance numbers.** The meters they read are in-process ring buffers, so on
 * Vercel each warm lambda has its own view, the same limitation `lib/rate-guard.ts` carries (AS-6).
 * A breach on one instance is real; the ABSENCE of a breach on the instance you happened to poll
 * proves nothing about the deployment. A shared counter in Firestore is the documented next step.
 */

export type SloIndicator = {
  name: string;
  value: number;
  threshold: number;
  unit: 'ratio' | 'usd_per_hour';
  /** How many observations the value rests on. Below `minSamples` a breach is not declared. */
  samples: number;
  breaching: boolean;
  /** What a breach here actually means for a member using Rally. */
  meaning: string;
};

export type SloReport = {
  atMs: number;
  windowMs: number;
  breaching: boolean;
  indicators: SloIndicator[];
  /** Limits a reader must know before acting on the numbers above. */
  caveats: string[];
};

/**
 * The thresholds. Each one is the point at which a claim Rally makes elsewhere stops being true.
 */
export const SLO = {
  /** Fifteen minutes: long enough to survive one bad minute, short enough to notice a bad deploy. */
  windowMs: 15 * 60 * 1000,

  /**
   * Below this many observations in the window, a ratio is noise. Three failures out of four calls
   * is 75% and means nothing; declaring a breach on it would train everyone to ignore the signal.
   */
  minSamples: 20,

  /**
   * DEGRADE RATE, the headline number. The fraction of model calls that fell back to a
   * deterministic baseline because the ladder was exhausted or the output failed its type guard.
   *
   * 0.20 is the threshold because Rally's whole pitch is that the model is invisible and the
   * fallback is never worse than the baseline. Below a fifth, degrading is the resilience design
   * working as intended. Above it, the honest description of the deployment is "Rally is running on
   * regex and nobody was told", which is a materially different product from the one documented.
   * `no_key` is excluded on purpose: no key means the model is switched OFF, a configuration, and
   * counting it would make every local dev run look like an outage.
   */
  degradeRate: 0.2,

  /**
   * INVALID-OUTPUT RATE. The narrower failure where the model answered but the answer failed the
   * type guard. Held tighter than the degrade rate at 0.05 because it is a different diagnosis: a
   * transient provider blip cannot cause it, so a rise here points at a prompt change, a model
   * swap, or input that is doing something to the prompt. It is the number a bad prompt deploy
   * moves first, which is why docs/RUNBOOK.md keys its detection step to it.
   */
  invalidOutputRate: 0.05,

  /**
   * SPEND RATE, projected from the window to a full hour. Rally is a cohort tool for roughly 65
   * people whose model use is one cheap classify per message plus occasional interactive calls;
   * measured cost per detection is fractions of a cent. Five dollars an hour is therefore two
   * orders of magnitude above normal, which makes it a runaway-loop detector rather than a budget:
   * it fires for a retry storm or an escalation loop, not for a busy afternoon.
   */
  spendUsdPerHour: 5,
} as const;

function inWindow<T extends { atMs: number }>(rows: readonly T[], nowMs: number, windowMs: number): T[] {
  return rows.filter((r) => r.atMs > nowMs - windowMs && r.atMs <= nowMs);
}

/**
 * Pure evaluation: hand it the two logs and a clock and it returns the report. Kept pure so every
 * threshold is unit-testable without a model, a server or a wait.
 */
export function evaluateSlo(input: {
  outcomes: readonly OutcomeRecord[];
  usage: readonly UsageRecord[];
  nowMs: number;
  windowMs?: number;
}): SloReport {
  const windowMs = input.windowMs ?? SLO.windowMs;
  const nowMs = input.nowMs;

  const outcomes = inWindow(input.outcomes, nowMs, windowMs);
  const usage = inWindow(input.usage, nowMs, windowMs);

  // Calls where the model was actually asked something. `no_key` is a switch, not a failure.
  const attempted = outcomes.filter((o) => o.reason !== 'no_key');
  const degraded = attempted.filter((o) => o.reason === 'exhausted' || o.reason === 'invalid_output');
  const invalid = attempted.filter((o) => o.reason === 'invalid_output');

  const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);
  const enough = attempted.length >= SLO.minSamples;

  const costInWindow = usage.reduce((a, r) => a + r.costUsd, 0);
  // Projected to an hour so the threshold reads in money-per-time rather than money-per-window.
  const spendPerHour = costInWindow * (3_600_000 / windowMs);

  const indicators: SloIndicator[] = [
    {
      name: 'model_degrade_rate',
      value: ratio(degraded.length, attempted.length),
      threshold: SLO.degradeRate,
      unit: 'ratio',
      samples: attempted.length,
      breaching: enough && ratio(degraded.length, attempted.length) > SLO.degradeRate,
      meaning:
        'Above this, most of what members see is the deterministic baseline. Recognition detection still works and still never awards anything on its own, but the smarter read is gone and nothing in the UI says so.',
    },
    {
      name: 'model_invalid_output_rate',
      value: ratio(invalid.length, attempted.length),
      threshold: SLO.invalidOutputRate,
      unit: 'ratio',
      samples: attempted.length,
      breaching: enough && ratio(invalid.length, attempted.length) > SLO.invalidOutputRate,
      meaning:
        'The model is answering but the answer fails its type guard. A provider blip cannot cause this, so it points at a prompt or model change, or at message text that is reshaping the prompt. This is the first number a bad prompt deploy moves.',
    },
    {
      name: 'model_spend_usd_per_hour',
      value: spendPerHour,
      threshold: SLO.spendUsdPerHour,
      unit: 'usd_per_hour',
      // Spend needs no minimum sample count: one runaway loop is the thing being caught.
      samples: usage.length,
      breaching: spendPerHour > SLO.spendUsdPerHour,
      meaning:
        'Two orders of magnitude above a normal cohort hour, so this is a runaway-loop detector: a retry storm, or every message escalating to the strong tier. Not a budget alarm.',
    },
  ];

  return {
    atMs: nowMs,
    windowMs,
    breaching: indicators.some((i) => i.breaching),
    indicators,
    caveats: [
      'No notification channel is wired to these numbers. Nothing pages, emails or posts anywhere; something outside Rally has to poll /api/ops/slo. The measurement is built, the alerting is not.',
      'The meters are in-process ring buffers, so on a serverless deployment this is ONE warm instance. A breach here is real; a clean report proves nothing about the other instances.',
      'The thresholds are chosen, not calibrated. Rally has never run under load with a live key, so the first real traffic should re-derive all three.',
      'The ring buffers hold the last 500 records each, so under very high throughput the window may be shorter than it claims.',
    ],
  };
}

/** The report for the live process. Thin wrapper so routes do not reach into the meters. */
export function currentSlo(nowMs: number = Date.now()): SloReport {
  return evaluateSlo({ outcomes: getRecentOutcomes(), usage: getRecentUsage(), nowMs });
}
