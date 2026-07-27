import type { ConduitTool, JsonSchema, ToolResult } from '@/lib/conduit/mcp';

/**
 * Rally's Model Context Protocol tools (see lib/conduit/VENDOR.md, docs/MCP.md).
 *
 * These are READ-ONLY. An MCP client (Claude Desktop, an IDE) can read a channel
 * the caller belongs to and the caller's own peer recognitions, but the server
 * exposes NO tool that writes: it cannot post a message, suggest or confirm a
 * recognition, or touch the append-only points ledger. That mirrors Rally's
 * whole authority model (the AI classifies/summarises/drafts and never writes a
 * points-bearing row), and the MCP surface has even less power: it only reads
 * what the bound identity could already read.
 *
 * Auth is honoured exactly as the app honours it. A read runs through an
 * injected `reader` that the transport binds to a verified identity. With no
 * verified identity bound (`authorized === false`), every tool returns an
 * explicit "auth required" result and touches no data. The pure `ToolRegistry`
 * below needs no Firestore and no SDK, so it is unit-testable on its own.
 */

/** One channel-search hit returned to an MCP client. */
export interface ChannelHit {
  author: string;
  body: string;
}

export interface SearchChannelResult {
  channelId: string;
  count: number;
  matches: ChannelHit[];
}

export interface SearchChannelArgs {
  channelId: string;
  query: string;
  limit?: number;
}

/** One recognition returned to an MCP client (never points-bearing on its own). */
export interface RecognitionHit {
  id: string;
  helperUid: string;
  helpedUid: string;
  kind: string;
  points: number;
  status: string;
}

export interface GetRecognitionsResult {
  count: number;
  recognitions: RecognitionHit[];
}

export interface GetRecognitionsArgs {
  status?: string;
  limit?: number;
}

/**
 * The read surface the tools call. The transport binds this to a verified
 * caller; a request with no verified identity gets `authorized: false` and no
 * data. Both reads honour Rally's membership/ownership boundary inside the
 * implementation (search is scoped to a channel the caller is a member of;
 * recognitions are scoped to the caller as helper or helped peer).
 */
export interface RallyReader {
  authorized: boolean;
  searchChannel: (args: SearchChannelArgs) => Promise<SearchChannelResult>;
  getRecognitions: (args: GetRecognitionsArgs) => Promise<GetRecognitionsResult>;
}

const text = (s: string, structured?: unknown): ToolResult => ({
  content: [{ type: 'text', text: s }],
  ...(structured !== undefined ? { structuredContent: structured } : {}),
});

const unauthorized = (): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: 'auth required: no verified Rally identity is bound to this session' }],
});

const searchChannelSchema: JsonSchema = {
  type: 'object',
  properties: {
    channelId: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'The channel to search. The bound identity must be a member of it.',
    },
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 4000,
      description: 'Natural-language query; matched against channel messages with BM25.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Max matching messages to return (default 12).',
    },
  },
  required: ['channelId', 'query'],
  additionalProperties: false,
};

const getRecognitionsSchema: JsonSchema = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['suggested', 'confirmed', 'declined'],
      description: 'Optional status filter.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max recognitions to return (default 25).',
    },
  },
  additionalProperties: false,
};

/** Build the read-only Rally MCP tools over an injected, auth-bound reader. */
export function rallyMcpTools(reader: RallyReader): ConduitTool[] {
  const searchChannel: ConduitTool<SearchChannelArgs> = {
    name: 'search_channel',
    description:
      "Search one Rally channel's messages with BM25 and return the most relevant matches. " +
      'Read-only. Honours Rally membership: returns nothing unless a verified identity is bound ' +
      'AND that identity is a member of the channel.',
    inputSchema: searchChannelSchema,
    handler: async (args): Promise<ToolResult> => {
      if (!reader.authorized) return unauthorized();
      const result = await reader.searchChannel({
        channelId: args.channelId,
        query: args.query,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      const lines = result.matches.map((m) => `${m.author}: ${m.body}`);
      return text(lines.join('\n') || '(no matching messages)', result);
    },
  };

  const getRecognitions: ConduitTool<GetRecognitionsArgs> = {
    name: 'get_recognitions',
    description:
      'List the peer recognitions the bound identity is party to (as helper or helped peer), ' +
      'newest first, with kind, points and status. Read-only over the recognition ledger: this ' +
      'tool never suggests, confirms, or awards anything. Honours Rally auth: returns nothing ' +
      'unless a verified identity is bound.',
    inputSchema: getRecognitionsSchema,
    handler: async (args): Promise<ToolResult> => {
      if (!reader.authorized) return unauthorized();
      const result = await reader.getRecognitions({
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      const lines = result.recognitions.map(
        (r) => `${r.status} ${r.kind} (+${r.points}) ${r.helperUid} -> ${r.helpedUid}`,
      );
      return text(lines.join('\n') || '(no recognitions)', result);
    },
  };

  // The registry stores tools with the default arg type; each handler validated
  // its own typed args above, so narrow back to the registry's tool type.
  return [searchChannel as unknown as ConduitTool, getRecognitions as unknown as ConduitTool];
}
