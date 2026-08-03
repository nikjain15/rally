#!/usr/bin/env node
/**
 * Rally's cost model. docs/COST.md.
 *
 * WHY A SCRIPT AND NOT A TABLE IN A DOC. A number typed into a markdown file is true on the day
 * it is typed. This reads the ACTUAL pricing table and the ACTUAL system prompt out of the
 * source, so if a tier is repriced or the prompt grows, the model moves with it and the doc is
 * regenerated rather than remembered. `npm run cost:model -- --check` fails if docs/COST.md has
 * drifted from what the code now implies, which is what keeps the two honest.
 *
 * WHAT IS MEASURED AND WHAT IS ESTIMATED, stated plainly because the difference decides how much
 * the output is worth:
 *
 *   MEASURED from source   the system prompt's exact character length; both model ids; the
 *                          per-million-token prices in lib/agent.ts.
 *   ESTIMATED              token counts, via characters / 4. This is an approximation, not a
 *                          measurement. Anthropic's tokenizer is not available offline and the
 *                          count-tokens endpoint needs a key.
 *   ASSUMED                message volume and the cache hit rate. Both are inputs, not findings.
 *
 * The estimate is the weak link and it is deliberately loud about it. To replace it with real
 * numbers, run Rally with a key: every call already records true input and output token counts
 * through `recordUsage` in lib/agent.ts, and `--tokens-from` below will read a metered sample
 * instead of estimating. Until then, treat every dollar figure here as an order of magnitude.
 *
 * Usage:
 *   node scripts/cost-model.mjs                 print the model
 *   node scripts/cost-model.mjs --json          machine-readable
 *   node scripts/cost-model.mjs --check         fail if docs/COST.md is stale
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Characters per token. A rough English-prose constant, and the largest source of error here. */
export const CHARS_PER_TOKEN = 4;

/**
 * The scenario. Every one of these is an ASSUMPTION about how Rally gets used, not a measurement,
 * and each is chosen to be defensible rather than flattering.
 *
 * `cacheHitRate` is the one to argue with. 0.35 is deliberately conservative for a cohort chat,
 * where "thanks!", "nice work" and "+1" repeat constantly and every message that credits nobody
 * (the large majority) shares the same empty reading. It is an assumption until the counters in
 * lib/detect-cache.ts report a real number from production. If the true rate is higher, the
 * cached column below is pessimistic.
 */
export const SCENARIO = {
  members: 30,
  messagesPerMemberPerDay: 12,
  /** Share of messages whose exact text has been seen before by this process. ASSUMED. */
  cacheHitRate: 0.35,
  /** Share of messages the cheap tier reads as ambiguous, triggering one Opus call. ASSUMED. */
  escalationRate: 0.08,
  /** Typical message length in characters. ASSUMED. */
  messageChars: 120,
  /** maxTokens on both detection calls, from lib/detect-model.ts. The ceiling, not the mean. */
  maxOutputTokens: 300,
  /** Output is far below the cap in practice: the reply is a short JSON array. ASSUMED. */
  typicalOutputTokens: 40,
  days: 30,
};

/** Pull a value out of a source file rather than restating it here, so drift is impossible. */
function fromSource(file, re, what) {
  const src = readFileSync(resolve(ROOT, file), 'utf8');
  const m = src.match(re);
  if (!m) {
    console.error(`cost-model: could not read ${what} from ${file}. The source moved; fix this script.`);
    process.exit(2);
  }
  return m;
}

/** The real prices, read out of lib/agent.ts. */
export function readPricing() {
  const src = readFileSync(resolve(ROOT, 'lib/agent.ts'), 'utf8');
  const out = {};
  const re = /'(claude-[\w.-]+)':\s*\{\s*inputPerMTok:\s*([\d.]+),\s*outputPerMTok:\s*([\d.]+)\s*\}/g;
  let m;
  while ((m = re.exec(src))) out[m[1]] = { inputPerMTok: Number(m[2]), outputPerMTok: Number(m[3]) };
  if (!Object.keys(out).length) {
    console.error('cost-model: MODEL_PRICING in lib/agent.ts did not parse. Fix this script.');
    process.exit(2);
  }
  return out;
}

/** The real system prompt length, read out of lib/detect-model.ts. */
export function readSystemPromptChars() {
  const src = readFileSync(resolve(ROOT, 'lib/detect-model.ts'), 'utf8');
  const m = src.match(/const DETECT_SYSTEM =\s*([\s\S]*?);\n/);
  if (!m) {
    console.error('cost-model: DETECT_SYSTEM did not parse from lib/detect-model.ts.');
    process.exit(2);
  }
  // Concatenated string literals: total the contents, ignoring the quotes and the + joins.
  return [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].reduce((n, s) => n + s[1].length, 0);
}

export function readModels() {
  const m = fromSource(
    'lib/agent.ts',
    /brief:\s*'([\w.-]+)',\s*\n\s*default:\s*'([\w.-]+)',\s*\n\s*escalate:\s*'([\w.-]+)'/,
    'MODELS'
  );
  return { brief: m[1], default: m[2], escalate: m[3] };
}

const tokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

export function computeModel(scenario = SCENARIO) {
  const pricing = readPricing();
  const models = readModels();
  const systemChars = readSystemPromptChars();

  const inputTokensPerCall = tokens(systemChars + scenario.messageChars);
  const outputTokens = scenario.typicalOutputTokens;

  const priceOf = (model) => {
    const p = pricing[model];
    if (!p) {
      console.error(`cost-model: no price for ${model}. Add it to MODEL_PRICING.`);
      process.exit(2);
    }
    return (inputTokensPerCall / 1e6) * p.inputPerMTok + (outputTokens / 1e6) * p.outputPerMTok;
  };

  const briefCost = priceOf(models.brief);
  const escalateCost = priceOf(models.escalate);

  const messagesPerDay = scenario.members * scenario.messagesPerMemberPerDay;

  // Every message pays for a cheap call; the ambiguous share also pays for an Opus call.
  const costPerUncachedMessage = briefCost + scenario.escalationRate * escalateCost;

  const uncachedPerDay = messagesPerDay * costPerUncachedMessage;
  const cachedPerDay = messagesPerDay * (1 - scenario.cacheHitRate) * costPerUncachedMessage;

  return {
    models,
    pricing,
    systemChars,
    inputTokensPerCall,
    outputTokens,
    messagesPerDay,
    perCall: { brief: briefCost, escalate: escalateCost },
    costPerUncachedMessage,
    uncached: { perDay: uncachedPerDay, perPeriod: uncachedPerDay * scenario.days },
    cached: { perDay: cachedPerDay, perPeriod: cachedPerDay * scenario.days },
    savedPerPeriod: (uncachedPerDay - cachedPerDay) * scenario.days,
    /** What the whole cascade buys versus routing everything to the strong tier. */
    allEscalatePerDay: messagesPerDay * escalateCost,
    scenario,
  };
}

const usd = (n) => (n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(2)}`);

function main() {
  const args = process.argv.slice(2);
  const r = computeModel();

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }

  const s = r.scenario;
  console.log('\nRally cost model');
  console.log('================');
  console.log(`Read from source : ${r.models.brief} (bulk), ${r.models.escalate} (escalate)`);
  console.log(`System prompt    : ${r.systemChars} chars -> ~${tokens(r.systemChars)} tokens (ESTIMATED, chars/${CHARS_PER_TOKEN})`);
  console.log(`Per call         : ~${r.inputTokensPerCall} in, ~${r.outputTokens} out`);
  console.log(`  ${r.models.brief.padEnd(20)} ${usd(r.perCall.brief)} per call`);
  console.log(`  ${r.models.escalate.padEnd(20)} ${usd(r.perCall.escalate)} per call  (${(r.perCall.escalate / r.perCall.brief).toFixed(0)}x)`);
  console.log(`\nScenario (ASSUMED): ${s.members} members x ${s.messagesPerMemberPerDay} msgs = ${r.messagesPerDay} messages/day`);
  console.log(`                    ${(s.escalationRate * 100).toFixed(0)}% escalate, ${(s.cacheHitRate * 100).toFixed(0)}% cache hit rate`);
  console.log('\n| Scenario | Model calls/day | Cost/day | Over ' + s.days + ' days |');
  console.log('|---|---|---|---|');
  const uncachedCalls = r.messagesPerDay * (1 + s.escalationRate);
  const cachedCalls = uncachedCalls * (1 - s.cacheHitRate);
  console.log(`| Everything on ${r.models.escalate} | ${Math.round(r.messagesPerDay)} | ${usd(r.allEscalatePerDay)} | ${usd(r.allEscalatePerDay * s.days)} |`);
  console.log(`| Cascade, no cache | ${Math.round(uncachedCalls)} | ${usd(r.uncached.perDay)} | ${usd(r.uncached.perPeriod)} |`);
  console.log(`| Cascade + cache | ${Math.round(cachedCalls)} | ${usd(r.cached.perDay)} | ${usd(r.cached.perPeriod)} |`);
  console.log(`\nCascade saves ${usd(r.allEscalatePerDay * s.days - r.uncached.perPeriod)} over ${s.days} days versus all-Opus.`);
  console.log(`Cache saves a further ${usd(r.savedPerPeriod)}.`);
  console.log('\nTOKEN COUNTS ARE ESTIMATED (chars/4), not measured. Every dollar figure above is an');
  console.log('order of magnitude. Volume and cache hit rate are assumptions, not findings.');
  console.log('Run Rally with a key and read recordUsage in lib/agent.ts for metered numbers.\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
