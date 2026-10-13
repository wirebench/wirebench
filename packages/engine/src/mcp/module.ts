/** MCP as a protocol module (#79): storage, secrets and runs, until its scripting facet lands. */
import { defineProtocol } from '../protocol/module.js';
import { mcpRun } from './run.js';
import { mcpSecrets } from './secrets.js';
import { mcpStorage } from './storage.js';

/** The MCP protocol: servers, their folders and their saved requests. */
export const mcpProtocol = defineProtocol({
  kind: 'mcp',
  feature: { id: 'mcp', title: 'MCP', default: true, stage: 'experimental', requires: [] },
  storage: mcpStorage,
  secrets: mcpSecrets,
  run: mcpRun,
});
