import { ToolRegistry } from '@/lib/conduit/mcp';
import { adminDb } from '@/lib/admin';
import { selectRelevant } from '@/lib/retrieval';
import {
  rallyMcpTools,
  type GetRecognitionsResult,
  type RallyReader,
  type RecognitionHit,
  type SearchChannelResult,
} from './rally-tools';

/**
 * The Rally MCP server wiring: bind the read-only tools to the app's REAL data
 * access and expose them as a Conduit MCP `ToolRegistry`. The pure registry is
 * what the transports (stdio, HTTP/SSE) and the tests both consume.
 *
 * Authorization is honoured at two layers. Identity: `liveReader(uid)` produces
 * an auth-bound reader; a null uid yields `authorized: false` so the tools
 * refuse before touching data. Membership/ownership: the reader's own reads are
 * scoped: search returns nothing unless the identity is a member of the
 * channel, and recognitions are scoped to the identity as helper or helped peer.
 * Transport: `authorizeBearer` additionally gates a hosted server on a shared
 * token, closed by default when none is configured.
 */

const DEFAULT_SEARCH_LIMIT = 12;
const DEFAULT_RECOGNITION_LIMIT = 25;

/**
 * Bind a live reader over the Admin Firestore, honouring the caller's verified
 * uid. `authorized` reflects whether an identity was verified; a null uid is an
 * unbound identity and every read returns empty (the tool refuses upstream on
 * `authorized`). Best-effort: a Firestore error yields empty rows, never a throw.
 */
export function liveReader(uid: string | null): RallyReader {
  const db = adminDb();
  return {
    authorized: uid !== null && db !== null,
    async searchChannel(args): Promise<SearchChannelResult> {
      const empty: SearchChannelResult = { channelId: args.channelId, count: 0, matches: [] };
      if (!db || !uid) return empty;
      try {
        // Membership gate: never read a channel the caller is not a member of.
        const ch = await db.collection('channels').doc(args.channelId).get();
        const members: string[] = ch.exists ? (ch.data()?.memberUids ?? []) : [];
        if (!members.includes(uid)) return empty;

        const snap = await db
          .collection('channels')
          .doc(args.channelId)
          .collection('messages')
          .orderBy('createdAt', 'desc')
          .limit(300)
          .get();
        const candidates = snap.docs
          .reverse()
          .map((m) => ({ author: (m.data().authorUid as string) ?? '', body: (m.data().body as string) ?? '' }));

        const { selected } = selectRelevant(candidates, args.query, {
          topK: args.limit ?? DEFAULT_SEARCH_LIMIT,
        });
        return { channelId: args.channelId, count: selected.length, matches: selected };
      } catch {
        return empty;
      }
    },
    async getRecognitions(args): Promise<GetRecognitionsResult> {
      if (!db || !uid) return { count: 0, recognitions: [] };
      try {
        const limit = args.limit ?? DEFAULT_RECOGNITION_LIMIT;
        // Ownership scope: recognitions where the caller is the helper OR the helped peer.
        const [asHelper, asHelped] = await Promise.all([
          db.collection('recognitions').where('helperUid', '==', uid).limit(limit).get(),
          db.collection('recognitions').where('helpedUid', '==', uid).limit(limit).get(),
        ]);
        const byId = new Map<string, RecognitionHit>();
        for (const d of [...asHelper.docs, ...asHelped.docs]) {
          const x = d.data();
          const status = String(x.status ?? '');
          if (args.status && status !== args.status) continue;
          byId.set(d.id, {
            id: d.id,
            helperUid: String(x.helperUid ?? ''),
            helpedUid: String(x.helpedUid ?? ''),
            kind: String(x.kind ?? ''),
            points: Number(x.points ?? 0),
            status,
          });
        }
        const recognitions = [...byId.values()].slice(0, limit);
        return { count: recognitions.length, recognitions };
      } catch {
        return { count: 0, recognitions: [] };
      }
    },
  };
}

/** Server identity advertised on `initialize` and in `tools/list` metadata. */
export const RALLY_MCP_INFO = { name: 'rally', version: '0.1.0' } as const;

/** A ready-to-serve registry over the Rally read-only tools. */
export function createRallyRegistry(reader: RallyReader = liveReader(null)): ToolRegistry {
  return new ToolRegistry(rallyMcpTools(reader));
}

/**
 * Transport-level bearer check for the hosted server. Returns true when the
 * presented token matches `MCP_AUTH_TOKEN`. When no token is configured the
 * server is closed by default (returns false), so an unconfigured deploy never
 * serves unauthenticated. Local stdio needs no token (the OS process boundary
 * is the trust boundary).
 */
export function authorizeBearer(header: string | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match?.[1]?.trim();
  return presented !== undefined && presented === expected;
}
