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

For a hosted deployment, the transport additionally gates on a shared bearer
token (`authorizeBearer` against `MCP_AUTH_TOKEN`), closed by default when no
token is configured.

## Running locally (stdio)

```bash
# Requires @modelcontextprotocol/sdk and tsx installed (optional, dev-only).
RALLY_MCP_UID=<verified-rally-uid> npm run mcp:stdio
```

With `RALLY_MCP_UID` unset an unbound reader is served, so every tool returns an
auth error. The local OS process boundary is the trust boundary for stdio, so no
bearer token is required there.

## Hosted (HTTP/SSE)

The vendored transport (`lib/conduit/mcp/http.ts`) exposes an SSE pair:

- `GET  https://<host>/sse` opens the event stream.
- `POST https://<host>/messages?sessionId=<id>` carries client messages back.

Front it with `authorizeBearer(req.headers.authorization, process.env.MCP_AUTH_TOKEN)`
and bind `liveReader(verifiedUid)` per session, deriving the uid from the caller's
verified Firebase identity exactly as the app's routes do.
