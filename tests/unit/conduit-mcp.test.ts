import { describe, it, expect } from 'vitest';
import { buildMcpServer, type McpRequest, type McpServerLike } from '@/lib/conduit/mcp';
import { authorizeBearer, createRallyRegistry } from '@/lib/mcp/rally-server';
import { rallyMcpTools, type RallyReader } from '@/lib/mcp/rally-tools';

/**
 * End-to-end proof for the Rally MCP server: the registry lists EXACTLY the two
 * read-only tools, a `tools/call` returns a valid CallToolResult, an unbound
 * identity is refused, and bad arguments are rejected by validation before the
 * handler runs (a structured error, never a throw). Uses `buildMcpServer` with a
 * fake SDK server that captures the two request handlers, so no MCP SDK and no
 * transport are needed.
 */

const LIST = Symbol('list');
const CALL = Symbol('call');

/** A fake SDK server that records handlers by the schema they were registered with. */
function fakeServer() {
  const handlers = new Map<unknown, (req: McpRequest) => Promise<unknown> | unknown>();
  const server: McpServerLike = {
    setRequestHandler(schema, handler) {
      handlers.set(schema, handler);
    },
  };
  return {
    server,
    list: () => handlers.get(LIST)!({} as McpRequest),
    call: (name: string, args: unknown) => handlers.get(CALL)!({ params: { name, arguments: args } }),
  };
}

const authorizedReader: RallyReader = {
  authorized: true,
  searchChannel: async (args) => ({
    channelId: args.channelId,
    count: 1,
    matches: [{ author: 'alice', body: 'we decided to ship on friday' }],
  }),
  getRecognitions: async () => ({
    count: 1,
    recognitions: [{ id: 'r1', helperUid: 'u2', helpedUid: 'u1', kind: 'answered', points: 8, status: 'confirmed' }],
  }),
};

const unboundReader: RallyReader = {
  authorized: false,
  searchChannel: async () => {
    throw new Error('must not read: identity is unbound');
  },
  getRecognitions: async () => {
    throw new Error('must not read: identity is unbound');
  },
};

function harness(reader: RallyReader) {
  const registry = createRallyRegistry(reader);
  const fake = fakeServer();
  buildMcpServer(fake.server, registry, { listSchema: LIST, callSchema: CALL });
  return fake;
}

describe('rally mcp server · list + call', () => {
  it('lists EXACTLY the two read-only tools with typed schemas', async () => {
    const { tools } = (await harness(authorizedReader).list()) as {
      tools: Array<{ name: string; inputSchema: { required?: string[] } }>;
    };
    const names = tools.map((t) => t.name);
    // Sorted by name; exactly two, both read-only.
    expect(names).toEqual(['get_recognitions', 'search_channel']);
    const search = tools.find((t) => t.name === 'search_channel')!;
    expect(search.inputSchema.required).toEqual(['channelId', 'query']);
  });

  it('exposes no write tool (read-only surface only)', () => {
    const names = rallyMcpTools(authorizedReader).map((t) => t.name);
    for (const forbidden of ['post_message', 'suggest_recognition', 'confirm_recognition', 'award']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('search_channel returns a valid, non-error result with structured content', async () => {
    const res = (await harness(authorizedReader).call('search_channel', {
      channelId: 'c1',
      query: 'shipping decision',
      limit: 5,
    })) as { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent: { count: number } };
    expect(res.isError).toBeFalsy();
    expect(res.content[0].type).toBe('text');
    expect(res.structuredContent.count).toBe(1);
    expect(res.content[0].text).toContain('alice');
  });

  it('get_recognitions returns the caller-scoped recognitions', async () => {
    const res = (await harness(authorizedReader).call('get_recognitions', {})) as {
      isError?: boolean;
      structuredContent: { recognitions: Array<{ status: string }> };
    };
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.recognitions[0].status).toBe('confirmed');
  });

  it('refuses an unbound identity with an auth error and reads no data', async () => {
    for (const tool of ['search_channel', 'get_recognitions']) {
      const args = tool === 'search_channel' ? { channelId: 'c1', query: 'x' } : {};
      const res = (await harness(unboundReader).call(tool, args)) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('auth required');
    }
  });

  it('rejects invalid arguments before the handler runs (structured error, never a throw)', async () => {
    const res = (await harness(authorizedReader).call('search_channel', { channelId: 'c1', limit: 999 })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError).toBe(true);
    // Missing required `query` and out-of-range `limit` are both reported.
    expect(res.content[0].text).toContain('invalid_arguments');
  });

  it('reports an unknown tool as an error result, never a throw', async () => {
    const res = (await harness(authorizedReader).call('send_email', {})) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('unknown_tool');
  });
});

describe('rally mcp server · transport authorization', () => {
  it('accepts a matching bearer token and rejects everything else', () => {
    expect(authorizeBearer('Bearer secret-123', 'secret-123')).toBe(true);
    expect(authorizeBearer('Bearer wrong', 'secret-123')).toBe(false);
    expect(authorizeBearer(undefined, 'secret-123')).toBe(false);
    // Closed by default: no configured token means no access.
    expect(authorizeBearer('Bearer secret-123', undefined)).toBe(false);
  });
});
