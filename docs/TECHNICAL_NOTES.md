# Rally, Technical Notes and Rubric Scorecard

Engineering detail behind Rally, and an honest 12-point scorecard with file-level evidence and
gaps. Scores are self-assessed against a bar-raiser lens; the "gap" column is deliberately blunt.

## 12-point scorecard

| # | Dimension | Score | Evidence (file refs) | Gap |
|---|---|---|---|---|
| 1 | Model choice (LLM vs ML vs hybrid) | 4/5 | Deliberate hybrid: deterministic core (`lib/detect.ts`, `lib/brief.ts`) with an LLM layer on top (`lib/detect-model.ts`, `lib/assistant-run.ts`). LLM chosen for free-text understanding; regex/ranking chosen for the parts that must never fail. Model tiers set per task (`lib/agent.ts` `MODELS`). | No learned ML model (e.g. a classifier trained on cohort data); the "ML" side is rules, not a trained model. Model-vs-baseline win not yet measured (see EVALS layer 4). |
| 2 | How the AI works (context, grounding) | 4/5 | Assistant grounds in what the caller could already read (channels, commitments, memory) via SAFE tools; system prompt injects private + shared memory (`lib/assistant-run.ts`). Detection prompt is tightly scoped and its output schema-validated (`extractJson`). **Temperature is now set explicitly as a risk dial** — 0 for the grounded classify/extract paths, 0.3 for the assistant and Ask summary (`lib/agent.ts`, `lib/detect-model.ts`, `app/api/ask/route.ts`, `lib/assistant-run.ts`). | Token budgets are still hand-picked defaults; retrieval ranking now exists for Ask/summary (see #6). |
| 3 | Tools / MCP (schemas, validation, errors) | 4/5 | Typed Anthropic tool schemas (`ASSISTANT_TOOLS`), safe/propose split (`SAFE_TOOLS`/`PROPOSE_TOOLS`), `toProposal` validates every tool input, unknown tools handled, loop bounded to 5 steps. Errors degrade to `available:false` not a crash. | Not MCP-standard tools; no per-tool timeout/retry; tool errors collapse to a generic message. |
| 4 | Agents & skills | 4/5 | A real bounded tool-use agent on Home (`lib/assistant-run.ts`) plus an inbox agent that claims cross-app tasks and runs them through the same assistant (`app/api/assistant/inbox`). Clear capability boundary (read/draft only). | Single-agent depth; no multi-agent planning or long-horizon memory beyond notes. |
| 5 | Orchestration & routing (multi-model, cost) | 3/5 | Cost-aware per-task tiers: the bulk, low-stakes Brief classify routes to the **cheap** tier, `sonnet-5` is the interactive default, and an `escalate` tier is reserved for the ambiguous turn (`lib/agent.ts` `MODELS`). **Per-call token + estimated-USD telemetry** is now recorded for every model call, keyed by feature (`recordUsage`/`usageTotals`, `MODEL_PRICING`), unit-tested in `tests/unit/telemetry.test.ts`. | Routing is tier-per-feature, not yet a live low-confidence auto-escalate; no hard budget cap enforced in code. |
| 6 | RAG & context (retrieval, failure modes) | 3/5 | Context is assembled from Firestore (membership-scoped reads, personal unread bookmarks, private + shared memory merged in `runAssistant`). **Ask and channel-summary now RETRIEVE, not just recency-stuff**: a BM25 ranker (`lib/retrieval.ts`) scores a broad candidate pool against the question and windows the top matches (`app/api/ask/route.ts`, `summarize_channel`). **Both RAG failure modes are handled**: unfaithful-answer via the "answer only from transcript" prompt, and bad-retrieval via an explicit abstention — when nothing scores, Ask returns "couldn't find anything about that" instead of guessing. Failure modes stay first-class: missing key -> null, bus hiccup -> best-effort, model failure -> deterministic fallback. | Keyword BM25, not embeddings/vector search; candidate pool is still a bounded recent window (300), so retrieval is exact within it but not over full history at workspace scale. |
| 7 | Evals & grounding | 3/5 | ~171 tests across unit/rules/integration/e2e; the rules suite *is* an anti-gaming eval; adversarial "break it" integration pass; documented perf pass. Untrusted model output schema-validated before trust. | No precision/recall harness, LLM-judge, or A/B yet (designed in `EVALS.md`, roadmap). No labeled detection dataset committed. |
| 8 | Code quality | 5/5 | Small, single-responsibility modules with intent-dense comments; pure logic separated from I/O (unit-testable without model/Firestore); adapter pattern for the PM integration; typecheck + lint + 4 test layers gated in `npm run gate`. | Some server routes repeat auth/rate/db-guard boilerplate that could be a shared middleware. |
| 9 | Scalability & cost | 3/5 | Reactions inline as `{uid:emoji}` maps -> one listener per channel not per message; brief unread capped at `limit(50)`; leaderboard computed server-side; model calls degrade to free deterministic paths. Documented perf at ~65 users. | Leaderboard does a full `xpEvents` collection scan each call (fine at cohort scale, O(events) at growth); no caching/materialized rollups; single Firestore project. |
| 10 | Guardrails & safety | 5/5 | The centerpiece. Ledger is client-unwritable (`firestore.rules`); no self-award / no client status-flip (`recognition-admin.ts`); idempotent awards via deterministic ids; webhook HMAC-verified constant-time (`lib/webhook.ts`); model output validated; the model has *no* awarding/posting tool; membership + private-thread isolation proven by rules tests; "be kind to the quiet" (no public shame) enforced in code. | Rate limiting is in-memory per-instance (`lib/rate-guard.ts`), not distributed; shared-bus rules are deny-all but the shared project is not yet stood up. |
| 11 | Product layer | 5/5 | `docs/PRD.md`: personas, JTBD, success metrics with a north star and counter-metrics, explicit tradeoffs/non-goals, Now/Next/Later. Product judgment visible in the design (peer-confirm, kind leaderboard, degrade-first). | Metrics are defined but not yet instrumented in a dashboard; single-cohort validation only. |
| 12 | FDE journey | 4/5 | `docs/FDE_JOURNEY.md`: config-gated integrations (Anthropic, GitHub, shared bus) all optional and degradable; secrets server-only; signed webhook; emulator-based rollout; health probe. The cross-app bus is the real enterprise story (every tool ships an agent; they must cooperate on shared state). | Deployed to one cohort, no external customer cutover yet; observability is logs + a health route, not full tracing/metrics. |

**Aggregate: 47/60.** Strongest on guardrails, code quality, and product; the honest gaps are a
formal eval harness, dynamic/cost-aware routing, and scale beyond a single cohort.

## Model and orchestration details

- **Single wrapper** (`lib/agent.ts`): `callClaude` returns `string | null`, missing
  `ANTHROPIC_API_KEY` or any exception (rate limit, timeout, bad key, malformed response) all
  collapse to `null`, so callers have exactly one degradation path.
- **Model tiers** (`MODELS`): a cost-aware cascade — the cheap `claude-haiku-5` tier for the bulk
  Brief classify, `claude-sonnet-5` for detection and the assistant, and `claude-opus-4-8` held in
  reserve as the `escalate` tier for genuinely ambiguous input. Every call is metered
  (`recordUsage`) so per-feature token/USD spend is visible.
- **Untrusted-output discipline:** `extractJson` parses model output out of prose/fences and
  runs a type guard before the value is used. Detection additionally drops unknown `kind`s and
  normalizes handles. The model reads attacker-controllable message text, so its output is never
  trusted structurally.
- **Bounded agent loop:** `MAX_STEPS = 5`; safe tools execute server-side, propose tools return
  typed `Proposal`s and never execute.

## Guardrails, the anti-gaming spine (verified)

1. **Clients can never write points.** `xpEvents`, `recognitions`, `pulseEvents`, `cohortGoals`,
   `badges` are all `create/update/delete: false` in `firestore.rules`. Only the Admin SDK (which
   bypasses rules) writes them, from auth-gated routes.
2. **No self-award, no client status-flip.** `confirmRecognition` requires
   `helpedUid === actingUid` and rejects `helperUid === actingUid`; status flips only inside the
   server transaction that also writes the ledger, so "confirmed" and "awarded" are atomic.
3. **Idempotent awards.** Ledger doc ids are deterministic (`xp_help_<recognitionId>`,
   `xp_commit_<commitmentId>`), so retries/replays award exactly once.
4. **No count inflation.** Reactions are a uid-keyed map; the rule proves an update touches only
   the caller's own key. uid-list edits are set-checked (`noDuplicates` + `togglesOnlySelf`).
5. **Signed webhook.** The public GitHub webhook triggers a privileged action; it is HMAC-SHA256
   verified over the raw body with a constant-time compare before anything is read.
6. **Kindness as a hard rule.** No full public ranking (neighbors-only, computed server-side,
   full order never returned), no inactivity shaming, no penalty for a missed commitment, personal
   unread state never broadcast.
7. **The model has no authority.** Structurally: there is no tool in the assistant that awards,
   posts, or confirms; a drafted recognition still needs peer confirmation.

## Cost notes

- **The expensive path is optional.** With the model off, every intelligence uses free
  deterministic logic and the app is fully functional, the model is a quality upgrade, not a
  dependency. This caps worst-case cost at zero and makes model spend a deliberate choice.
- **Model calls are single-turn and small** (detection `maxTokens: 300`; assistant `1024`),
  routed to the cheapest sufficient tier per feature.
- **Read cost is engineered down:** inline reactions (one listener/channel), `limit(50)` on the
  brief's unread gather, server-side leaderboard.
- **Known cost gap:** the leaderboard scans the full `xpEvents` collection per request; at growth
  this wants a materialized per-user rollup or cache.
