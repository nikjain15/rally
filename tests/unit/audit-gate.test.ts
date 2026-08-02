import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  affectedPackages,
  evaluateGate,
  parseAdvisories,
  validateAllowlist,
  type Allowlist,
} from '../../scripts/audit-gate.mts';

/**
 * The audit gate is CI's only opinion about dependency risk, so its own logic has to be tested,
 * not just run. The cases that matter are the ones that make a suppression a decision rather than
 * a shrug: expiry fails the build, a far-future expiry fails the build, and a reason that says
 * nothing fails the build.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-02T00:00:00Z');

function iso(offsetDays: number): string {
  return new Date(NOW + offsetDays * DAY).toISOString().slice(0, 10);
}

const GOOD_REASON =
  'Dev-only: this package is pulled in by the test toolchain and never reaches the shipped bundle.';

function allowlist(overrides: Partial<Allowlist['entries'][number]> = {}, rest: Partial<Allowlist> = {}): Allowlist {
  return {
    entries: [
      {
        package: 'left-pad',
        ghsa: 'GHSA-aaaa-bbbb-cccc',
        reason: GOOD_REASON,
        link: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
        expires: iso(30),
        ...overrides,
      },
    ],
    ...rest,
  };
}

const HIGH = {
  ghsa: 'GHSA-aaaa-bbbb-cccc',
  package: 'left-pad',
  severity: 'high' as const,
  title: 'left-pad eats the heap',
  url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
  range: '<1.0.1',
};

describe('parseAdvisories', () => {
  const audit = {
    vulnerabilities: {
      next: { name: 'next', severity: 'high', isDirect: true, via: ['sharp'] },
      sharp: {
        name: 'sharp',
        severity: 'high',
        via: [
          { source: 1, name: 'sharp', title: 'libvips CVEs', url: 'https://github.com/advisories/GHSA-f88m-g3jw-g9cj', severity: 'high', range: '<0.35.0' },
        ],
      },
      uuid: {
        name: 'uuid',
        severity: 'moderate',
        via: [
          { source: 2, name: 'uuid', title: 'bounds check', url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq', severity: 'moderate', range: '<11.1.1' },
        ],
      },
    },
  };

  it('counts one root advisory per package, not once per knock-on package', () => {
    const found = parseAdvisories(audit);
    expect(found.map((f) => `${f.package}|${f.ghsa}`)).toEqual([
      'sharp|GHSA-f88m-g3jw-g9cj',
      'uuid|GHSA-w5hq-g745-h8pq',
    ]);
  });

  it('still reports the knock-on packages an advisory affects, in dependency order or not', () => {
    // npm lists packages alphabetically, so `next` is emitted before the `sharp` it depends on.
    expect(affectedPackages(audit, 'GHSA-f88m-g3jw-g9cj')).toEqual(['next', 'sharp']);
  });

  it('keeps the worst severity when one advisory spans several version ranges', () => {
    const multi = {
      vulnerabilities: {
        'brace-expansion': {
          via: [
            { name: 'brace-expansion', url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg', severity: 'moderate', range: '<1.1.17', title: 'DoS' },
            { name: 'brace-expansion', url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg', severity: 'high', range: '>=2.0.0 <2.1.3', title: 'DoS' },
          ],
        },
      },
    };
    expect(parseAdvisories(multi)).toHaveLength(1);
    expect(parseAdvisories(multi)[0].severity).toBe('high');
  });

  it('returns nothing for a clean audit', () => {
    expect(parseAdvisories({ vulnerabilities: {} })).toEqual([]);
    expect(parseAdvisories(null)).toEqual([]);
  });
});

describe('audit gate', () => {
  it('passes a clean audit', () => {
    const r = evaluateGate({ findings: [], allowlist: { entries: [] }, nowMs: NOW });
    expect(r.ok).toBe(true);
  });

  it('fails an unreviewed high', () => {
    const r = evaluateGate({ findings: [HIGH], allowlist: { entries: [] }, nowMs: NOW });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain('UNREVIEWED HIGH left-pad');
  });

  it('fails an unreviewed critical', () => {
    const r = evaluateGate({
      findings: [{ ...HIGH, severity: 'critical' }],
      allowlist: { entries: [] },
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
  });

  it('does not fail on moderate or low, but does report them', () => {
    const r = evaluateGate({
      findings: [{ ...HIGH, severity: 'moderate' }],
      allowlist: { entries: [] },
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.notes.join(' ')).toContain('moderate left-pad');
  });

  it('suppresses a high that carries a live allowlist entry', () => {
    const r = evaluateGate({ findings: [HIGH], allowlist: allowlist(), nowMs: NOW });
    expect(r.ok).toBe(true);
    expect(r.notes.join(' ')).toContain('SUPPRESSED');
  });

  it('FAILS when an allowlist entry is past its expiry, and the advisory is still open', () => {
    const r = evaluateGate({ findings: [HIGH], allowlist: allowlist({ expires: iso(-1) }), nowMs: NOW });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.startsWith('EXPIRED SUPPRESSION left-pad'))).toBe(true);
  });

  it('FAILS on an expired entry even when the advisory has since been fixed', () => {
    // The promise was "look again on this date". Nobody looked. That is the finding.
    const r = evaluateGate({ findings: [], allowlist: allowlist({ expires: iso(-90) }), nowMs: NOW });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.startsWith('EXPIRED SUPPRESSION'))).toBe(true);
  });

  it('treats an entry expiring today as expired, not as one last free day', () => {
    const r = evaluateGate({ findings: [HIGH], allowlist: allowlist({ expires: iso(0) }), nowMs: NOW });
    expect(r.ok).toBe(false);
  });

  it('an expired entry stops suppressing, so the advisory is unreviewed again', () => {
    const r = evaluateGate({ findings: [HIGH], allowlist: allowlist({ expires: iso(-1) }), nowMs: NOW });
    expect(r.failures.some((f) => f.startsWith('UNREVIEWED HIGH'))).toBe(true);
  });

  it('warns, without failing, about a suppression that no longer matches anything', () => {
    const r = evaluateGate({ findings: [], allowlist: allowlist(), nowMs: NOW });
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toContain('STALE SUPPRESSION left-pad');
  });

  it('fails an expiry written further out than the horizon', () => {
    const r = evaluateGate({ findings: [HIGH], allowlist: allowlist({ expires: iso(400) }), nowMs: NOW });
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toContain('more than 180 days out');
  });

  it('honours a tighter horizon set in the file', () => {
    const r = evaluateGate({
      findings: [HIGH],
      allowlist: allowlist({ expires: iso(60) }, { maxHorizonDays: 30 }),
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
  });
});

describe('allowlist validation', () => {
  it('rejects a missing field', () => {
    const bad = allowlist();
    delete (bad.entries[0] as Partial<Allowlist['entries'][number]>).link;
    expect(validateAllowlist(bad, NOW).join(' ')).toContain('missing required field "link"');
  });

  it('rejects a reason too short to be a decision', () => {
    expect(validateAllowlist(allowlist({ reason: 'known' }), NOW).join(' ')).toContain('reason is 5 chars');
  });

  it('rejects a non-URL link and a non-GHSA id', () => {
    const problems = validateAllowlist(allowlist({ link: 'see slack', ghsa: 'CVE-2026-1' }), NOW);
    expect(problems.join(' ')).toContain('link must be an http(s) URL');
    expect(problems.join(' ')).toContain('ghsa must be a GHSA id');
  });

  it('rejects a malformed expiry', () => {
    expect(validateAllowlist(allowlist({ expires: 'next quarter' }), NOW).join(' ')).toContain('must be an ISO date');
  });

  it('rejects a duplicate entry', () => {
    const dup = allowlist();
    dup.entries.push({ ...dup.entries[0] });
    expect(validateAllowlist(dup, NOW).join(' ')).toContain('duplicate entry');
  });
});

describe('the committed allowlist', () => {
  const file = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../security/audit-allowlist.json', import.meta.url)), 'utf8'),
  ) as Allowlist;

  it('is well formed as of the real clock, which is also how it will fail when it rots', () => {
    // Deliberately uses Date.now(): this test is the local half of the CI gate, so a suppression
    // that has quietly expired turns the unit suite red on the day it expires, not at review time.
    expect(validateAllowlist(file, Date.now())).toEqual([]);
  });

  it('gives every entry a reachability verdict and a link to the advisory', () => {
    for (const e of file.entries) {
      expect(e.link).toContain(e.ghsa);
      expect(e.reason.length).toBeGreaterThan(80);
    }
  });
});
