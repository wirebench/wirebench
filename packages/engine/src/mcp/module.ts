/** MCP as a protocol module (#79): storage only, until its run, scripting and secrets facets land. */
import { defineProtocol } from '../protocol/module.js';
import { mcpStorage } from './storage.js';

/** The MCP protocol: servers, their folders and their saved requests. */
export const mcpProtocol = defineProtocol({
  kind: 'mcp',
  feature: { id: 'mcp', title: 'MCP', default: true, stage: 'experimental', requires: [] },
  storage: mcpStorage,
});
