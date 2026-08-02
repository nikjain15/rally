import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/admin';
import { verifyUid } from '@/lib/auth-server';
import { verifyOps } from '@/lib/ops-auth';
import { eraseMember, ERASURE_LIMITS } from '@/lib/retention';
import { allow } from '@/lib/rate-guard';

export const runtime = 'nodejs';

/**
 * The deletion path (finding SH9). Two ways in, and the difference matters:
 *
 *  - A signed-in member erases THEMSELVES. The uid comes from the verified ID token, never from
 *    the body, so "delete me" cannot become "delete them" by editing a JSON field.
 *  - An operator holding RALLY_OPS_SECRET may erase a named uid, which is the only way to honour a
 *    request from someone who has already lost access to their account.
 *
 * There is no third way. In particular no member, however senior, can erase another member through
 * this route, because Rally has no admin role and inventing one here would be a much larger
 * decision than a deletion path.
 *
 * GET returns what erasure would and would not reach, unauthenticated, because a member deciding
 * whether to ask for deletion should be able to read the limits first.
 *
 * The Firebase Auth user is deliberately NOT deleted here: credentials live in a different store
 * with a different blast radius, and an auth record removed while Firestore data lingered would be
 * the worst of both. Deleting the auth user is a documented follow-up step in docs/RUNBOOK.md.
 */
export function GET() {
  return NextResponse.json({ limits: ERASURE_LIMITS });
}

export async function POST(req: Request) {
  const db = adminDb();
  if (!db) return NextResponse.json({ error: 'ledger_unavailable' }, { status: 503 });

  const ops = verifyOps(req);
  let target: string | null = null;

  if (ops === 'ok') {
    let body: { uid?: unknown } = {};
    try {
      body = (await req.json()) as { uid?: unknown };
    } catch {
      return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }
    if (typeof body.uid !== 'string' || body.uid.trim() === '') {
      return NextResponse.json({ error: 'missing_uid' }, { status: 400 });
    }
    target = body.uid.trim();
  } else {
    const uid = await verifyUid(req);
    if (!uid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    // Erasure walks every channel twice and rewrites the ledger. One a day per member is plenty,
    // and it stops a scripted loop from turning a deletion path into a denial-of-service tool.
    if (!allow('erase', uid, 3, 24 * 60 * 60 * 1000, Date.now())) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
    target = uid;
  }

  const report = await eraseMember(db, target);
  console.info(
    `[erase] uid=${target} deleted=${JSON.stringify(report.deleted)} rekeyed=${JSON.stringify(report.rekeyed)}`,
  );
  return NextResponse.json(report);
}
