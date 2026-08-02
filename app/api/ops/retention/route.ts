import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/admin';
import { verifyOps } from '@/lib/ops-auth';
import { retentionSummary, sweepRetention, SWEEP_BUDGET } from '@/lib/retention';

export const runtime = 'nodejs';

/**
 * The retention sweep (finding SH9). POST runs it; GET returns the policy so the windows are
 * readable without running anything.
 *
 * Meant to be driven by a daily schedule. On Vercel that is a cron entry hitting this route with
 * the operator secret; see docs/RUNBOOK.md. Bounded per run (SWEEP_BUDGET), so a backlog is worked
 * off over several runs rather than lost to a serverless timeout mid-delete.
 */
export async function GET(req: Request) {
  const auth = verifyOps(req);
  if (auth === 'not_configured') {
    return NextResponse.json({ error: 'not_configured', hint: 'set RALLY_OPS_SECRET' }, { status: 503 });
  }
  if (auth === 'forbidden') return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  return NextResponse.json({ policy: retentionSummary(), budgetPerRun: SWEEP_BUDGET });
}

export async function POST(req: Request) {
  const auth = verifyOps(req);
  if (auth === 'not_configured') {
    return NextResponse.json({ error: 'not_configured', hint: 'set RALLY_OPS_SECRET' }, { status: 503 });
  }
  if (auth === 'forbidden') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const db = adminDb();
  if (!db) return NextResponse.json({ error: 'ledger_unavailable' }, { status: 503 });

  const report = await sweepRetention(db);
  // Greppable, same shape as the [usage] meter line, so a sweep that deletes nothing for a week is
  // visible in logs rather than silently absent.
  console.info(`[retention] deleted=${report.total} truncated=${report.truncated} detail=${JSON.stringify(report.deleted)}`);
  return NextResponse.json(report);
}
