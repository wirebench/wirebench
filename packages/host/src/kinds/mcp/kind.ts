import { mcpServersOf } from '@wirebench/engine';
import type { MainKind } from '../kind-main.js';
import { McpHost } from './host.js';
import { registerMcpChannels } from './ipc.js';
import {
  addMcpFolder,
  mcpMutations,
  mcpServerOwning,
  moveMcpNode,
  removeMcpFolder,
  updateMcpFolder,
} from './mutations.js';
import { mcpEntityIds, mcpRoutes } from './router.js';
import { mcpSearch } from './search.js';
import { mcpSend } from './send.js';

/** MCP's main half (#79). It has no HTTP Log rows, so no `log`: History is an MCP send's record. */
export const mcpMain: MainKind<'mcp'> = {
  kind: 'mcp',
  createHost: (core) => new McpHost(core),
  routes: mcpRoutes,
  entityIds: mcpEntityIds,
  send: mcpSend,
  search: mcpSearch,
  registerChannels: registerMcpChannels,
  mutations: mcpMutations,
  tree: {
    ownsApi: (project, apiId) => mcpServersOf(project).some((server) => server.id === apiId),
    ownsNode: (project, nodeId) => mcpServerOwning(project, nodeId) !== undefined,
    addFolder: addMcpFolder,
    updateFolder: updateMcpFolder,
    removeFolder: removeMcpFolder,
    moveNode: moveMcpNode,
  },
};
