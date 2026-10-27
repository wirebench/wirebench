/**
 * gRPC's router methods (spec §5.3): each names the gRPC host method it reaches and how the
 * host is found. `ProjectRouter`, `WorkspaceService` and `window-scope.ts` all derive from this
 * one list, so a method is declared here once.
 */

import type { ProjectWire } from '@wirebench/wire/wire-types';
import type { KindRoute, KindRouter } from '../kind-main.js';
import type { GrpcHost } from './host.js';

export const grpcRoutes = {
  /** Places a gRPC API mapped from a non-contract file, with no definition, in one project. */
  importGrpcApi: { method: 'importGrpcApi', by: 'project' },
  /** Places an imported gRPC API in one project, caching its `.proto` files. */
  addGrpcApi: { method: 'addGrpcApi', by: 'project' },
  /** What History names a gRPC send by: the request, its API, and its folder path. */
  grpcMeta: { method: 'grpcMeta', by: 'entity' },
  /** The credentials configured on one gRPC API, folder or request — its own, not its chain's. */
  grpcAuthOf: { method: 'grpcAuthOf', by: 'entity' },
  /** The loaded `.proto` set of the gRPC API owning `entityId`, from its cache. */
  grpcProtoSetFor: { method: 'grpcProtoSetFor', by: 'entity' },
  /** The services and files of a gRPC API's cached definition, for the renderer. */
  grpcDefinition: { method: 'grpcDefinition', by: 'entity' },
  /** A sample message for one type of a gRPC API's definition. */
  grpcSample: { method: 'grpcSample', by: 'entity' },
  /** The fields of the message at a path of JSON keys under one type. */
  grpcFields: { method: 'grpcFields', by: 'entity' },
  /** Asks a reflection-sourced API's server to describe itself again. */
  grpcRefresh: { method: 'refreshGrpcDefinition', by: 'entity' },
} as const satisfies Readonly<Record<string, KindRoute<GrpcHost>>>;

export type GrpcRouter = KindRouter<GrpcHost, typeof grpcRoutes>;

/** The ids gRPC's channels address, for `WorkspaceService`'s routing index: APIs, their folders and requests. */
export function* grpcEntityIds(project: ProjectWire): Iterable<string> {
  const owners = new Set(project.grpcApis.map((api) => api.id));
  yield* owners;
  for (const folder of project.folders) if (owners.has(folder.apiId)) yield folder.id;
  for (const request of project.grpcRequests) yield request.id;
}
