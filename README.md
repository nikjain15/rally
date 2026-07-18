# Rally

The Week 2 cohort comms platform for the Hult Developer Program. Where the cohort talks, tracks
what they promised, and lifts the people who help — one place for all 65.

Built on the **same stack as Pulse** (Project 1) so the two can merge into one surface later, and
sharing code through the `@cohort/core` package.

## What it does

A realtime chat platform — **channels, DMs, threads, reactions, unread, notifications** — with
three things layered on that make it more than chat, each of which **degrades to nothing** if the
model or GitHub is unavailable (the base product always works):

1. **Recognition engine.** Thank a teammate → Rally proposes a recognition → *they* confirm it →
   only then does the helper earn XP. It rewards generosity and can't be gamed.
2. **PM integration.** "Track it" turns a promise into a GitHub issue; closing the issue marks the
   commitment kept and posts the status back to the thread.
3. **Three quiet intelligences.** A "Catch me up" Brief, an "Ask Rally" channel Q&A, and
   recognition/commitment detection. The word "AI" never appears in the UI — it's just "Rally".

Motivation is the judged axis, and Rally is built to **lift, never punish**: opt-in peer-confirmed
recognition, a **neighbors-only** leaderboard (no public "who's behind"), a cooperative team goal,
and no penalty for a missed commitment.

## Run it locally (no credentials needed)

Requires Node 20.9+ and Java on your PATH (the Firebase emulator needs it).

```bash
cd submissions/nikjain15-project-2
npm ci                 # @cohort/core is vendored + committed — no pre-build, no sibling needed
npm run build          # verified green from a fresh clone

# Two terminals for local dev on the emulator:
npm run emulator       # terminal 1 (Firestore + Auth emulators)
npm run dev:emulator   # terminal 2 → http://localhost:3000

# Optional: seed synthetic demo data
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-rally node scripts/seed.mjs
```

Sign in with GitHub (the emulator stands in for GitHub locally). Everything works with the model
and GitHub switched off — set the env below only for the live smart/PM features.

## Architecture

- **Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4.** Firestore is the realtime bus
  (`onSnapshot` — no custom websockets), Firebase Auth (GitHub) is identity, `firebase-admin`
  backs the server routes, `@anthropic-ai/sdk` runs server-side only.
- **`@cohort/core`** (at `submissions/cohort-common/`) — shared Firebase init, cohort roster,
  rate-limit, Firestore rule helpers, and types. Ships committed build output and is vendored into
  this submission (`vendor/cohort-core`) so a fresh clone and the isolated deploy both build with
  no pre-build step. `npm run sync:core` regenerates the vendored copy from the canonical source.
- **Ledger, not counters.** XP/rank/reputation derive from the append-only `xpEvents` collection,
  written only by admin routes; rank is computed (query + reduce), never a stored total.
- **Security lives in `firestore.rules`** (40 rules tests): channel-membership isolation,
  authorship binding, and anti-gaming — clients can never write points, confirm their own
  recognition, inflate a count with duplicate uids, or react as someone else.

## Testing

```bash
npm run gate           # typecheck, lint, unit, rules, integration, e2e smoke
npm run test:e2e       # signed-in browser e2e against the emulator (sign in → send → react → track → Home)
```

- **unit** (40) — pure logic: detection, Brief ranking, points, rate-limit, unread, model-output parsing.
- **rules** (40) — the anti-gaming/membership guarantees, the load-bearing tests.
- **integration** (31) — the real client SDK + rules + realtime on the emulator, incl. an
  adversarial "break it" pass and a cohort-scale perf pass (~65 users / ~2,100 msgs: channel load
  ~73ms, Brief ~69ms, leaderboard ~16ms).
- **e2e** (4) — sign-in + send, reactions, commitment Track it, and the Home board, in a browser.

## Environment (live deploy only)

`NEXT_PUBLIC_FIREBASE_*`, `FIREBASE_SERVICE_ACCOUNT`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
`GITHUB_PM_REPO`, `GITHUB_WEBHOOK_SECRET`. All optional — the app runs deterministically without them.

See [AGENTS.md](AGENTS.md) for the gotchas that will bite a contributor.
