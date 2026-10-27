/**
 * WebSocket's router methods (spec §5.3): each names the WebSocket host method it reaches and how the
 * host is found. `ProjectRouter`, `WorkspaceService` and `window-scope.ts` all derive from this
 * one list, so a method is declared here once.
 */

import type { ProjectWire } from '@wirebench/wire/wire-types';
import type { KindRoute, KindRouter } from '../kind-main.js';
import type { WsHost } from './host.js';

export const wsRoutes = {
  /** Places a WebSocket API mapped from a non-contract file (a `.http` file) in one project. */
  importWsApi: { method: 'importWsApi', by: 'project' },
  /** Places a WebSocket API imported from an AsyncAPI document in one project, caching its documents. */
  importAsyncApi: { method: 'importAsyncApi', by: 'project' },
  /** The messages of a WebSocket request's contract channel, for checking its live frames. */
  wsContractFor: { method: 'wsContractFor', by: 'entity' },
  /** What History names a WebSocket send by: the request, its API, and its folder path. */
  wsMeta: { method: 'wsMeta', by: 'entity' },
  /** Where an AsyncAPI-imported API's definition came from, for an update to re-read. */
  asyncApiSource: { method: 'asyncApiSource', by: 'entity' },
  asyncApiPlanUpdate: { method: 'planAsyncApiUpdate', by: 'entity' },
  asyncApiApplyUpdate: { method: 'applyAsyncApiUpdate', by: 'entity' },
} as const satisfies Readonly<Record<string, KindRoute<WsHost>>>;

export type WsRouter = KindRouter<WsHost, typeof wsRoutes>;

/** The ids WebSocket's channels address, for `WorkspaceService`'s routing index: APIs, their folders and requests. */
export function* wsEntityIds(project: ProjectWire): Iterable<string> {
  const owners = new Set(project.wsApis.map((api) => api.id));
  yield* owners;
  for (const folder of project.folders) if (owners.has(folder.apiId)) yield folder.id;
  for (const request of project.wsRequests) yield request.id;
}
