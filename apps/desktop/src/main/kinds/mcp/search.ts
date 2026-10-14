/**
 * MCP's share of `search.query` (spec §5.4; #79): the documents its requests add to the corpus.
 */
import type { McpRequestWire } from '../../../shared/kinds/mcp/wire.js';
import type { SearchDocument } from '../../search.js';
import type { KindSearch } from '../kind-main.js';

/** What an operation says beyond its method: the tool and its arguments, the URI, the prompt and its arguments. */
function operationLines(operation: McpRequestWire['operation']): string[] {
  switch (operation.method) {
    case 'tools/call':
      return [operation.tool, ...(operation.arguments.trim() !== '' ? [operation.arguments] : [])];
    case 'resources/read':
      return [operation.uri];
    case 'prompts/get':
      return [operation.prompt, ...operation.arguments.map((row) => `${row.name}: ${row.value}`)];
    default:
      return [];
  }
}

export const mcpSearch: KindSearch = {
  requests({ snapshot, scopes, projectId, projectName }) {
    const documents: SearchDocument[] = [];
    // An MCP request has no headers of its own (its server's transport carries them), so only its
    // operation is a document: the method, and what the operation names and sends.
    if (!scopes.requestBodies) return documents;
    for (const request of snapshot.mcpRequests) {
      const serverName = snapshot.mcpServers.find((server) => server.id === request.apiId)?.name ?? request.apiId;
      documents.push({
        kind: 'request-body',
        protocol: 'mcp',
        text: [request.name, request.operation.method, ...operationLines(request.operation)].join('\n'),
        projectId,
        projectName,
        requestId: request.id,
        requestName: request.name,
        interfaceId: request.apiId,
        interfaceName: serverName,
      });
    }
    return documents;
  },
};
