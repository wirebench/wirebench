/**
 * What a script sees of an MCP send and its answer (#79): the snapshots, the converters between a
 * resolved send and a snapshot, the declarations, the sandbox-side source, and what the script rules
 * check.
 *
 * The pre-request snapshot is the operation, which a script may change (the tool and its arguments,
 * the URI, the prompt and its arguments) but never its method. For the HTTP transports it holds the
 * server URL too, so core's origin rule holds: a script may change its path and query, never its
 * scheme, host or port. A stdio server's command line is not in the snapshot at all, so a script
 * can never change what the host approved.
 */
import { z } from 'zod';
import type { ProtocolScripting, SnapshotFacts } from '../protocol/module.js';
import type { ScriptFailure } from '../script/model.js';
import type { McpExchange } from './exchange.js';
import { mcpResultIsError, mcpServerInfo } from './history-entry.js';
import type { McpListMethod, McpMethod, McpOperation } from './model.js';
import type { McpResolvedInput } from './run.js';
import { mcpArgumentsEmpty } from './shape.js';
import { mcpScriptTypes } from './script-types.js';

const LIST_METHODS = ['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list'] as const;

/** What every MCP request snapshot holds beside its operation. */
interface McpSnapshotTarget {
  readonly protocol: 'mcp';
  /** How the session reaches its server; a script cannot change it. */
  readonly transport: 'stdio' | 'http' | 'sse';
  /** The server URL for the HTTP transports; empty for stdio, whose command line a script never sees. */
  readonly url: string;
}

/** The operation as a script sees it: a `tools/call`'s arguments as JSON, a prompt's as an object. */
export type McpOperationSnapshot =
  | { readonly method: McpListMethod }
  | { readonly method: 'tools/call'; readonly tool: string; readonly arguments: unknown }
  | { readonly method: 'resources/read'; readonly uri: string }
  | { readonly method: 'prompts/get'; readonly prompt: string; readonly arguments: Readonly<Record<string, string>> };

export type McpRequestSnapshot = McpSnapshotTarget & McpOperationSnapshot;

export interface McpResponseSnapshot {
  readonly protocol: 'mcp';
  readonly method: McpMethod;
  /** The operation's result; absent when the server answered with an error, or did not answer. */
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
  /** True for a `tools/call` result with `isError: true`. */
  readonly isError: boolean;
  /** The server's `serverInfo` from `initialize`, when it gave one. */
  readonly serverInfo?: { readonly name: string; readonly version: string };
  /** The JSON-RPC messages of the session, both ways, the ones it did not keep included. */
  readonly messageCount: number;
  readonly durationMs: number;
}

/** A call's arguments as a script sees them: parsed, `{}` when blank, the text itself when it is not JSON. */
function argumentsOf(text: string): unknown {
  if (mcpArgumentsEmpty(text)) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The snapshot of a resolved send: the operation, and the URL of an HTTP transport. */
export function mcpRequestSnapshot(input: Pick<McpResolvedInput, 'transport' | 'operation'>): McpRequestSnapshot {
  const { transport, operation } = input;
  const target: McpSnapshotTarget = {
    protocol: 'mcp',
    transport: transport.type,
    url: transport.type === 'stdio' ? '' : transport.url,
  };
  switch (operation.method) {
    case 'tools/call':
      return { ...target, method: operation.method, tool: operation.tool, arguments: argumentsOf(operation.arguments) };
    case 'resources/read':
      return { ...target, method: operation.method, uri: operation.uri };
    case 'prompts/get': {
      // A disabled row is not sent, and a later row wins over an earlier one, as the send reads them.
      const enabled = operation.arguments.filter((entry) => entry.enabled && entry.name !== '');
      return {
        ...target,
        method: operation.method,
        prompt: operation.prompt,
        arguments: Object.fromEntries(enabled.map((entry) => [entry.name, entry.value])),
      };
    }
    default:
      return { ...target, method: operation.method };
  }
}

/**
 * The send with a pre-request script's changes. The arguments are rewritten only when the script
 * changed them, so text it left alone is sent exactly as it was written; the URL likewise.
 */
export function applyMcpSnapshot(
  input: McpResolvedInput,
  before: McpRequestSnapshot,
  after: McpRequestSnapshot,
): McpResolvedInput {
  const transport =
    input.transport.type !== 'stdio' && after.url !== before.url
      ? { ...input.transport, url: after.url }
      : input.transport;
  const operation = ((): McpOperation => {
    const was = input.operation;
    if (after.method === 'tools/call' && was.method === 'tools/call' && before.method === 'tools/call') {
      const changed = JSON.stringify(after.arguments) !== JSON.stringify(before.arguments);
      return {
        method: was.method,
        tool: after.tool,
        arguments: changed ? (JSON.stringify(after.arguments, null, 2) ?? '') : was.arguments,
      };
    }
    if (after.method === 'resources/read' && was.method === 'resources/read') {
      return { method: was.method, uri: after.uri };
    }
    if (after.method === 'prompts/get' && was.method === 'prompts/get' && before.method === 'prompts/get') {
      const changed = JSON.stringify(after.arguments) !== JSON.stringify(before.arguments);
      return {
        method: was.method,
        prompt: after.prompt,
        arguments: changed
          ? Object.entries(after.arguments).map(([name, value]) => ({ name, value, enabled: true }))
          : was.arguments,
      };
    }
    return was;
  })();
  return { ...input, transport, operation };
}

/** The snapshot a post-response script sees of a finished send. */
export function mcpResponseSnapshot(exchange: McpExchange): McpResponseSnapshot {
  const serverInfo = mcpServerInfo(exchange);
  return {
    protocol: 'mcp',
    method: exchange.method,
    ...('result' in exchange ? { result: exchange.result } : {}),
    ...(exchange.error !== undefined ? { error: exchange.error } : {}),
    isError: mcpResultIsError(exchange.result),
    ...(serverInfo !== undefined ? { serverInfo } : {}),
    messageCount: exchange.messages.length + exchange.droppedMessages,
    durationMs: exchange.durationMs,
  };
}

/** The operation's fields, writable in a pre-request script and read-only after. */
const operationTypes = (prefix: string): string => `
  | { readonly method: 'tools/list' | 'resources/list' | 'resources/templates/list' | 'prompts/list' }
  | {
      readonly method: 'tools/call';
      /** The tool's name. */
      ${prefix}tool: string;
      /** The call's arguments, typed from the tool's \`inputSchema\` when the catalogue has it. */
      ${prefix}arguments: WbMcpArguments;
    }
  | { readonly method: 'resources/read'; ${prefix}uri: string }
  | {
      readonly method: 'prompts/get';
      /** The prompt's name. */
      ${prefix}prompt: string;
      /** The prompt's arguments, which are strings. */
      ${prefix}arguments: Record<string, string>;
    }`;

const MCP_REQUEST = `
interface WbMcpTarget {
  readonly transport: 'stdio' | 'http' | 'sse';
  /**
   * The server URL, for the HTTP transports; empty for stdio. A script may change the path and query,
   * never the scheme, host or port.
   */
  url: string;
}
/** A \`tools/call\` result, its \`structuredContent\` typed from the tool's \`outputSchema\` when the catalogue has it. */
interface WbMcpResult {
  readonly content?: readonly unknown[];
  readonly structuredContent?: WbMcpStructuredContent;
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}
`;

const MCP_PRE = `
/** Narrow on \`request.method\` to reach the operation's own fields. The method itself cannot change. */
declare const request: WbMcpTarget & (${operationTypes('')});
`;

const MCP_POST = `
declare const request: Readonly<WbMcpTarget> & (${operationTypes('readonly ')});
declare const response: {
  readonly method: string;
  /** The operation's result: absent when the server answered with an error, or never answered. */
  readonly result: WbMcpResult | undefined;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } | undefined;
  /** True for a \`tools/call\` result with \`isError: true\`. */
  readonly isError: boolean;
  readonly serverInfo: { readonly name: string; readonly version: string } | undefined;
  /** Every JSON-RPC message of the session, both ways. */
  readonly messageCount: number;
  readonly durationMs: number;
};
`;

const MCP = String.raw`
const mcpRequest = (snapshot, writable) => {
  const data = JSON.parse(JSON.stringify(snapshot));
  const refuse = (what) => { throw new TypeError('The ' + what + ' of a sent request cannot be changed'); };
  const fields = {
    'tools/call': ['tool', 'arguments'],
    'resources/read': ['uri'],
    'prompts/get': ['prompt', 'arguments'],
  }[data.method] ?? [];
  const request = {};
  Object.defineProperty(request, 'transport', { enumerable: true, get: () => data.transport });
  Object.defineProperty(request, 'method', {
    enumerable: true,
    get: () => data.method,
    set: () => { throw new TypeError('A script cannot change the method of an MCP request'); },
  });
  Object.defineProperty(request, 'url', {
    enumerable: true,
    get: () => data.url,
    set: (value) => { if (!writable) refuse('URL'); data.url = String(value); },
  });
  for (const field of fields) {
    Object.defineProperty(request, field, {
      enumerable: true,
      get: () => (writable || typeof data[field] !== 'object' || data[field] === null ? data[field] : deepFreeze(data[field])),
      set: (value) => {
        if (!writable) refuse(field);
        if (field === 'arguments') {
          const text = JSON.stringify(value);
          if (text === undefined) throw new TypeError('request.arguments must be a JSON value');
          data.arguments = JSON.parse(text);
        } else {
          data[field] = String(value);
        }
      },
    });
  }
  Object.freeze(request);
  return { request, snapshotOf: () => data };
};

if (input.phase === 'pre') {
  const built = mcpRequest(input.request, true);
  define('request', built.request);
  state.request = built.snapshotOf;
} else {
  define('request', mcpRequest(input.request, false).request);
  define('response', deepFreeze({
    method: input.response.method,
    result: input.response.result,
    error: input.response.error,
    isError: input.response.isError,
    serverInfo: input.response.serverInfo,
    messageCount: input.response.messageCount,
    durationMs: input.response.durationMs,
  }));
}
`;

const target = { protocol: z.literal('mcp'), transport: z.enum(['stdio', 'http', 'sse']), url: z.string() };

const requestSchema: z.ZodType<McpRequestSnapshot> = z.union([
  z.object({ ...target, method: z.enum(LIST_METHODS) }),
  z.object({ ...target, method: z.literal('tools/call'), tool: z.string(), arguments: z.unknown() }),
  z.object({ ...target, method: z.literal('resources/read'), uri: z.string() }),
  z.object({
    ...target,
    method: z.literal('prompts/get'),
    prompt: z.string(),
    arguments: z.record(z.string(), z.string()),
  }),
]);

/** The operation's single-line names: a tool, a URI, a prompt. */
function namesOf(snapshot: McpRequestSnapshot): string[] {
  switch (snapshot.method) {
    case 'tools/call':
      return [snapshot.tool];
    case 'resources/read':
      return [snapshot.uri];
    case 'prompts/get':
      return [snapshot.prompt];
    default:
      return [];
  }
}

/** Every text of the operation in which a reference would be expanded. */
function textsOf(snapshot: McpRequestSnapshot): string[] {
  switch (snapshot.method) {
    case 'tools/call':
      return [snapshot.tool, JSON.stringify(snapshot.arguments) ?? ''];
    case 'prompts/get':
      return [snapshot.prompt, ...Object.entries(snapshot.arguments).flat()];
    default:
      return namesOf(snapshot);
  }
}

/** MCP's scripting facet. */
export const mcpScripting: ProtocolScripting<McpRequestSnapshot, McpResponseSnapshot> = {
  declarations: (phase) => [MCP_REQUEST, phase === 'pre' ? MCP_PRE : MCP_POST].join('\n'),
  levelTypes: () => mcpScriptTypes(undefined),
  reference: () => [
    { title: 'MCP: shared by both phases', declarations: MCP_REQUEST },
    { title: 'MCP: pre-request', declarations: MCP_PRE },
    { title: 'MCP: post-response', declarations: MCP_POST },
  ],
  prelude: () => MCP,
  requestSchema,
  inspect(snapshot): SnapshotFacts {
    return {
      // An HTTP server's URL keeps its origin; stdio's is empty, and so must stay empty.
      destination: snapshot.url,
      fixed: { method: snapshot.method, transport: snapshot.transport },
      pairs: [],
      lines: [snapshot.url, ...namesOf(snapshot)],
      texts: [snapshot.url, ...textsOf(snapshot)],
    };
  },
  validate(_before, after): ScriptFailure | undefined {
    return after.method === 'tools/call' && after.tool === ''
      ? { code: 'script-value-invalid', message: 'A tool call needs the name of a tool' }
      : undefined;
  },
};

/** This protocol's member of the unions over every composed protocol (package split spec §3.4). */
declare module '../protocol/unions.js' {
  interface RequestSnapshots {
    mcp: McpRequestSnapshot;
  }
  interface ResponseSnapshots {
    mcp: McpResponseSnapshot;
  }
}
