/**
 * The folders and requests inside one API-shaped container, for every kind that has folders
 * (REST, gRPC, WebSocket). Folders ride in one list on the wire whatever kind owns them, told apart
 * by `apiId`; each kind supplies only how one of its requests becomes a row.
 */
import type { KindId } from '@shared/kinds/kind-module.js';
import type { RestFolderWire } from '@shared/wire-base.js';
import type { ExplorerNode } from './tree-nodes.js';

/** What a request needs for the tree to place it. */
export interface PlacedRequest {
  readonly apiId: string;
  readonly folderId?: string | undefined;
  readonly order: number;
}

/**
 * The folders and requests directly inside `parentId` (the container itself when undefined),
 * interleaved by `order` so the two sort together: a folder the user dragged below a request stays
 * below it. Every folder row names the kind that owns it, so "New request" inside it makes one of
 * that kind.
 */
export function containerChildren<R extends PlacedRequest>(
  apiId: string,
  ownerKind: KindId,
  parentId: string | undefined,
  folders: readonly RestFolderWire[],
  requests: readonly R[],
  requestNode: (request: R) => ExplorerNode,
): ExplorerNode[] {
  const folderNodes = folders
    .filter((folder) => folder.apiId === apiId && folder.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((folder): ExplorerNode => ({
      id: `folder:${folder.id}`,
      kind: 'folder',
      label: folder.name,
      apiId,
      folderId: folder.id,
      ownerKind,
      children: containerChildren(apiId, ownerKind, folder.id, folders, requests, requestNode),
    }));

  const requestNodes = requests
    .filter((request) => request.apiId === apiId && request.folderId === parentId)
    .sort((a, b) => a.order - b.order)
    .map(requestNode);

  return [...folderNodes, ...requestNodes];
}
