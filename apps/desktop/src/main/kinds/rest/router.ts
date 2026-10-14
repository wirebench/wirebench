/**
 * REST's router methods (spec §5.3): each names the REST host method it reaches and how the
 * host is found. `ProjectRouter`, `WorkspaceService` and `window-scope.ts` all derive from this
 * one list, so a method is declared here once.
 */

import type { ProjectWire } from '../../../shared/wire-types.js';
import type { KindRoute, KindRouter } from '../kind-main.js';
import type { RestHost } from './host.js';

export const restRoutes = {
  /**
   * Places an imported OpenAPI-described API in the addressed project, caching its documents.
   * `api.importOpenApi` carries the same target union `project.addInterface` does.
   */
  addApi: { method: 'addApi', by: 'project' },
  /** The credentials configured on one API, folder or REST request — its own, not its chain's. */
  restAuthOf: { method: 'restAuthOf', by: 'entity' },
  /** What History names a REST send by: the request, its API, and its folder path. */
  restMeta: { method: 'restMeta', by: 'entity' },
  restContractFor: { method: 'restContractFor', by: 'entity' },
  /** The JSON schema of the body a REST request's operation declares, for the body editor's form. */
  restBodySchema: { method: 'restBodySchema', by: 'entity' },
  /** Where a REST API's definition came from, for an update to re-read. */
  restSource: { method: 'restSource', by: 'entity' },
  restPlanUpdate: { method: 'planRestUpdate', by: 'entity' },
  restApplyUpdate: { method: 'applyRestUpdate', by: 'entity' },
  /** Lints the API's cached definition with the built-in and the project's own rule sets. */
  restLint: { method: 'lintApi', by: 'entity' },
  /** An API's webhooks and callbacks, and which of their keys the group linked to it already holds. */
  webhookItems: { method: 'webhookItems', by: 'entity' },
  /** Places the chosen webhooks/callbacks into the API's linked webhook group, creating it if needed. */
  importWebhooks: { method: 'importWebhooks', by: 'entity' },
  /** An API's GraphQL schema, built, for the GraphQL editor's completion and validation (#77). */
  graphqlSchemaFor: { method: 'graphqlSchemaFor', by: 'entity' },
  /** Stores an API's GraphQL schema as SDL and records where it came from. */
  setGraphqlSchema: { method: 'setGraphqlSchema', by: 'entity' },
  /** Removes an API's GraphQL schema. */
  clearGraphqlSchema: { method: 'clearGraphqlSchema', by: 'entity' },
} as const satisfies Readonly<Record<string, KindRoute<RestHost>>>;

export type RestRouter = KindRouter<RestHost, typeof restRoutes>;

/**
 * The ids REST's channels address, for `WorkspaceService`'s routing index: APIs, their folders and
 * requests, and the webhook collection, which owns auth too (OAuth2 included). The collection's
 * folders and items are REST rows whose `apiId` is the collection's.
 */
export function* restEntityIds(project: ProjectWire): Iterable<string> {
  const owners = new Set(project.apis.map((api) => api.id));
  if (project.webhooks !== undefined) owners.add(project.webhooks.id);
  yield* owners;
  for (const folder of project.folders) if (owners.has(folder.apiId)) yield folder.id;
  for (const request of project.restRequests) yield request.id;
}
