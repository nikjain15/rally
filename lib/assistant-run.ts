import Anthropic from '@anthropic-ai/sdk';
import type { Firestore } from 'firebase-admin/firestore';
import { MODELS } from './agent';
import { ASSISTANT_TOOLS, isProposeTool, isSafeTool, toProposal, type Proposal } from './assistant';
import { loadMemory, loadThread, runSafeTool, saveTurn } from './assistant-admin';

/**
 * The bounded Claude tool-use loop for the Home assistant. Lives in lib (not the route) so the
 * model SDK stays out of app/ — the loop reads only what the caller could already read, executes
 * SAFE tools server-side, turns write-tools into proposals for the user to confirm, and persists
 * the exchange to the user's private thread. The model has no authority; it drafts, never acts.
 */
const MAX_STEPS = 5;

export type AssistantResult = { available: boolean; reply: string | null; proposals: Proposal[] };

function systemPrompt(memory: string[]): string {
  const base = [
    'You are Rally, a warm, concise assistant that lives inside the Rally cohort app.',
    'You help the user talk to their cohort, recognize teammates who help them, and keep the commitments they make.',
    '',
    'Rules you never break:',
    '- You are always "Rally". Never call yourself a model, a bot, or any brand.',
    '- You can READ what the user could already read, and DRAFT actions. You never award points, never post as the user, and never confirm a recognition. Those are proposals the user confirms with one tap.',
    '- Recognition is peer-confirmed: proposing it only lets the helped teammate confirm later. You cannot grant points.',
    '- Be kind. Never shame anyone. Missing a commitment is never punished.',
    '- Prefer calling a tool over guessing. For "what did I miss / what\'s up", use catch_me_up.',
    '- Keep replies short and human. When you draft something, tell the user it is waiting for their confirm.',
  ];
  if (memory.length) {
    base.push('', 'What you remember about this user:', ...memory.map((n) => `- ${n}`));
  }
  return base.join('\n');
}

export async function runAssistant(
  db: Firestore,
  uid: string,
  message: string,
  nowMs: number,
): Promise<AssistantResult> {
  const [history, memory] = await Promise.all([loadThread(db, uid), loadMemory(db, uid)]);
  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  const proposals: Proposal[] = [];
  let finalText = '';

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await client.messages.create({
        model: MODELS.default,
        max_tokens: 1024,
        system: systemPrompt(memory),
        tools: ASSISTANT_TOOLS as unknown as Anthropic.Tool[],
        messages,
      });
      const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const textOut = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();
      if (textOut) finalText = textOut;

      if (res.stop_reason !== 'tool_use' || toolUses.length === 0) break;

      messages.push({ role: 'assistant', content: res.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const input = (tu.input ?? {}) as Record<string, unknown>;
        if (isSafeTool(tu.name)) {
          const out = await runSafeTool(db, uid, tu.name, input, nowMs);
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
        } else if (isProposeTool(tu.name)) {
          const p = toProposal(tu.name, input);
          if (p) proposals.push(p);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: p ? 'Drafted and shown to the user to confirm.' : 'Could not draft that.',
          });
        } else {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Unknown tool.' });
        }
      }
      messages.push({ role: 'user', content: toolResults });
    }
  } catch {
    return { available: false, reply: null, proposals: [] };
  }

  if (!finalText) finalText = proposals.length ? "Here's what I drafted — confirm below to go ahead." : 'Done.';
  await saveTurn(db, uid, message, finalText, proposals, nowMs);
  return { available: true, reply: finalText, proposals };
}
