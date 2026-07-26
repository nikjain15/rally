# Rally

Your cohort, in sync. A real-time comms platform where a cohort talks, recognizes the people who help, and keeps the commitments they make, with a built-in assistant that can act on your behalf.

## Project overview

Rally is a real-time chat application (channels, DMs, threads, reactions, unread, search, @mentions) with a trust layer on top: peer-confirmed recognition, tracked commitments, and a Rally assistant backed by a Claude tool-use loop with persistent memory. It is built for cohorts and teams who want to talk, recognize genuine help, and keep the promises they make. Every smart feature degrades to a no-op when the model or GitHub is unavailable, so the core comms always work. The design goal is to lift, never punish: opt-in peer-confirmed recognition, a neighbors-only leaderboard, a cooperative team goal, and no penalty for a missed commitment.

## Tech stack

- Next.js 16 (App Router) with Turbopack as the default bundler.
- React 19 and TypeScript 5 (strict mode).
- Tailwind CSS v4 (via `@tailwindcss/postcss`).
- Firestore for realtime data (`onSnapshot`, no custom websockets) and Firebase Auth (GitHub) for identity.
- `firebase-admin` for trusted server routes.
- `@anthropic-ai/sdk` for the intelligences and assistant, server-side only.
- Vitest for unit, rules, and integration tests; Playwright for e2e.
- Firebase emulators (Firestore, Auth) for local dev and tests.
- `@cohort/core`, a vendored, committed `file:` dependency at `vendor/cohort-core`.

Requires Node 20.9 or newer, and Java on your PATH (the Firebase emulator needs it).

## Setup

```bash
npm ci                 # installs dependencies; @cohort/core is vendored and committed, no pre-build needed

# Local dev on the emulator uses two terminals:
npm run emulator       # terminal 1: Firestore and Auth emulators
npm run dev:emulator   # terminal 2: app at http://localhost:3000

# Optional: seed synthetic demo data
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-rally node scripts/seed.mjs
```

No credentials are needed for local dev. Sign in with GitHub (the emulator stands in for GitHub locally). If `firebase emulators:exec` reports "Unable to locate a Java Runtime", add Java to your PATH, for example `export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"`.

`npm run dev` runs the app against real Firebase (needs the environment variables below). `npm run explore` (`scripts/explore.sh`) is a convenience wrapper for an emulator-backed local run.

## Build

```bash
npm run build          # next build; verified green from a fresh clone
npm run start          # serve the production build
```

## Testing

`npm run gate` runs the full regression net before a PR. The individual commands:

- `npm run typecheck`: `tsc --noEmit`, TypeScript in strict mode.
- `npm run lint`: ESLint (`eslint-config-next` core-web-vitals and typescript).
- `npm run test:unit`: Vitest unit project. Pure logic: detection, brief ranking, points, rate-limit, unread, @mention parsing, search, commitment nudges, assistant tool routing, model-output parsing.
- `npm run test:rules`: Vitest rules project under the Firestore emulator. The anti-gaming, membership, and privacy guarantees. These are load-bearing; if one goes red the product is gameable.
- `npm run test:integration`: Vitest integration project under the Firestore and Auth emulators. The real client SDK plus rules plus realtime, including an adversarial pass, assistant memory persistence, and a cohort-scale perf pass.
- `npm run test:e2e`: Playwright signed-in browser flows under the emulators. Send, react, edit and delete, thread reactions, @mention across two clients, search, profile, onboarding, leaderboard opt-in, the assistant panel, and cross-client realtime.
- `npm run test:e2e:smoke`: fast Playwright smoke subset.
- `npm run gate`: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`, `test:e2e:smoke` in sequence.
- `npm run emulator`: start the Firestore and Auth emulators standalone.

A Playwright global-setup warms the dev routes so no e2e test pays the cold Turbopack compile. Compilation passing is not proof of correctness; the e2e drives the real signed-in path. Fixtures are synthetic only; never ingest real peers' data.

## Code style and conventions

- Language: TypeScript in strict mode, targeting ES2017 with `moduleResolution: bundler`.
- Formatter and linter: ESLint via `eslint-config-next` (core-web-vitals and typescript rulesets). Run `npm run lint`.
- Imports: use the `@/*` path alias for repo-root-relative imports (configured in `tsconfig.json`).
- Every screen is a client component (the whole app is realtime listeners). Screens use `useParams()` and hooks, not promised `params`.
- The word "AI" never appears in the UI; it is always "Rally". Backend and agent code may use whatever terms it likes. `grep -rniE '\bA\.?I\b' app/` should stay empty.
- Points and rank derive from the append-only `xpEvents` collection (a ledger, not stored counters). Rank is computed by query and reduce, never a stored total.
- The model has no authority: it classifies, summarizes, and drafts, and never writes a points-bearing row. Every intelligence has a deterministic fallback.

## Project structure

```
app/            Next.js App Router routes: pages (home, channels, quests, leaderboard, profile) plus API routes under app/api
components/     UI: app shell (app-shell.tsx), nav (rally-nav.tsx), the Rally assistant panel (rally-agent.tsx), onboarding
lib/            data layer, firestore rule helpers, the model wrapper, admin (server-only) routes, and the assistant tool loop
vendor/         cohort-core, the vendored and committed @cohort/core dependency
tests/          unit, rules, integration, e2e
scripts/        explore.sh (emulator dev wrapper) and seed.mjs (synthetic demo data)
docs/           product and engineering write-ups (PRD, ARCHITECTURE, EVALS, TECHNICAL_NOTES, and more)
firestore.rules the security surface (rules-tested)
```

Key `lib/` conventions: files ending `-admin.ts` are server-only routes that hold the authority to write the XP ledger, flip recognition and commitment status, and provision data. Recognition confirmation and commitment completion each write the ledger and flip status in one admin transaction; clients can never flip those directly.

## Commit and PR guidelines

- Branch off `main`; open PRs into `main`.
- All checks must pass before merge: run `npm run gate` locally, and the same suite gates the PR.
- Keep changes scoped and the working tree clean.
- Firestore security lives in `firestore.rules`. Any change to who can read or write must ship with matching rules tests.
- After editing `@cohort/core` source, run `npm run sync:core` to regenerate the vendored copy under `vendor/cohort-core`, and commit the regenerated `dist/` (force-add it, since `dist/` is gitignored).

## Security and secrets

All environment variables are optional; the app runs deterministically without them, with the smart features degraded to no-ops.

- Client (public by design, shipped to the browser, gated by `firestore.rules`): `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`.
- Server secrets (never `NEXT_PUBLIC_`, never committed): `FIREBASE_SERVICE_ACCOUNT` (the full service-account JSON as one line), `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GITHUB_PM_REPO`, `GITHUB_WEBHOOK_SECRET`.

Secrets are configured in the deployment platform's environment settings and never reach the client. `@anthropic-ai/sdk` and `firebase-admin` are used server-side only. Firestore security (channel-membership isolation, authorship binding, and the anti-gaming guarantees) lives in `firestore.rules`; clients can never mint points, confirm their own recognition, inflate a count with duplicate ids, react as someone else, or read another person's assistant conversation. See `.env.example` for the full annotated list.
