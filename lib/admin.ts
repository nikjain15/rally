import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';

/**
 * Rally's Admin SDK half — the ONLY code that writes the points-bearing collections
 * (`xpEvents`, `pulseEvents`) and flips recognition points. Server-side only, and
 * rule-exempt by nature: firestore.rules deliberately makes those writes impossible from a
 * client, so a trusted server path has to be the one to do them. That split is what makes
 * "a client can never mint XP" true rather than aspirational.
 *
 * Credentials, in order:
 * - FIREBASE_SERVICE_ACCOUNT (JSON from the Firebase console) — production.
 * - FIRESTORE_EMULATOR_HOST — the emulator needs no credential, which is what makes every
 *   piece of this testable before the key exists.
 * - Neither → null, and the caller degrades loudly rather than pretending.
 */
export function adminDb(): Firestore | null {
  const app = ensureAdminApp();
  return app ? getFirestore() : null;
}

export function adminAuth(): Auth | null {
  const app = ensureAdminApp();
  return app ? getAuth() : null;
}

function ensureAdminApp(): boolean {
  if (getApps().length > 0) return true;
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (svc) {
    try {
      initializeApp({ credential: cert(JSON.parse(svc) as Parameters<typeof cert>[0]) });
      return true;
    } catch {
      // A malformed key is "not configured", not a crash — the route reports it.
      return false;
    }
  }
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-rally' });
    return true;
  }
  return false;
}
