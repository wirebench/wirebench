/**
 * The short form of an MCP request's method (#79), as its explorer badge and History row show it:
 * `CALL` a tool, `READ` a resource, `GET` a prompt, or `LIST` what the server has. Pure and zod-free,
 * so the eager explorer can use it.
 */

export type McpMethodLabel = 'CALL' | 'READ' | 'GET' | 'LIST';

/** The badge of one JSON-RPC method; any `…/list` method is a `LIST`. */
export function mcpMethodLabel(method: string): McpMethodLabel {
  switch (method) {
    case 'tools/call':
      return 'CALL';
    case 'resources/read':
      return 'READ';
    case 'prompts/get':
      return 'GET';
    default:
      return 'LIST';
  }
}
