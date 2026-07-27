import type { Firestore } from 'firebase-admin/firestore';
import { busDb } from './admin';
import type { Proposal } from './assistant';
import { getHandle, loadMemory, loadThread, saveTurn } from './assistant-admin';
import { logSharedActivity, readSharedMemory } from './shared-context';
import type { ChatMessage } from './conduit/agent/core';
import {
  ASSISTANT_SKILLS,
  MAX_AGENT_STEPS,
  assistantSystemPrompt,
  buildAssistantTools,
  buildCallModel,
} from './assistant-agent';
import { runAgentViaConduit } from './conduit/rally-client';

/**
 * The Home assistant, run as a genuine bounded reason-act loop on the vendored `@conduit/agent`
 * `runAgent`. Lives in lib (not the route) so the model path stays out of app/. The loop reads only
 * what the caller could already read, drafts actions the user confirms, and has NO authority: it
 * never awards points, never posts as the user, and runs with `allowSideEffects: false` so no
 * side-effecting tool can execute. The model classifies, summarises, and drafts; it never acts.
 *
 * Every model step is routed through the embedded @conduit/client seam (buildCallModel →
 * inferViaConduit), so the loop stays metered and gateway-reported on the same tier cascade the
 * rest of Rally uses. The whole path still degrades gracefully: with no model key the underlying
 * call returns null and the loop ends with a safe fallback.
 */
export type AssistantResult = { available: boolean; reply: string | null; proposals: Proposal[] };

export async function runAssistant(
  db: Firestore,
  uid: string,
  message: string,
  nowMs: number,
): Promise<AssistantResult> {
  const [history, localMemory, handle] = await Promise.all([loadThread(db, uid), loadMemory(db, uid), getHandle(db, uid)]);
  // Merge app-local memory with the shared cross-app memory so the assistant carries one history.
  const shared = handle ? await readSharedMemory(busDb() ?? db, handle) : [];
  const memory = [...localMemory, ...shared.map((n) => `[${n.app}] ${n.text}`)];
  const priorTurns: ChatMessage[] = history.map((m) => ({ role: m.role, content: m.content }));

  const proposals: Proposal[] = [];
  let finalText = '';

  try {
    const tools = buildAssistantTools({ db, uid, nowMs, handle, proposals });
    const callModel = buildCallModel({ feature: 'assistant' });
    const result = await runAgentViaConduit(
      {
        tools,
        skills: ASSISTANT_SKILLS,
        callModel,
        maxSteps: MAX_AGENT_STEPS,
        system: assistantSystemPrompt(memory, priorTurns),
        context: message,
        allowSideEffects: false, // no-authority invariant: side-effecting tools are refused by default.
      },
      message,
    );
    finalText = (result.answer ?? '').trim();
  } catch {
    return { available: false, reply: null, proposals: [] };
  }

  if (!finalText) finalText = proposals.length ? "Here's what I drafted. Confirm below to go ahead." : 'Done.';
  await saveTurn(db, uid, message, finalText, proposals, nowMs);

  // Record the interaction on the shared bus so the user's cross-app history is complete. We log a
  // concise summary (the request plus what was drafted), never the full model output: data
  // minimization. Best-effort: a bus hiccup must never fail the turn.
  if (handle) {
    const drafted = proposals.length ? ` · drafted ${proposals.map((p) => p.kind).join(', ')}` : '';
    const summary = `asked: "${message.slice(0, 120)}"${drafted}`;
    try {
      await logSharedActivity(busDb() ?? db, handle, 'assistant', summary, nowMs);
    } catch {
      /* history is best-effort */
    }
  }
  return { available: true, reply: finalText, proposals };
}
