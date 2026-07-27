# Vendored Conduit

These files are a **copy** (not a fork, not a submodule) of the public Conduit
packages, taken from their published `src/`:

- `client/` = `@conduit/client` (`packages/client/src`)
- `mcp/` = `@conduit/mcp` (`packages/mcp/src`)

Upstream: https://github.com/nikjain15/conduit

## Why vendored

Conduit is a thin, dependency-light SDK. Rally needs a stable, in-tree copy so
the app builds and tests without an external workspace or a private registry.
The sources are self-contained: `@conduit/client` has zero runtime dependencies
(the caller injects the core functions or `fetch`), and `@conduit/mcp`'s registry
and validator are pure. Only the MCP transport wrappers (`mcp/server.ts`,
`mcp/stdio.ts`, `mcp/http.ts`) touch `@modelcontextprotocol/sdk`, and only at
call time via dynamic `import()`; `mcp/sdk-shim.d.ts` provides compile-time types
so the tree typechecks without the SDK installed.

## Local resolution

Imports inside each package are relative (`./types`, `./registry.ts`), so the
copies resolve locally with no path rewriting. Rally code imports them as
`@/lib/conduit/client` and `@/lib/conduit/mcp`.

## Updating

Re-copy the upstream `src/` over these directories. Keep the change to a plain
copy: do not edit vendored files in place, so a refresh stays a clean overwrite.
Rally-specific wiring (the embedded core, the MCP tools and server, the gateway
usage reporter) lives OUTSIDE this directory, under `lib/conduit/rally-client.ts`,
`lib/conduit/reporter.ts`, and `lib/mcp/`.
