/**
 * Each kind's router methods (spec §5.3), by kind: the same tables `MAIN_KINDS` carries as `routes`.
 *
 * Kept apart from `kind-main.ts` so `window-scope.ts` and `WorkspaceService` do not import the
 * kinds' IPC modules, which import them back.
 */
import type { MainKindId } from './enabled-kinds.js';
import type { ProjectWire } from '../../shared/wire-types.js';
import { grpcEntityIds, grpcRoutes } from './grpc/router.js';
import type { KindRoute } from './kind-main.js';
import { restEntityIds, restRoutes } from './rest/router.js';
import { soapEntityIds, soapRoutes } from './soap/router.js';
import { wsEntityIds, wsRoutes } from './ws/router.js';

/** Every kind's router table, by kind. */
export const KIND_ROUTES: {
  readonly [K in MainKindId]: Readonly<
    Record<string, { readonly method: string; readonly by: KindRoute<unknown>['by'] }>
  >;
} = {
  soap: soapRoutes,
  rest: restRoutes,
  grpc: grpcRoutes,
  websocket: wsRoutes,
};

/** The entity ids one kind's channels address in a project snapshot. */
export type KindEntityIds = (project: ProjectWire) => Iterable<string>;

/**
 * Every kind's entity ids, by kind: the same functions `MAIN_KINDS` carries as `entityIds`.
 * `WorkspaceService`'s routing index adds each kind's, so a new kind's entities route without an edit
 * there.
 */
export const KIND_ENTITY_IDS: { readonly [K in MainKindId]: KindEntityIds } = {
  soap: soapEntityIds,
  rest: restEntityIds,
  grpc: grpcEntityIds,
  websocket: wsEntityIds,
};
