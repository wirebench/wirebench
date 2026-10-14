import type { KindModule } from '../kind-module.js';

export const mcpKind = {
  kind: 'mcp',
  feature: { id: 'mcp', title: 'MCP', default: true, stage: 'experimental', requires: [] },
  label: 'MCP',
  tabs: { request: 'mcp-request', container: 'mcp-api' },
} as const satisfies KindModule<'mcp'>;
