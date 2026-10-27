import { grpcApisOf } from '@wirebench/engine';
import type { MainKind } from '../kind-main.js';
import { GrpcHost } from './host.js';
import { grpcEntityIds, grpcRoutes } from './router.js';
import { grpcSend } from './send.js';
import { grpcSearch } from './search.js';
import { grpcLog } from './log.js';
import { registerGrpcChannels } from './ipc.js';
import {
  addGrpcFolder,
  grpcApiOwning,
  grpcMutations,
  moveGrpcNode,
  removeGrpcFolder,
  updateGrpcFolder,
} from './mutations.js';

/** gRPC's main half. */
export const grpcMain: MainKind<'grpc'> = {
  kind: 'grpc',
  createHost: (core) => new GrpcHost(core),
  routes: grpcRoutes,
  entityIds: grpcEntityIds,
  send: grpcSend,
  search: grpcSearch,
  log: grpcLog,
  registerChannels: registerGrpcChannels,
  mutations: grpcMutations,
  tree: {
    ownsApi: (project, apiId) => grpcApisOf(project).some((api) => api.id === apiId),
    ownsNode: (project, nodeId) => grpcApiOwning(project, nodeId) !== undefined,
    addFolder: addGrpcFolder,
    updateFolder: updateGrpcFolder,
    removeFolder: removeGrpcFolder,
    moveNode: moveGrpcNode,
  },
};
