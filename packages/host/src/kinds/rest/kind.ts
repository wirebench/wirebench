import { restApisOf } from '@wirebench/engine';
import type { MainKind } from '../kind-main.js';
import { RestHost } from './host.js';
import { restEntityIds, restRoutes } from './router.js';
import { restSend } from './send.js';
import { restSearch } from './search.js';
import { restLog } from './log.js';
import { registerRestChannels } from './ipc.js';
import { addFolder, moveNode, removeFolder, restMutations, restOwnsNode, updateFolder } from './mutations.js';
import { webhookMutations } from './webhooks/mutations.js';

/** REST's main half; the webhook collection is REST's too. */
export const restMain: MainKind<'rest'> = {
  kind: 'rest',
  createHost: (core) => new RestHost(core),
  routes: restRoutes,
  entityIds: restEntityIds,
  send: restSend,
  search: restSearch,
  log: restLog,
  registerChannels: registerRestChannels,
  mutations: { ...restMutations, ...webhookMutations },
  tree: {
    ownsApi: (project, apiId) => restApisOf(project).some((api) => api.id === apiId),
    ownsNode: restOwnsNode,
    addFolder,
    updateFolder,
    removeFolder,
    moveNode,
  },
};
