import type { RestApiWire, RestRequestWire } from '@shared/kinds/rest/wire.js';
import type { RestFolderWire } from '@shared/wire-base.js';
import { containerChildren } from '../../features/explorer/container-tree.js';
import type { ExplorerNode } from '../../features/explorer/tree-nodes.js';
import type { KindExplorerTree } from '../explorer-tree.js';

function restRequestNode(api: RestApiWire, request: RestRequestWire): ExplorerNode {
  return {
    id: `rest:${request.id}`,
    kind: 'rest-request',
    label: request.name,
    requestId: request.id,
    apiId: api.id,
    method: request.method,
    ...(request.body.kind === 'graphql' ? { graphql: true as const } : {}),
    ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
    ...(request.orphaned === true ? { orphaned: true } : {}),
  };
}

/**
 * One API row and everything under it. An API is always internal (it has children, even when the
 * list is empty), so it folds like an interface rather than opening on a single click.
 */
function apiNode(
  api: RestApiWire,
  folders: readonly RestFolderWire[],
  requests: readonly RestRequestWire[],
): ExplorerNode {
  return {
    id: `api:${api.id}`,
    kind: 'api',
    label: api.name,
    apiId: api.id,
    // `cache`, not just a source: an update compares against the cached document, so an API
    // without one cannot be updated and must not offer the menu item.
    ...(api.definition?.cache === true ? { hasDefinition: true } : {}),
    children: containerChildren(api.id, 'rest', undefined, folders, requests, (request) =>
      restRequestNode(api, request),
    ),
  };
}

/** REST's containers: each API, placed by its `order`. */
export const restExplorerTree: KindExplorerTree = {
  scriptContainers: ['api', 'folder'],
  movable: { api: 'apiId', folder: 'folderId', 'rest-request': 'requestId' },
  kind: 'rest',
  containers: ({ rest }) =>
    (rest?.apis ?? []).map((api) => ({
      order: api.order,
      node: apiNode(api, rest?.folders ?? [], rest?.requests ?? []),
    })),
};
