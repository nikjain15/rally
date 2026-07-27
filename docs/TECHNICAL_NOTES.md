# Rally, Technical Notes and Rubric Scorecard

Engineering detail behind Rally, and an honest 12-point scorecard with file-level evidence and
gaps. Scores are self-assessed against a bar-raiser lens; the "gap" column is deliberately blunt.

## 12-point scorecard

| # | Dimension | Score | Evidence (file refs) | Gap |
|---|---|---|---|---|
| 1 | Model choice (LLM vs ML vs hybrid) | 4/5 | Deliberate hybrid: deterministic core (`lib/detect.ts`, `lib/brief.ts`) with an LLM layer on top (`lib/detect-model.ts`, `lib/assistant-run.ts`). LLM chosen for free-text understanding; regex/ranking chosen for the parts that must never fail. Model tiers set per task (`lib/agent.ts` `MODELS`). | No learned ML model (e.g. a classifier trained on cohort data); the "ML" side is rules, not a trained model. Model-vs-baseline win not yet measured (see EVALS layer 4). |
| 2 | How the AI works (context, grounding) | 4/5 | Assistant grounds in what the caller could already read (channels, commitments, memory) via SAFE tools; system prompt injects private + shared memory (`lib/assistant-run.ts`). Detection prompt is tightly scoped and its output schema-validated (`extractJson`). **The sampling contract is explicit** (`supportsSampling`): the reasoning tiers (`claude-sonnet-5`, `claude-opus-4-8`) reject sampling params, so `temperature` is omitted for the assistant, the Ask summary, and the Opus detect-escalate, and faithfulness is enforced by the grounded prompt; only the cheap `claude-haiku-4-5` detection pass is pinned to `temperature: 0` (`lib/agent.ts`, `lib/detect-model.ts`, `app/api/ask/route.ts`). | Token budgets are still hand-picked defaults; retrieval ranking now exists for Ask/summary (see #6). |
| 3 | Tools / MCP (schemas, validation, errors) | 4/5 | Typed tool schemas (`ASSISTANT_TOOLS`), safe/propose split (`SAFE_TOOLS`/`PROPOSE_TOOLS`), `toProposal` validates every tool input, unknown tools handled, agent loop bounded to `MAX_AGENT_STEPS = 6` with per-call schema validation. **A real read-only MCP surface now ships** (`lib/mcp/`, on the vendored `@conduit/mcp`): two typed, JSON-Schema-validated tools (`search_channel`, `get_recognitions`), invalid args return a structured `invalid_arguments`, unknown tool returns `unknown_tool`, and the registry never throws for expected failures. Errors degrade to `available:false` not a crash. | No per-tool timeout/retry; in-loop tool errors collapse to a generic observation; the MCP transport wrappers depend on `@modelcontextprotocol/sdk` at call time (dynamic import, shimmed types). |
| 4 | Agents & skills | 4/5 | A genuine bounded reason-act agent on Home built on the vendored `@conduit/agent` `runAgent` (`lib/assistant-agent.ts`, wired via `lib/assistant-run.ts`): step cap, one-JSON-object-per-step protocol, three runtime-loaded intent-selected **skills** (`catch-up-summary`, `recognition-draft`, `ask-answer`), and read-only tools. No-authority invariant enforced structurally: `allowSideEffects: false`, the `remember` write tool excluded from the loop, no points-writing/side-effecting tool. Plus an inbox agent that claims cross-app tasks and runs them through the same assistant (`app/api/assistant/inbox`). | Single-agent depth; no multi-agent planning or long-horizon memory beyond notes. |
| 5 | Orchestration & routing (multi-model, cost) | 3/5 | Cost-aware cascade, wired end to end on the bulk detection path: the low-stakes extract runs on the **cheap** `claude-haiku-4-5` tier (`detectRecognitionsSmart`), `sonnet-5` is the interactive default for the assistant and Ask, and a below-`CONFIDENCE_THRESHOLD` candidate auto-escalates that one message once to the `claude-opus-4-8` `escalate` tier (`lib/agent.ts` `MODELS`, `lib/detect-model.ts`). **Per-call token + estimated-USD telemetry** is recorded for every model call, keyed by feature (`recordUsage`/`usageTotals`, `MODEL_PRICING`), unit-tested in `tests/unit/telemetry.test.ts`. | Escalation is a single bounded retry, not a multi-step budget planner; no hard budget cap enforced in code. |
| 6 | RAG & context (retrieval, failure modes) | 3/5 | Context is assembled from Firestore (membership-scoped reads, personal unread bookmarks, private + shared memory merged in `runAssistant`). **Ask and channel-summary now RETRIEVE, not just recency-stuff**: a BM25 ranker (`lib/retrieval.ts`) scores a broad candidate pool against the question and windows the top matches (`app/api/ask/route.ts`, `summarize_channel`). **Both RAG failure modes are handled**: unfaithful-answer via the "answer only from transcript" prompt, and bad-retrieval via an explicit abstention — when nothing scores, Ask returns "couldn't find anything about that" instead of guessing. Failure modes stay first-class: missing key -> null, bus hiccup -> best-effort, model failure -> deterministic fallback. | Keyword BM25, not embeddings/vector search; candidate pool is still a bounded recent window (300), so retrieval is exact within it but not over full history at workspace scale. |
| 7 | Evals & grounding | 3/5 | ~200 tests across unit/evals/rules/integration/e2e; the rules suite *is* an anti-gaming eval; adversarial "break it" integration pass; documented perf pass. Untrusted model output schema-validated before trust. **A precision/recall/F1 detection eval is now implemented** (`npm run test:evals`) against a committed 50-case labeled set, proving the "model never worse than baseline" contract (baseline F1 0.87). | LLM-judge (brief/assistant faithfulness) and A/B remain roadmap (designed in `EVALS.md`); detection dataset is 50 cases, not yet embeddings-scale. |
| 8 | Code quality | 5/5 | Small, single-responsibility modules with intent-dense comments; pure logic separated from I/O (unit-testable without model/Firestore); adapter pattern for the PM integration; typecheck + lint + 4 test layers gated in `npm run gate`. | Some server routes repeat auth/rate/db-guard boilerplate that could be a shared middleware. |
| 9 | Scalability & cost | 3/5 | Reactions inline as `{uid:emoji}` maps -> one listener per channel not per message; brief unread capped at `limit(50)`; leaderboard computed server-side; model calls degrade to free deterministic paths. Documented perf at ~65 users. | Leaderboard does a full `xpEvents` collection scan each call (fine at cohort scale, O(events) at growth); no caching/materialized rollups; single Firestore project. |
| 10 | Guardrails & safety | 5/5 | The centerpiece. Ledger is client-unwritable (`firestore.rules`); no self-award / no client status-flip (`recognition-admin.ts`); idempotent awards via deterministic ids; webhook HMAC-verified constant-time (`lib/webhook.ts`); model output validated; the model has *no* awarding/posting tool; membership + private-thread isolation proven by rules tests; "be kind to the quiet" (no public shame) enforced in code. | Rate limiting is in-memory per-instance (`lib/rate-guard.ts`), not distributed; shared-bus rules are deny-all but the shared project is not yet stood up. |
| 11 | Product layer | 5/5 | `docs/PRD.md`: personas, JTBD, success metrics with a north star and counter-metrics, explicit tradeoffs/non-goals, Now/Next/Later. Product judgment visible in the design (peer-confirm, kind leaderboard, degrade-first). | Metrics are defined but not yet instrumented in a dashboard; single-cohort validation only. |
| 12 | FDE journey | 4/5 | `docs/FDE_JOURNEY.md`: config-gated integrations (Anthropic, GitHub, shared bus) all optional and degradable; secrets server-only; signed webhook; emulator-based rollout; health probe. The cross-app bus is the real enterprise story (every tool ships an agent; they must cooperate on shared state). | Deployed to one cohort, no external customer cutover yet; observability is logs + a health route, not full tracing/metrics. |

**Aggregate: 47/60.** Strongest on guardrails, code quality, and product; the honest gaps are a
formal eval harness, dynamic/cost-aware routing, and scale beyond a single cohort.

## Model and orchestration details

- **Single wrapper** (`lib/agent.ts`): `callClaudeDetailed`/`callClaude` return the metered result
  or `null`, missing `ANTHROPIC_API_KEY` or any exception (rate limit, timeout, bad key, malformed
  response) all collapse to `null`, so callers have exactly one degradation path.
- **One Conduit seam** (`lib/conduit/rally-client.ts`): detection, the Ask summary, and the
  assistant call the wrapper through an embedded `@conduit/client` core (`inferViaConduit`,
  `runAgentViaConduit`), which wraps Rally's own model call and BM25 retrieval, so the answers flow
  through a unified interface with no network hop and unchanged cost accounting. An env-gated
  reporter (`lib/conduit/reporter.ts`) mirrors each metered decision to a Conduit gateway when
  `CONDUIT_GATEWAY_URL`/`CONDUIT_GATEWAY_TOKEN` are set (a NO-OP otherwise, pre-caught, non-blocking).
  Conduit's `evaluate` surface is **not enabled** in embedded mode (a stub that throws); only
  `infer`, `retrieve`, and `runAgent` are used.
- **Sampling contract** (`supportsSampling`): the reasoning tiers (`claude-sonnet-5`,
  `claude-opus-4-8`, ...) reject sampling params with a 400, so `temperature` is omitted for them and
  determinism comes from the grounded prompt; only `claude-haiku-4-5` is sent `temperature: 0`. The
  valid Haiku id is `claude-haiku-4-5` (there is no `claude-haiku-5`).
- **Model tiers** (`MODELS`): a cost-aware cascade wired on the bulk detection path
  (`detectRecognitionsSmart`). The cheap `claude-haiku-4-5` tier runs the bulk, low-stakes
  recognition extract; `claude-sonnet-5` is the interactive default for the assistant and Ask; and
  `claude-opus-4-8` is the `escalate` tier, invoked automatically for a single re-read when the
  cheap tier returns a candidate below `CONFIDENCE_THRESHOLD`. Every call is metered
  (`recordUsage`) so per-feature token/USD spend is visible, including the `detect-escalate` line.
- **Untrusted-output discipline:** `extractJson` parses model output out of prose/fences and
  runs a type guard before the value is used. Detection additionally drops unknown `kind`s and
  normalizes handles. The model reads attacker-controllable message text, so its output is never
  trusted structurally.
- **Bounded agent loop:** the Home assistant is a reason-act loop on the vendored `@conduit/agent`
  `runAgent` (`lib/assistant-agent.ts`), capped at `MAX_AGENT_STEPS = 6`; safe tools execute
  server-side, propose tools return typed `Proposal`s and never execute, and the loop runs with
  `allowSideEffects: false` (the `remember` write tool is excluded) so no side-effecting tool can run.

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
   posts, or confirms, the loop runs `allowSideEffects: false`, and the read-only MCP surface
   (`lib/mcp/`) exposes no write tool and refuses an unbound identity; a drafted recognition still
   needs peer confirmation.

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
