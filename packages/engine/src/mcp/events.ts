/** What an MCP send reports while it runs (#79): each JSON-RPC message, either way, as it is kept. */
import type { McpMessage } from './session.js';

export type McpLiveEvent = { readonly protocol: 'mcp'; readonly kind: 'message'; readonly message: McpMessage };
