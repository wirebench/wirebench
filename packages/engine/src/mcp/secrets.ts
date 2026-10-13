/**
 * Where the secret scanner looks in MCP's servers, and how a move rewrites them (#79): a stdio
 * server's arguments and variables, an HTTP server's URL and headers, and each request's resource
 * URI, prompt arguments and tool-call arguments.
 */
import type { Project } from '../project/model.js';
import type { ProtocolSecrets } from '../protocol/module.js';
import { keyed, keyedEntries, mapShared, mapTree, patch, SEP, tree } from '../secrets/scan/support.js';
import type { ScanTarget } from '../secrets/scan/support.js';
import { mcpServersOf, withMcpServers } from './model.js';
import type { McpOperation, McpRequestDef, McpServer, McpTransport } from './model.js';

/** A URL or URI is scanned for its query parameters as form pairs, and for any shape. */
const URL_CONTEXT = { contentType: 'application/x-www-form-urlencoded', nameKind: 'query' } as const;

function* transportTargets(server: McpServer): Generator<ScanTarget> {
  const { transport } = server;
  if (transport.type === 'stdio') {
    for (let index = 0; index < transport.args.length; index++) {
      const text = transport.args[index]!;
      if (text === '') continue;
      yield {
        location: { kind: 'mcp-arg', apiId: server.id, index },
        label: `${server.name}${SEP}argument ${index + 1}`,
        text,
        context: {},
      };
    }
    yield* keyed('mcp-env', server.id, server.name, 'variable', 'property', transport.env);
    return;
  }
  if (transport.url !== '') {
    yield {
      location: { kind: 'mcp-url', apiId: server.id },
      label: `${server.name}${SEP}URL`,
      text: transport.url,
      context: URL_CONTEXT,
    };
  }
  yield* keyed('mcp-header', server.id, server.name, 'header', 'header', transport.headers);
}

function* requestTargets(request: McpRequestDef, prefix: string): Generator<ScanTarget> {
  const path = `${prefix}${SEP}${request.name}`;
  const { operation } = request;
  if (operation.method === 'resources/read' && operation.uri !== '') {
    yield {
      location: { kind: 'mcp-uri', requestId: request.id },
      label: `${path}${SEP}URI`,
      text: operation.uri,
      context: URL_CONTEXT,
    };
  }
  if (operation.method === 'prompts/get') {
    yield* keyed('mcp-prompt-arg', request.id, path, 'argument', 'field', operation.arguments);
  }
  if (operation.method === 'tools/call' && operation.arguments.trim() !== '') {
    yield {
      location: { kind: 'mcp-arguments', requestId: request.id },
      label: `${path}${SEP}arguments`,
      text: operation.arguments,
      context: { contentType: 'application/json' },
    };
  }
}

function* scanTargets(project: Project): Generator<ScanTarget> {
  for (const server of mcpServersOf(project)) {
    yield* transportTargets(server);
    yield* tree(server, server.name, requestTargets);
  }
}

type Rewriter = Parameters<ProtocolSecrets['applyMoves']>[1];

function rewriteTransport(rw: Rewriter, serverId: string, transport: McpTransport): McpTransport {
  if (transport.type === 'stdio') {
    return patch(transport, {
      args: mapShared(transport.args, (arg, index) => rw.text({ kind: 'mcp-arg', apiId: serverId, index }, arg)),
      env: keyedEntries(rw, 'mcp-env', { apiId: serverId }, transport.env),
    });
  }
  return patch(transport, {
    url: rw.text({ kind: 'mcp-url', apiId: serverId }, transport.url),
    headers: keyedEntries(rw, 'mcp-header', { apiId: serverId }, transport.headers),
  });
}

function rewriteOperation(rw: Rewriter, requestId: string, operation: McpOperation): McpOperation {
  switch (operation.method) {
    case 'resources/read':
      return patch(operation, { uri: rw.text({ kind: 'mcp-uri', requestId }, operation.uri) });
    case 'prompts/get':
      return patch(operation, { arguments: keyedEntries(rw, 'mcp-prompt-arg', { requestId }, operation.arguments) });
    case 'tools/call':
      return patch(operation, { arguments: rw.text({ kind: 'mcp-arguments', requestId }, operation.arguments) });
    default:
      return operation;
  }
}

/** MCP's transports and operations. */
export const mcpSecrets: ProtocolSecrets = {
  scanTargets,
  applyMoves: (project, rw) => {
    const servers = mcpServersOf(project);
    const next = mapShared(servers, (server) =>
      mapTree(
        patch(server, { transport: rewriteTransport(rw, server.id, server.transport) }),
        (request: McpRequestDef) => patch(request, { operation: rewriteOperation(rw, request.id, request.operation) }),
      ),
    );
    return next === servers ? project : withMcpServers(project, next);
  },
};
