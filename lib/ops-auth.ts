import { timingSafeEqual } from 'node:crypto';

/**
 * The operator credential for Rally's non-member routes: the retention sweep, an erasure on behalf
 * of a member who can no longer sign in, and the SLO readout.
 *
 * These are not member actions. A signed-in uid is the wrong gate for "delete someone else's data"
 * or "run the sweep", so they take a shared secret in `X-Rally-Ops-Secret` instead, compared in
 * constant time for the same reason `lib/webhook.ts` does: a length-leaking or early-returning
 * compare hands an attacker a byte at a time.
 *
 * When RALLY_OPS_SECRET is unset the routes report `not_configured` and do nothing. That is the
 * house rule everywhere in Rally: degrade loudly rather than fall open. A missing secret must never
 * mean "allow", which is the failure mode a truthy check would produce.
 */
export type OpsAuth = 'ok' | 'not_configured' | 'forbidden';

export function checkOpsSecret(header: string | null): OpsAuth {
  const secret = process.env.RALLY_OPS_SECRET;
  if (!secret) return 'not_configured';
  if (!header) return 'forbidden';
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return 'forbidden';
  return timingSafeEqual(a, b) ? 'ok' : 'forbidden';
}

/** Convenience for a route: reads the header off the request. */
export function verifyOps(req: Request): OpsAuth {
  return checkOpsSecret(req.headers.get('x-rally-ops-secret'));
}
