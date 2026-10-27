/**
 * The surface the `ipc/*.ts` channel modules need from "the project", once there is more than
 * one open at a time.
 *
 * Today each module declares its own `Pick<ProjectHost, …>` and is handed the single open
 * `ProjectHost`. {@link ProjectRouter} is the union of every one of those picks, re-expressed
 * so each method *resolves its own host* from the entity id it already receives: a request id,
 * an interface id, a keystore id. The handful of methods that name no entity today (`snapshot`,
 * `scopesFor`, `save`, `mutate`, `proxyFor`, `projectId`) gain a leading `projectId` — or a
 * `requestId`, where the caller already has one — so they can be routed too.
 *
 * Parameters and return types are derived from `ProjectHost` itself (`Parameters<…>` /
 * `ReturnType<…>`) rather than restated, so the router cannot drift from the class it routes
 * to: changing a `ProjectHost` signature changes this interface with it.
 *
 * `WorkspaceService` implements this. Resolving an entity that belongs to no open project
 * throws `WirebenchError('unknown-entity')` — see `WorkspaceService.hostOfEntity`.
 */

import type { KindRouters } from './kinds/kind-main.js';
import type { ProjectHost } from './project-host.js';

/**
 * Every `ProjectHost` method the `ipc/*.ts` modules drive, routed by entity id: the core's, declared
 * here, and each kind's, declared once in its route table (`kinds/<kind>/router.ts`).
 */
export interface ProjectRouter extends KindRouters {
  // — routed by project id (no entity id in the call today) ————————————————————————————————

  /**
   * The project's snapshot, or `null` when no host is open for `projectId`.
   *
   * Named `projectSnapshot`, not `snapshot`: the implementor is `WorkspaceService`, whose own
   * `snapshot()` is the *workspace's*. The two cannot share a name, and the workspace one is
   * the one the names block fixes.
   */
  projectSnapshot(projectId: string): ReturnType<ProjectHost['snapshot']>;
  /**
   * Applies one change to the addressed project.
   *
   * Named `projectMutate`, not `mutate`, for the same reason as {@link projectSnapshot}:
   * `WorkspaceService.mutate(change: WorkspaceChange)` is the workspace's own, and the names
   * block fixes that one.
   */
  projectMutate(projectId: string, ...args: Parameters<ProjectHost['mutate']>): ReturnType<ProjectHost['mutate']>;
  /** Saves one project. Saving *every* open project is `WorkspaceService.saveAll`. */
  save(projectId: string, ...args: Parameters<ProjectHost['save']>): ReturnType<ProjectHost['save']>;
  /** Resolves the proxy for `url` against one project's effective preferences. */
  proxyFor(projectId: string, ...args: Parameters<ProjectHost['proxyFor']>): ReturnType<ProjectHost['proxyFor']>;
  /** One project's extra trust anchors: the preferred CA bundle, split into one PEM per certificate. */
  trustAnchorsFor(projectId: string): ReturnType<ProjectHost['trustAnchors']>;
  /** The client identity a send presents: the keystore named, else the global client keystore. */
  clientIdentityFor(
    projectId: string,
    ...args: Parameters<ProjectHost['clientIdentityFor']>
  ): ReturnType<ProjectHost['clientIdentityFor']>;
  /** A WS-Security keystore's parsed material, read with the session's picks; never crosses the bridge. */
  keystoreFor(
    projectId: string,
    ...args: Parameters<ProjectHost['keystoreFor']>
  ): ReturnType<ProjectHost['keystoreFor']>;
  /** Writes an importer's scripts under the addressed project's `imported-scripts/`, never overwriting a file. */
  writeImportedScripts(
    projectId: string,
    ...args: Parameters<ProjectHost['writeImportedScripts']>
  ): ReturnType<ProjectHost['writeImportedScripts']>;
  /** Adds the imported properties the addressed project does not have yet; existing names keep their value. */
  importProperties(
    projectId: string,
    ...args: Parameters<ProjectHost['importProperties']>
  ): ReturnType<ProjectHost['importProperties']>;
  /** Re-reads one project's folder from disk, discarding its unsaved in-memory changes. */
  reload(projectId: string): ReturnType<ProjectHost['reload']>;

  // — routed by request id ————————————————————————————————————————————————————————————————

  /**
   * The id of the project owning `entityId`, or `undefined` when nothing does.
   *
   * This is the non-throwing half of `hostOfEntity`, and it is what the history path uses to
   * key an entry: on `ProjectHost` it answered "which project is open?", which in a workspace
   * is the wrong question — "which project does this request belong to?" is the right one.
   */
  projectId(entityId: string): string | undefined;
  /** The property scopes a send expands against, resolved for the request's own project. */
  scopesFor(requestId: string, ...args: Parameters<ProjectHost['scopesFor']>): ReturnType<ProjectHost['scopesFor']>;
  preflight(...args: Parameters<ProjectHost['preflight']>): ReturnType<ProjectHost['preflight']>;
  tlsFor(...args: Parameters<ProjectHost['tlsFor']>): ReturnType<ProjectHost['tlsFor']>;
  /** The environments a request can be sent under: its workspace's, else its project's. */
  sendEnvironments(requestId: string): ReturnType<ProjectHost['sendEnvironments']>;

  /** What the engine runs a send of one request in: its project, folder, environment and workspace. */
  runContextFor(...args: Parameters<ProjectHost['runContextFor']>): ReturnType<ProjectHost['runContextFor']>;

  // — an API's cached definition, routed by api id ——————————————————————————————————————————

  apiDefinitionDocuments(
    ...args: Parameters<ProjectHost['apiDefinitionDocuments']>
  ): ReturnType<ProjectHost['apiDefinitionDocuments']>;
  apiDefinitionText(
    ...args: Parameters<ProjectHost['apiDefinitionText']>
  ): ReturnType<ProjectHost['apiDefinitionText']>;
  exportApiDefinitionTo(
    ...args: Parameters<ProjectHost['exportApiDefinitionTo']>
  ): ReturnType<ProjectHost['exportApiDefinitionTo']>;

  // — routed by keystore id ———————————————————————————————————————————————————————————————

  inspectKeystore(...args: Parameters<ProjectHost['inspectKeystore']>): ReturnType<ProjectHost['inspectKeystore']>;
}
