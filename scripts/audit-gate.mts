/**
 * The dependency-audit gate (finding SH10).
 *
 * CI ran no dependency audit at all, which meant GitHub's advisory list and the repository were
 * two different sources of truth and only one of them blocked a merge. This script makes `npm
 * audit` a build step, and makes the interesting part, the suppressions, expire.
 *
 * The rules, in the order they fail:
 *
 *  1. A malformed allowlist entry fails. Every entry must carry package, ghsa, reason, link and
 *     expiry, and the reason must actually say something (a one-word "known" is not a decision).
 *  2. An entry whose `expires` date has passed fails, EVEN IF the advisory it covers is gone.
 *     That is the whole point: a suppression is a promise to look again on a date, and the build
 *     is what collects on the promise. Deleting the entry is a fine way to resolve it; letting it
 *     rot silently is not.
 *  3. An entry with an expiry further out than `maxHorizonDays` fails, so nobody can write
 *     "expires 2099" and call the problem handled.
 *  4. Any high or critical advisory with no live allowlist entry fails.
 *
 * A suppression that no longer matches anything is reported as a warning, not a failure, so a
 * transitive dependency resolving itself does not turn the build red; it just tells you to clean
 * up. Moderate and low advisories are reported and never fail, matching the stated threshold.
 *
 * The severity npm prints is not the severity Rally cares about. What decides real severity is
 * whether the vulnerable code is reachable from what ships, and that judgment belongs in the
 * `reason` field of the allowlist next to a date, not in a CI flag.
 *
 * Run: `npm run audit:ci`. Pure functions below are unit-tested in tests/unit/audit-gate.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

/** One root advisory, flattened out of npm's package-keyed, self-referential audit graph. */
export type Finding = {
  ghsa: string;
  package: string;
  severity: Severity;
  title: string;
  url: string;
  range: string;
};

export type AllowlistEntry = {
  package: string;
  ghsa: string;
  reason: string;
  link: string;
  expires: string;
  severity?: string;
  scope?: string;
};

export type Allowlist = {
  entries: AllowlistEntry[];
  /** Longest a suppression may be written for, in days. Defaults to 180. */
  maxHorizonDays?: number;
  note?: string;
};

export type GateResult = {
  ok: boolean;
  failures: string[];
  warnings: string[];
  notes: string[];
};

/** Severities that block the build. Everything below is reported and tolerated. */
export const BLOCKING: Severity[] = ['high', 'critical'];

const DEFAULT_HORIZON_DAYS = 180;
const MIN_REASON_CHARS = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

function isBlocking(sev: Severity): boolean {
  return BLOCKING.includes(sev);
}

/**
 * Flatten `npm audit --json` into root advisories.
 *
 * npm reports one entry per affected package and links them with `via`: a string in `via` means
 * "vulnerable only because a dependency is", an object means "this is where the advisory lives".
 * Gating on the objects only is what stops one sharp advisory from being counted five times as
 * sharp, next, and every package in between, while the affected-package list stays visible in the
 * printed report.
 */
export function parseAdvisories(auditJson: unknown): Finding[] {
  const root = auditJson as { vulnerabilities?: Record<string, unknown> } | null;
  const vulns = root?.vulnerabilities;
  if (!vulns || typeof vulns !== 'object') return [];

  const byKey = new Map<string, Finding>();
  for (const node of Object.values(vulns)) {
    const via = (node as { via?: unknown[] }).via;
    if (!Array.isArray(via)) continue;
    for (const v of via) {
      if (!v || typeof v !== 'object') continue; // a string via is a knock-on, not an advisory
      const adv = v as Record<string, unknown>;
      const url = typeof adv.url === 'string' ? adv.url : '';
      const ghsa = url.split('/').pop() ?? '';
      const pkg = typeof adv.name === 'string' ? adv.name : '';
      if (!ghsa || !pkg) continue;
      const key = `${pkg}|${ghsa}`;
      const severity = (typeof adv.severity === 'string' ? adv.severity : 'moderate') as Severity;
      const existing = byKey.get(key);
      // The same advisory can appear once per affected version range; keep the worst severity.
      if (existing && rank(existing.severity) >= rank(severity)) continue;
      byKey.set(key, {
        ghsa,
        package: pkg,
        severity,
        title: typeof adv.title === 'string' ? adv.title : ghsa,
        url,
        range: typeof adv.range === 'string' ? adv.range : '',
      });
    }
  }
  return [...byKey.values()].sort((a, b) => rank(b.severity) - rank(a.severity) || a.package.localeCompare(b.package));
}

function rank(s: Severity): number {
  return ['info', 'low', 'moderate', 'high', 'critical'].indexOf(s);
}

/** Which packages npm says are affected by an advisory, for the human reading the failure. */
export function affectedPackages(auditJson: unknown, ghsa: string): string[] {
  const vulns = (auditJson as { vulnerabilities?: Record<string, unknown> } | null)?.vulnerabilities;
  if (!vulns) return [];
  const hit = new Set<string>();
  const entries = Object.entries(vulns);
  for (const [pkg, node] of entries) {
    const via = (node as { via?: unknown[] }).via ?? [];
    if (via.some((v) => typeof v === 'object' && v !== null && String((v as { url?: string }).url ?? '').endsWith(ghsa))) {
      hit.add(pkg);
    }
  }
  // Knock-on packages ("vulnerable because a dependency is") are reported as strings in `via`, and
  // npm lists packages alphabetically rather than in dependency order, so one pass would miss a
  // parent that sorts before its child. Walk to a fixed point instead.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [pkg, node] of entries) {
      if (hit.has(pkg)) continue;
      const via = (node as { via?: unknown[] }).via ?? [];
      if (via.some((v) => typeof v === 'string' && hit.has(v))) {
        hit.add(pkg);
        changed = true;
      }
    }
  }
  return [...hit].sort();
}

function parseDate(s: unknown): number | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Shape-check the allowlist before it is trusted to suppress anything. A suppression file that
 * silently ignores a typo'd GHSA id is worse than no suppression file: it reads like coverage and
 * provides none.
 */
export function validateAllowlist(allowlist: Allowlist, nowMs: number): string[] {
  const problems: string[] = [];
  const horizonDays = allowlist.maxHorizonDays ?? DEFAULT_HORIZON_DAYS;
  const seen = new Set<string>();

  for (const [i, e] of (allowlist.entries ?? []).entries()) {
    const at = `allowlist entry #${i + 1}`;
    const label = e?.package && e?.ghsa ? `${e.package} / ${e.ghsa}` : at;
    for (const field of ['package', 'ghsa', 'reason', 'link', 'expires'] as const) {
      if (typeof e?.[field] !== 'string' || e[field].trim() === '') {
        problems.push(`${at}: missing required field "${field}"`);
      }
    }
    if (typeof e?.reason === 'string' && e.reason.trim().length > 0 && e.reason.trim().length < MIN_REASON_CHARS) {
      problems.push(
        `${label}: reason is ${e.reason.trim().length} chars, needs at least ${MIN_REASON_CHARS}. Say why the vulnerable code is or is not reachable from what Rally ships.`,
      );
    }
    if (typeof e?.link === 'string' && e.link.trim() !== '' && !/^https?:\/\//.test(e.link)) {
      problems.push(`${label}: link must be an http(s) URL`);
    }
    if (typeof e?.ghsa === 'string' && e.ghsa.trim() !== '' && !/^GHSA-/.test(e.ghsa)) {
      problems.push(`${label}: ghsa must be a GHSA id`);
    }
    const key = `${e?.package}|${e?.ghsa}`;
    if (seen.has(key)) problems.push(`${label}: duplicate entry`);
    seen.add(key);

    const expiresMs = parseDate(e?.expires);
    if (typeof e?.expires === 'string' && e.expires.trim() !== '' && expiresMs === null) {
      problems.push(`${label}: expires must be an ISO date (YYYY-MM-DD), got "${e.expires}"`);
    }
    if (expiresMs !== null && expiresMs > nowMs + horizonDays * DAY_MS) {
      problems.push(
        `${label}: expires ${e.expires} is more than ${horizonDays} days out. A suppression nobody revisits inside two quarters is a decision nobody is making.`,
      );
    }
  }
  return problems;
}

/**
 * The gate itself. Pure: it takes findings, the allowlist and a clock, and returns what failed.
 * `now` is injected so the expiry behaviour is testable without waiting for a calendar.
 */
export function evaluateGate(input: { findings: Finding[]; allowlist: Allowlist; nowMs: number }): GateResult {
  const { findings, allowlist, nowMs } = input;
  const failures: string[] = [...validateAllowlist(allowlist, nowMs)];
  const warnings: string[] = [];
  const notes: string[] = [];

  const entries = allowlist.entries ?? [];
  const live = new Map<string, AllowlistEntry>();

  for (const e of entries) {
    const expiresMs = parseDate(e?.expires);
    if (expiresMs === null) continue; // already reported by validateAllowlist
    if (expiresMs <= nowMs) {
      // Expired suppressions fail whether or not the advisory is still open. Re-read the advisory,
      // then either fix it, or renew the entry with a fresh reason and a fresh date.
      failures.push(
        `EXPIRED SUPPRESSION ${e.package} / ${e.ghsa}: expired ${e.expires}. Re-triage it and either fix the dependency or renew the entry with a current reason and date. ${e.link}`,
      );
      continue;
    }
    live.set(`${e.package}|${e.ghsa}`, e);
  }

  for (const f of findings) {
    const key = `${f.package}|${f.ghsa}`;
    const entry = live.get(key);
    if (!isBlocking(f.severity)) {
      notes.push(`${f.severity} ${f.package} ${f.ghsa} ${f.title}`);
      continue;
    }
    if (entry) {
      const daysLeft = Math.ceil((parseDate(entry.expires)! - nowMs) / DAY_MS);
      notes.push(`${f.severity} ${f.package} ${f.ghsa} SUPPRESSED, ${daysLeft} day(s) left, expires ${entry.expires}`);
      continue;
    }
    failures.push(
      `UNREVIEWED ${f.severity.toUpperCase()} ${f.package} ${f.ghsa}: ${f.title} (${f.range}). Upgrade it, or add an allowlist entry in security/audit-allowlist.json with a reachability reason and an expiry date. ${f.url}`,
    );
  }

  const found = new Set(findings.map((f) => `${f.package}|${f.ghsa}`));
  for (const [key, e] of live) {
    if (!found.has(key)) {
      warnings.push(`STALE SUPPRESSION ${e.package} / ${e.ghsa} no longer matches any advisory. Delete it.`);
    }
  }

  return { ok: failures.length === 0, failures, warnings, notes };
}

export function formatReport(result: GateResult): string {
  const lines: string[] = [];
  if (result.notes.length > 0) {
    lines.push('advisories seen:');
    for (const n of result.notes) lines.push(`  - ${n}`);
  }
  for (const w of result.warnings) lines.push(`warning: ${w}`);
  for (const f of result.failures) lines.push(`FAIL: ${f}`);
  lines.push(result.ok ? 'audit gate: pass' : `audit gate: FAIL (${result.failures.length} blocking)`);
  return lines.join('\n');
}

/** Run `npm audit --json`. It exits non-zero whenever anything was found, so the status is ignored
 *  and only unparseable output is treated as a real failure. */
export function runNpmAudit(cwd: string): unknown {
  let out = '';
  try {
    out = execFileSync('npm', ['audit', '--json'], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    out = (err as { stdout?: string }).stdout ?? '';
  }
  if (!out.trim()) throw new Error('npm audit produced no output');
  return JSON.parse(out);
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const allowlistPath = fileURLToPath(new URL('../security/audit-allowlist.json', import.meta.url));
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as Allowlist;
  const audit = runNpmAudit(repoRoot);
  const findings = parseAdvisories(audit);
  const result = evaluateGate({ findings, allowlist, nowMs: Date.now() });

  for (const f of findings.filter((x) => isBlocking(x.severity))) {
    console.log(`[audit] ${f.severity} ${f.package} ${f.ghsa} affects: ${affectedPackages(audit, f.ghsa).join(', ')}`);
  }
  console.log(formatReport(result));
  if (!result.ok) process.exitCode = 1;
}

// Only run when invoked as a script, so the pure functions above stay importable from tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
