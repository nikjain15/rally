# Rally - Product Requirements

Rally is an AI-first, gamified alternative to Slack and Discord: a real-time comms platform
with a trust layer that turns everyday conversation into recognition, motivation, and
follow-through. This PRD is grounded in the shipped code (see `ARCHITECTURE.md` for file
references); anything not yet live is marked as roadmap.

## The problem

Team chat moves messages but does not build a team. In Slack or Discord:

- **Recognition happens by accident, or not at all.** The person who quietly unblocks three
  teammates before lunch is invisible; the person who talks the most looks the most valuable.
- **Motivation fades** and there is no shared sense of forward progress.
- **Who-helped-whom and who-promised-what disappear in the scroll.** Commitments made in a
  thread are forgotten by Friday.
- **Bolting "points" onto chat instantly gets gamed** - self-awarded karma, message-count
  leaderboards, and vanity streaks reward volume, not contribution, and punish the quiet.

The hard part is not adding a score. It is adding a score that is *worth trusting* and that
*lifts people instead of punishing them*.

## The approach

Rally keeps a fast, familiar chat core (channels, DMs, threads, reactions, unread, search,
@mentions) and layers three "quiet intelligences" and a trust ledger on top. Two design
commitments run through everything:

1. **Ungameable by construction.** Points derive from an append-only ledger written only by
   trusted server routes; rank is computed, never stored; you can never confirm your own
   recognition. (Verified: `firestore.rules`, `lib/recognition-admin.ts`.)
2. **The AI has no authority.** The model classifies, summarizes, and drafts. It never writes
   a points-bearing row. Every intelligence has a deterministic fallback, so Rally works fully
   with the model switched off. (Verified: `lib/agent.ts`, `lib/assistant-run.ts`.)

## Personas

| Persona | Who | Jobs to be done |
|---|---|---|
| **Cohort member ("the builder")** | A developer in a 65-person cohort shipping in parallel | "Let me talk to my team without busywork." "Recognize the person who unblocked me." "Track the promise I just made so I actually keep it." "Catch me up in 10 seconds." |
| **The quiet contributor** | High-contribution, low-volume member | "Reward what I actually do, not how loud I am." "Don't put me at the bottom of a public list." |
| **Cohort organizer / community lead** | Runs the cohort or community | "See real momentum, not vanity metrics." "Build culture, not just channels." "Keep it kind - no public shame." |
| **Ecosystem / platform lead** *(interop)* | Owns a suite of tools each shipping its own agent | "Let one tool's agent hand work to another's over shared state, safely." |

## Jobs-to-be-done (primary)

- **JTBD-1 Communicate in real time.** Channels, DMs, threads, reactions, @mentions, search,
  personal unread state. Must work with the smart layer entirely off.
- **JTBD-2 Recognize help credibly.** When I thank a teammate, propose recognition; the
  *helped* peer confirms; only then does the helper earn points. Reward generosity, not volume.
- **JTBD-3 Keep the commitments I make.** Turn "I'll open the PR by Friday" into a tracked
  GitHub issue; closing the issue marks it kept and posts status back to the thread.
- **JTBD-4 Stay oriented without effort.** A "catch me up" brief surfaces only what has a real
  claim on me (a recognition awaiting my confirm, a commitment due), at most three items.
- **JTBD-5 Get leverage from an assistant.** A personalized assistant that reads my situation
  and drafts actions I confirm with one tap - and can never act, post, or award on its own.
- **JTBD-6 Interoperate across the suite** *(roadmap-leaning).* One app's agent can dispatch
  work to another's, keyed by shared identity.

## What's live vs. roadmap (verified against code)

| Capability | Status | Evidence |
|---|---|---|
| Real-time chat core (channels, DMs, threads, reactions, unread, search, @mentions) | **Live** | `app/channels`, `lib/data.ts`, `lib/search.ts`, `lib/mention.ts`, e2e in `tests/e2e/comms.spec.ts` |
| Peer-confirmed recognition (scores only after recipient confirms) | **Live** | `lib/recognition-admin.ts` `confirmRecognition`; rules `recognitions` create/update = false |
| Ungameable append-only XP ledger; rank computed, never stored | **Live** | `firestore.rules` `xpEvents`; `lib/leaderboard-admin.ts` (query + reduce) |
| Recognition detection (deterministic baseline + model layer) | **Live** | `lib/detect.ts`, `lib/detect-model.ts` |
| Commitment tracking -> GitHub issue; closed = kept | **Live (config-gated)** | `lib/commitment-admin.ts`, `lib/pm-adapter.ts`, `app/api/github/webhook`. Degrades to unlinked when no `GITHUB_TOKEN`/`GITHUB_PM_REPO`. |
| "Catch me up" brief | **Live** | `lib/brief.ts`, `lib/brief-admin.ts` |
| Personalized assistant (Claude tool-use loop + private memory) | **Live** | `lib/assistant.ts`, `lib/assistant-run.ts` |
| Neighbors-only, kind leaderboard + cooperative team goal | **Live** | `lib/leaderboard-admin.ts` |
| Quests / badges | **Live** | `lib/quest-admin.ts`, rules `quests`/`badges` |
| Cross-app shared memory + activity + agent-to-agent dispatch | **Rally-side live; cross-app prototype** | `lib/shared-context.ts`, `app/api/assistant/dispatch`, `inbox`. Pulse not yet integrated; bus falls back to Rally's own DB (see `docs/SHARED-CONTEXT.md`). |

## Success metrics

**North star:** confirmed peer recognitions per active member per week (rewards real,
acknowledged help - hard to fake because it needs a second person to confirm).

**Supporting metrics**
- *Trust integrity:* rate of self-award / duplicate-award attempts blocked (target: 100% -
  guarded by rules + admin transactions and proven by the rules test suite).
- *Recognition funnel:* suggested -> confirmed conversion rate; median time-to-confirm.
- *Follow-through:* commitments tracked, and % kept on time.
- *Orientation:* assistant "catch me up" usage; brief -> action click-through.
- *Kindness guardrail (counter-metric):* zero surfaces that expose a full public ranking or
  "N days inactive" (enforced in code, not just policy).
- *Reliability:* core-comms availability with the model off (must be 100%).

## Tradeoffs and non-goals

- **Server-only writes over client convenience.** Recognition confirmation and commitment
  completion are server-only transactions. This costs a round trip but is the only way to make
  "confirmed" and "awarded" atomic - an earlier version let clients flip status directly and
  produced "confirmed-but-unawarded" states (documented in `AGENTS.md`).
- **Kindness over completeness.** No full public leaderboard, no inactivity shaming. We
  deliberately hide the bottom of the board; the judged axis is motivation, not surveillance.
- **Degradation over cleverness.** Every AI feature must have a deterministic fallback. We
  accept "less clever with the model off" to never accept "broken with the model off."
- **Non-goals:** voice/video, enterprise SSO/SCIM, mobile-native apps, and a fully productionized
  cross-app bus (a dedicated shared Firebase project) are out of scope for the current build.

## Roadmap - Now / Next / Later

**Now (shipped, in the cohort pilot)**
- Chat core, peer-confirmed recognition, append-only ledger, commitment tracking, brief,
  assistant with memory, kind leaderboard, quests/badges.
- Piloted with the 65-person cohort. No external users yet.

**Next**
- Productionize the cross-app bus: stand up the dedicated shared Firebase project and integrate
  Pulse's agent end-to-end (today Rally implements the full contract and the bus falls back to
  Rally's own DB).
- Evals harness for recognition detection (precision/recall on a labeled set) and an LLM-judge
  for brief/summary quality (see `EVALS.md`).
- Recognition analytics for organizers (aggregate, still no public shame).

**Later**
- Additional PM adapters (Linear, Jira) behind the existing `PmAdapter` interface.
- Multi-cohort / workspace tenancy.
- Richer assistant proposals (multi-step plans) with the same confirm-before-act guardrail.
