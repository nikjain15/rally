# Rally MCP server

Rally exposes a small, **read-only** Model Context Protocol surface built on the
vendored `@conduit/mcp` (see `lib/conduit/VENDOR.md`). An MCP client such as
Claude Desktop or an IDE can read a channel the caller belongs to and the
caller's own peer recognitions. It cannot post, suggest, confirm, or award
anything: the server exposes no write tool, so it inherits Rally's authority
model. The AI classifies, summarises, and drafts; it never writes a
points-bearing row, and this surface has even less power than a signed-in user.

## Tools

Exactly two, both read-only:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search_channel` | `channelId` (string, required), `query` (string, required), `limit` (int 1..50, default 12) | BM25-ranked matching messages from that channel |
| `get_recognitions` | `status` (`suggested`\|`confirmed`\|`declined`, optional), `limit` (int 1..100, default 25) | The bound identity's peer recognitions (as helper or helped peer) |

Arguments are validated against a typed JSON Schema by the registry before a
handler runs. Invalid arguments return a structured `invalid_arguments` error
result; an unknown tool returns `unknown_tool`. The registry never throws for
these expected failures.

## Authorization

Two layers, both fail-closed:

- **Identity.** Every read runs through an injected reader bound to a verified
  Rally uid. With no verified identity bound, the reader is `authorized: false`
  and every tool returns `auth required` and touches no data.
- **Membership / ownership.** `search_channel` returns nothing unless the bound
  identity is a member of the channel; `get_recognitions` is scoped to the
  identity as helper or helped peer.

The bearer-token check a hosted deployment would sit behind is written and unit
tested today: `authorizeBearer` compares against `MCP_AUTH_TOKEN` and is closed
by default when no token is configured (`lib/mcp/rally-server.ts`,
`tests/unit/conduit-mcp.test.ts`). No hosted deployment currently calls it; see
the roadmap section below.

## Running it: stdio is the only runnable transport today

```bash
# One-time: npm i -D @modelcontextprotocol/sdk tsx
RALLY_MCP_UID=<verified-rally-uid> npm run mcp:stdio
```

This is the entry a local client (Claude Desktop, the MCP inspector) attaches
to, and it is the only transport you can run against Rally right now.

`@modelcontextprotocol/sdk` is **not** currently a dependency in
`package.json`. The transport wrappers import it dynamically at call time, and
they typecheck offline only because `lib/conduit/mcp/sdk-shim.d.ts` declares a
narrow ambient subset of its API. Install the real SDK (and `tsx`) before
running `npm run mcp:stdio`, or the dynamic import fails at startup. The pure
tool and registry logic underneath is exercised by the unit tests without the
SDK.

With `RALLY_MCP_UID` unset an unbound reader is served, so every tool returns an
auth error. The local OS process boundary is the trust boundary for stdio, so no
bearer token is required there.

## Roadmap: hosted HTTP/SSE (not deployed, not routed)

**Status: not shipped.** There is no `/sse` or `/messages` route anywhere in
`app/`, and nothing in the app imports the HTTP transport. Everything in this
section describes the intended shape, not behaviour you can hit today.

The vendored transport module `lib/conduit/mcp/http.ts` is written against the
SDK's SSE pair and is the starting point:

- a long-lived `GET` would open the event stream;
- a `POST` carrying `sessionId` would return client messages, correlated by the
  session map the module already keeps.

To make it real, three things are needed:

1. Add `@modelcontextprotocol/sdk` to `package.json` dependencies, so the
   dynamic import in `lib/conduit/mcp/http.ts` resolves and the `sdk-shim.d.ts`
   fallback stops being load-bearing.
2. Create the two route handlers, for example
   `app/api/mcp/sse/route.ts` and `app/api/mcp/messages/route.ts`, delegating to
   `createSseHandler`.
3. Front them with
   `authorizeBearer(req.headers.authorization, process.env.MCP_AUTH_TOKEN)` and
   bind `liveReader(verifiedUid)` per session, deriving the uid from the
   caller's verified Firebase identity exactly as the app's routes do.
