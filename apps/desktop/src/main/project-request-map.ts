/**
 * Walks every saved request of a project, whichever protocol, for the changes that edit one by id
 * wherever it sits (#63 scripts, #192 assertions). A container nothing changed in keeps its identity.
 */
import type { Project } from '@wirebench/engine';
import { grpcApisOf, restApisOf, soapInterfacesOf, wsApisOf } from '@wirebench/engine';

/** A saved request of any protocol, as far as these changes go. */
export interface Identified {
  readonly id: string;
}

/** An edit applied to each request; `X` is the part of a request the edit reads. */
export type Update<X extends Identified = Identified> = <R extends X>(request: R) => R;

interface Tree<R> {
  readonly requests: readonly R[];
  readonly folders: readonly Tree<R>[];
}

/** `container` with `update` applied to every request in it, folders included; the same object when none changed. */
function mapTree<T extends Tree<R>, R extends Identified>(container: T, update: Update): T {
  const requests = container.requests.map((request) => update(request));
  const folders = container.folders.map((folder) => mapTree(folder, update));
  const changed =
    requests.some((request, index) => request !== container.requests[index]) ||
    folders.some((folder, index) => folder !== container.folders[index]);
  return changed ? { ...container, requests, folders } : container;
}

/** `items` mapped, or the same array when no item changed. */
function mapSame<T>(items: readonly T[], map: (item: T) => T): readonly T[] {
  const next = items.map(map);
  return next.some((item, index) => item !== items[index]) ? next : items;
}

/**
 * `project` with `update` applied to every SOAP, REST and gRPC request, and to every WebSocket
 * request too when `protocols.websocket` is set.
 */
export function mapRequests<X extends Identified = Identified>(
  project: Project,
  edit: Update<X>,
  protocols: { readonly websocket?: boolean } = {},
): Project {
  // Every request of every protocol carries at least what `X` names (`scripts` and `assertions` are optional).
  const update = edit as Update;
  const interfaces = mapSame(soapInterfacesOf(project), (iface) => {
    const operations = mapSame(iface.operations, (operation) => {
      const requests = mapSame(operation.requests, (request) => update(request));
      return requests === operation.requests ? operation : { ...operation, requests };
    });
    return operations === iface.operations ? iface : { ...iface, operations };
  });
  return {
    ...project,
    containers: {
      ...project.containers,
      soap: interfaces,
      rest: mapSame(restApisOf(project), (api) => mapTree(api, update)),
      grpc: mapSame(grpcApisOf(project), (api) => mapTree(api, update)),
      ...(protocols.websocket === true ? { websocket: mapSame(wsApisOf(project), (api) => mapTree(api, update)) } : {}),
    },
  };
}
