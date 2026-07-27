/**
 * Local chat primitive for the vendored @conduit/agent loop.
 *
 * Upstream, `loop.ts` imports `ChatMessage` from `@conduit/inference`'s core. Rally
 * does not vendor the inference package (it injects its own model call), so this file
 * re-exports the same structural shape the vendored client already defines. Keeping it
 * here means the agent copy resolves locally with a one-line import adjustment and no
 * dependency on a package Rally never installs. See VENDOR.md.
 */
export type { ChatMessage, ChatRole } from '../client/types';
