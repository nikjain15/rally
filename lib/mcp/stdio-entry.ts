/**
 * Stdio entry for the Rally MCP server, for local clients (Claude Desktop, the
 * MCP inspector). Run with `npm run mcp:stdio`.
 *
 * This is a standalone script: the Next app never imports it, so it is not part
 * of the app bundle. It requires `@modelcontextprotocol/sdk` to be installed
 * (the vendored transport imports it at call time); the pure tool + registry
 * logic it serves is exercised by tests without the SDK. See docs/MCP.md.
 *
 * Identity binding: the local caller's Rally uid comes from `RALLY_MCP_UID`. With
 * it unset, an UNBOUND reader (`authorized: false`) is served, so every tool
 * returns an auth error and never reads data, the same refusal the tests pin.
 */
import { startStdioServer } from '@/lib/conduit/mcp';
import { liveReader, RALLY_MCP_INFO } from './rally-server';
import { rallyMcpTools } from './rally-tools';

async function main(): Promise<void> {
  const uid = process.env.RALLY_MCP_UID ?? null;
  await startStdioServer({
    name: RALLY_MCP_INFO.name,
    version: RALLY_MCP_INFO.version,
    tools: rallyMcpTools(liveReader(uid)),
  });
  // Connected; the process now serves requests until the transport closes.
}

main().catch((err) => {
  console.error('rally-mcp stdio server failed to start:', err);
  process.exit(1);
});
