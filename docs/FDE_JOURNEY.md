# Rally, Forward-Deployed Engineering Journey

How Rally goes from a repo to running inside a real customer's environment: integration points,
secrets, rollout/cutover, observability, and de-risking. Rally was piloted with a 65-person
developer cohort (no external users yet), so this is written as the deployment playbook the code
already supports, with honest notes on what a first external customer would still need.

## The deployment thesis

Rally is designed to be **safe to drop into a live environment** because its dependencies are all
optional and degradable. The core comms product runs with the model off, GitHub off, and the
shared bus absent. That inverts the usual FDE risk: instead of "nothing works until everything is
wired," Rally works immediately and each integration is an *additive* upgrade you can enable and
verify one at a time.

## Integration points (all optional, all degradable)

| Integration | What it adds | If absent | Config |
|---|---|---|---|
| **Firebase (Auth + Firestore)** | identity + realtime data (required for the app itself) | app can't run, this is the platform | `NEXT_PUBLIC_FIREBASE_*`, `FIREBASE_SERVICE_ACCOUNT` |
| **Anthropic API** | smarter detection, brief, assistant | deterministic fallbacks; app fully functional | `ANTHROPIC_API_KEY` |
| **GitHub Issues (PM adapter)** | commitment -> tracked issue; closed = kept | commitment recorded, just unlinked | `GITHUB_TOKEN`, `GITHUB_PM_REPO` |
| **GitHub webhook** | auto-complete a commitment when its issue closes | commitments complete via other paths | `GITHUB_WEBHOOK_SECRET` |
| **Shared context bus** | cross-app memory + agent-to-agent dispatch | falls back to the app's own DB | `SHARED_FIREBASE_SERVICE_ACCOUNT` |

Every one of these is checked at the edge of a route and degrades to a `503`/no-op rather than a
crash (`adminDb()`/`busDb()` guards, `hasModel()`, `resolvePmAdapter()`), which is exactly the
property you want when enabling integrations in a customer's environment one at a time.

## Security and secrets

- **Server-only secrets.** `FIREBASE_SERVICE_ACCOUNT`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, and
  `GITHUB_WEBHOOK_SECRET` are never `NEXT_PUBLIC_*` and never reach the browser. The model runs
  server-side only (`lib/agent.ts`, `lib/assistant-run.ts`).
- **The security surface is one auditable file.** `firestore.rules` encodes membership isolation,
  authorship binding, and every anti-gaming guarantee. A customer's security reviewer can read one
  file and the rules test suite that proves it.
- **Least privilege for clients.** Clients can only read channels they belong to, post as
  themselves, toggle their own reaction, and read their own private assistant thread. Every
  points-bearing write is a server transaction via the Admin SDK.
- **Signed inbound webhook.** The GitHub webhook is HMAC-SHA256 verified over the raw body with a
  constant-time compare before any processing (`lib/webhook.ts`), the public endpoint has a
  privileged effect, so verification comes first.
- **Privacy by design in the shared layer** (`docs/SHARED-CONTEXT.md`): per-person isolation keyed
  by handle, deny-all-client rules on the bus, data minimization (concise summaries, not
  transcripts), and a user-facing erasure path (`DELETE /api/assistant/memory` purges shared +
  app-local data, the right to be forgotten).

## Rollout and cutover

1. **Stand up Firebase** (Auth with the GitHub provider, Firestore) and deploy `firestore.rules`.
   This alone gives a working chat product.
2. **Verify offline first.** The entire test gate runs against the Firebase emulator with no
   external credentials (`npm run gate`), so a customer can validate the security rules and core
   behavior before any secret is issued.
3. **Enable the model.** Set `ANTHROPIC_API_KEY`. Detection, brief, and the assistant upgrade in
   place; nothing else changes. Reversible by unsetting the key.
4. **Enable commitment tracking.** Set `GITHUB_TOKEN` + `GITHUB_PM_REPO`, register the webhook
   with `GITHUB_WEBHOOK_SECRET`. New commitments now link to issues; existing ones are unaffected.
5. **Enable cross-app interop (when a second app exists).** Create the dedicated shared Firebase
   project, deploy the deny-all-client bus rules, set `SHARED_FIREBASE_SERVICE_ACCOUNT` on every
   app. Until then the bus falls back to the app's own DB, so shared memory already works within
   the app and turning on the shared project is a config flip, not a migration.
6. **Health probe after deploy.** `GET /api/health` returns `{"app":"rally",...}`; a 404 there
   means a stale/wrong deploy target (`AGENTS.md` documents this exact failure mode). Rally has its
   own deploy target and Vercel project, separate from Pulse.

**Cutover is low-risk** because there is no destructive migration: enabling an integration only
adds capability, and every integration is independently reversible by unsetting its env var.

## Observability and de-risking

- **Deterministic fallback = graceful degradation.** A model outage does not page anyone; features
  silently drop to their baseline. This is the single biggest de-risker for a live deployment.
- **Idempotency everywhere it matters.** Deterministic ledger doc ids make webhook replays and
  double-submits award exactly once, safe under at-least-once delivery.
- **Health route + structured server logs.** The documented benign races (profile create
  contention) are called out in `AGENTS.md` so on-call doesn't chase them.
- **The rules test suite is a living security contract.** Re-runnable in CI against the emulator;
  a red test means a real regression in the anti-gaming or isolation guarantees.
- **Rate limiting** (`lib/rate-guard.ts`) protects the model-backed routes.

**Honest gaps for a first external customer:** rate limiting is in-memory per instance (wants a
shared store like Redis at multi-instance scale); observability is health + logs, not full tracing
or metrics dashboards; and the shared cross-app bus needs its dedicated project stood up before the
Pulse <-> Rally hand-off runs end-to-end (today it is Rally-side complete with a DB fallback).

## Why this is the enterprise-relevant story

The cross-app bus is a small, working model of the problem every enterprise is about to hit:
**every tool is shipping its own agent, and those agents have to cooperate on shared state without
trampling each other.** Rally's answer, a shared contract keyed by stable identity, a
transactional `pending -> claimed -> done` task lifecycle so work is never done twice, deny-all
server-only writes, provenance on every record, and per-person isolation with an erasure path, is
exactly the pattern an FDE would deploy to make a customer's independent systems talk to each other
correctly and safely. That it degrades to a per-app fallback until the shared project exists is
itself the FDE-friendly property: you can adopt it incrementally, one app at a time.
