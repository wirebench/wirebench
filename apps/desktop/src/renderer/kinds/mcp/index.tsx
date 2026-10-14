import { lazy } from 'react';
import type { RendererKind } from '../renderer-kind.js';
import { requestContainer } from '../tab-contribution.js';
import { registerMcpCommands } from './commands.js';
import { mcpHistory, mcpLog, mcpRequests, mcpSearch } from './activity.js';
import { mcpExplorer } from './explorer.js';

// Split out like every other editor: the arguments editor is Monaco.
const McpEditor = lazy(async () => {
  const module = await import('../../features/mcp-editor/mcp-editor.js');
  return { default: ({ id }: { readonly id: string }) => <module.McpEditor requestId={id} /> };
});

const McpApiTab = lazy(async () => {
  const module = await import('../../features/mcp-api/mcp-api-tab.js');
  return { default: ({ id }: { readonly id: string }) => <module.McpApiTab apiId={id} /> };
});

/** MCP in the renderer (#79): its request editor and its server tab. */
export const mcpRenderer: RendererKind = {
  kind: 'mcp',
  explorer: mcpExplorer,
  requests: mcpRequests,
  history: mcpHistory,
  search: mcpSearch,
  registerCommands: registerMcpCommands,
  log: mcpLog,
  tabs: [
    {
      kind: 'mcp-request',
      treeNode: (id) => `mcp:${id}`,
      container: (id, project) =>
        requestContainer(project.mcpRequests[id], (apiId) => project.mcpServers[apiId] !== undefined),
      idField: 'mcpRequestId',
      prefix: 'mcp:',
      persisted: true,
      Component: McpEditor,
      title: (id, { project }) => project.mcpRequests[id]?.name,
      dirty: (id, drafts) => drafts.mcpRequests[id] !== undefined,
    },
    {
      kind: 'mcp-api',
      treeNode: (id) => `mcp-api:${id}`,
      container: (id, project) => (project.mcpServers[id] === undefined ? undefined : { apiId: id }),
      idField: 'mcpApiId',
      prefix: 'mcp-api:',
      persisted: true,
      Component: McpApiTab,
      title: (id, { project }) => project.mcpServers[id]?.name,
    },
  ],
};
