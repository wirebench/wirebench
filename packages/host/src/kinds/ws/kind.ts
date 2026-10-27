import { wsApisOf } from '@wirebench/engine';
import type { MainKind } from '../kind-main.js';
import { WsHost } from './host.js';
import { wsEntityIds, wsRoutes } from './router.js';
import { wsSend } from './send.js';
import { wsSearch } from './search.js';
import { wsLog } from './log.js';
import { registerWsChannels } from './ipc.js';
import { addWsFolder, moveWsNode, removeWsFolder, updateWsFolder, wsApiOwning, wsMutations } from './mutations.js';

/** WebSocket's main half. */
export const wsMain: MainKind<'websocket'> = {
  kind: 'websocket',
  createHost: (core) => new WsHost(core),
  routes: wsRoutes,
  entityIds: wsEntityIds,
  send: wsSend,
  search: wsSearch,
  log: wsLog,
  registerChannels: registerWsChannels,
  mutations: wsMutations,
  tree: {
    ownsApi: (project, apiId) => wsApisOf(project).some((api) => api.id === apiId),
    ownsNode: (project, nodeId) => wsApiOwning(project, nodeId) !== undefined,
    addFolder: addWsFolder,
    updateFolder: updateWsFolder,
    removeFolder: removeWsFolder,
    moveNode: moveWsNode,
  },
};
