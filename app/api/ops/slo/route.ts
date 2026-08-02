import { NextResponse } from 'next/server';
import { verifyOps } from '@/lib/ops-auth';
import { currentSlo, SLO } from '@/lib/slo';

export const runtime = 'nodejs';

/**
 * The SLO readout (finding SH3). Operator-gated because it carries spend figures and a per-feature
 * failure picture, neither of which is member business.
 *
 * This route MEASURES. It does not notify: something outside Rally has to poll it. That gap is
 * stated in the response itself (`caveats`) so a reader cannot mistake a number for an alarm.
 */
export function GET(req: Request) {
  const auth = verifyOps(req);
  if (auth === 'not_configured') {
    return NextResponse.json({ error: 'not_configured', hint: 'set RALLY_OPS_SECRET' }, { status: 503 });
  }
  if (auth === 'forbidden') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const report = currentSlo();
  // 200 either way. A breach is a fact about Rally, not a failure of this request, and returning
  // 5xx here would make a poller unable to tell "Rally is degraded" from "the readout is down".
  return NextResponse.json({ ...report, thresholds: SLO, alerting: 'not_built' });
}
