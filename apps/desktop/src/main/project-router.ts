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

import type { ProjectHost } from './project-host.js';

/** Every `ProjectHost` method the `ipc/*.ts` modules drive, routed by entity id. */
export interface ProjectRouter {
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
  /**
   * Imports a definition into the addressed project. `project.addInterface` carries a target of
   * `{ projectId }` (or `{ newProjectName }`, which a later task resolves to a project first).
   */
  addInterface(
    projectId: string,
    ...args: Parameters<ProjectHost['addInterface']>
  ): ReturnType<ProjectHost['addInterface']>;
  /** Imports a parsed legacy SOAP project into the addressed project. */
  importLegacyProject(
    projectId: string,
    ...args: Parameters<ProjectHost['importLegacyProject']>
  ): ReturnType<ProjectHost['importLegacyProject']>;
  /** Writes an importer's scripts under the addressed project's `imported-scripts/`, never overwriting a file. */
  writeImportedScripts(
    projectId: string,
    ...args: Parameters<ProjectHost['writeImportedScripts']>
  ): ReturnType<ProjectHost['writeImportedScripts']>;
  /** Places a WebSocket API mapped from a non-contract file (a `.http` file) in one project. */
  importWsApi(
    projectId: string,
    ...args: Parameters<ProjectHost['importWsApi']>
  ): ReturnType<ProjectHost['importWsApi']>;
  /** Places a gRPC API mapped from a non-contract file, with no definition, in one project. */
  importGrpcApi(
    projectId: string,
    ...args: Parameters<ProjectHost['importGrpcApi']>
  ): ReturnType<ProjectHost['importGrpcApi']>;
  /** Adds the imported properties the addressed project does not have yet; existing names keep their value. */
  importProperties(
    projectId: string,
    ...args: Parameters<ProjectHost['importProperties']>
  ): ReturnType<ProjectHost['importProperties']>;
  /**
   * Places an imported OpenAPI-described API in the addressed project, caching its documents.
   * `api.importOpenApi` carries the same target union `project.addInterface` does.
   */
  addApi(projectId: string, ...args: Parameters<ProjectHost['addApi']>): ReturnType<ProjectHost['addApi']>;
  /** Places a WebSocket API imported from an AsyncAPI document in one project, caching its documents. */
  importAsyncApi(
    projectId: string,
    ...args: Parameters<ProjectHost['importAsyncApi']>
  ): ReturnType<ProjectHost['importAsyncApi']>;
  /** Places an imported gRPC API in one project, caching its `.proto` files. */
  addGrpcApi(projectId: string, ...args: Parameters<ProjectHost['addGrpcApi']>): ReturnType<ProjectHost['addGrpcApi']>;
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
  requestMeta(...args: Parameters<ProjectHost['requestMeta']>): ReturnType<ProjectHost['requestMeta']>;
  requestSource(...args: Parameters<ProjectHost['requestSource']>): ReturnType<ProjectHost['requestSource']>;
  sendAttachmentsFor(
    ...args: Parameters<ProjectHost['sendAttachmentsFor']>
  ): ReturnType<ProjectHost['sendAttachmentsFor']>;
  /** The endpoint a SOAP request is sent to under an environment; none when nothing resolves one. */
  endpointFor(...args: Parameters<ProjectHost['endpointFor']>): ReturnType<ProjectHost['endpointFor']>;
  dumpFileFor(...args: Parameters<ProjectHost['dumpFileFor']>): ReturnType<ProjectHost['dumpFileFor']>;
  tlsFor(...args: Parameters<ProjectHost['tlsFor']>): ReturnType<ProjectHost['tlsFor']>;
  /** The environments a request can be sent under: its workspace's, else its project's. */
  sendEnvironments(requestId: string): ReturnType<ProjectHost['sendEnvironments']>;

  /** The credentials configured on one API, folder or REST request — its own, not its chain's. */
  restAuthOf(...args: Parameters<ProjectHost['restAuthOf']>): ReturnType<ProjectHost['restAuthOf']>;

  /** The credentials configured on one SOAP interface, endpoint or request — its own, not its effective ones. */
  soapAuthOf(...args: Parameters<ProjectHost['soapAuthOf']>): ReturnType<ProjectHost['soapAuthOf']>;

  /** What History names a REST send by: the request, its API, and its folder path. */
  restMeta(...args: Parameters<ProjectHost['restMeta']>): ReturnType<ProjectHost['restMeta']>;
  restContractFor(...args: Parameters<ProjectHost['restContractFor']>): ReturnType<ProjectHost['restContractFor']>;
  /** The JSON schema of the body a REST request's operation declares, for the body editor's form. */
  restBodySchema(...args: Parameters<ProjectHost['restBodySchema']>): ReturnType<ProjectHost['restBodySchema']>;

  /** What the engine runs a send of one request in: its project, folder, environment and workspace. */
  runContextFor(...args: Parameters<ProjectHost['runContextFor']>): ReturnType<ProjectHost['runContextFor']>;
  /** The WSDL-derived default `wsa:Action` of a SOAP request's operation, from the loaded definition. */
  defaultWsaActionFor(
    ...args: Parameters<ProjectHost['defaultWsaActionFor']>
  ): ReturnType<ProjectHost['defaultWsaActionFor']>;

  /** What History names a gRPC send by: the request, its API, and its folder path. */
  grpcMeta(...args: Parameters<ProjectHost['grpcMeta']>): ReturnType<ProjectHost['grpcMeta']>;
  /** The credentials configured on one gRPC API, folder or request — its own, not its chain's. */
  grpcAuthOf(...args: Parameters<ProjectHost['grpcAuthOf']>): ReturnType<ProjectHost['grpcAuthOf']>;
  /** The loaded `.proto` set of the gRPC API owning `entityId`, from its cache. */
  grpcProtoSetFor(...args: Parameters<ProjectHost['grpcProtoSetFor']>): ReturnType<ProjectHost['grpcProtoSetFor']>;
  /** The services and files of a gRPC API's cached definition, for the renderer. */
  grpcDefinition(...args: Parameters<ProjectHost['grpcDefinition']>): ReturnType<ProjectHost['grpcDefinition']>;
  /** A sample message for one type of a gRPC API's definition. */
  grpcSample(...args: Parameters<ProjectHost['grpcSample']>): ReturnType<ProjectHost['grpcSample']>;
  /** The fields of the message at a path of JSON keys under one type. */
  grpcFields(...args: Parameters<ProjectHost['grpcFields']>): ReturnType<ProjectHost['grpcFields']>;
  /** Asks a reflection-sourced API's server to describe itself again. */
  grpcRefresh(
    ...args: Parameters<ProjectHost['refreshGrpcDefinition']>
  ): ReturnType<ProjectHost['refreshGrpcDefinition']>;
  /** The messages of a WebSocket request's contract channel, for checking its live frames. */
  wsContractFor(...args: Parameters<ProjectHost['wsContractFor']>): ReturnType<ProjectHost['wsContractFor']>;
  /** What History names a WebSocket send by: the request, its API, and its folder path. */
  wsMeta(...args: Parameters<ProjectHost['wsMeta']>): ReturnType<ProjectHost['wsMeta']>;
  hasOutgoingWss(...args: Parameters<ProjectHost['hasOutgoingWss']>): ReturnType<ProjectHost['hasOutgoingWss']>;
  validationTargetFor(
    ...args: Parameters<ProjectHost['validationTargetFor']>
  ): ReturnType<ProjectHost['validationTargetFor']>;
  insertWsaHeaders(...args: Parameters<ProjectHost['insertWsaHeaders']>): ReturnType<ProjectHost['insertWsaHeaders']>;
  removeWsaHeadersFrom(
    ...args: Parameters<ProjectHost['removeWsaHeadersFrom']>
  ): ReturnType<ProjectHost['removeWsaHeadersFrom']>;
  previewOutgoingWss(
    ...args: Parameters<ProjectHost['previewOutgoingWss']>
  ): ReturnType<ProjectHost['previewOutgoingWss']>;
  insertWssEntry(...args: Parameters<ProjectHost['insertWssEntry']>): ReturnType<ProjectHost['insertWssEntry']>;
  removeOutgoingWssFrom(
    ...args: Parameters<ProjectHost['removeOutgoingWssFrom']>
  ): ReturnType<ProjectHost['removeOutgoingWssFrom']>;
  resolveAttachmentPath(
    ...args: Parameters<ProjectHost['resolveAttachmentPath']>
  ): ReturnType<ProjectHost['resolveAttachmentPath']>;
  addAttachmentBytes(
    ...args: Parameters<ProjectHost['addAttachmentBytes']>
  ): ReturnType<ProjectHost['addAttachmentBytes']>;

  // — routed by interface id ——————————————————————————————————————————————————————————————

  planDefinitionUpdate(
    ...args: Parameters<ProjectHost['planDefinitionUpdate']>
  ): ReturnType<ProjectHost['planDefinitionUpdate']>;
  applyDefinitionUpdate(
    ...args: Parameters<ProjectHost['applyDefinitionUpdate']>
  ): ReturnType<ProjectHost['applyDefinitionUpdate']>;
  exportDefinitionTo(
    ...args: Parameters<ProjectHost['exportDefinitionTo']>
  ): ReturnType<ProjectHost['exportDefinitionTo']>;
  definitionDocs(...args: Parameters<ProjectHost['definitionDocs']>): ReturnType<ProjectHost['definitionDocs']>;

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
  /** Where an AsyncAPI-imported API's definition came from, for an update to re-read. */
  asyncApiSource(...args: Parameters<ProjectHost['asyncApiSource']>): ReturnType<ProjectHost['asyncApiSource']>;
  asyncApiPlanUpdate(
    ...args: Parameters<ProjectHost['planAsyncApiUpdate']>
  ): ReturnType<ProjectHost['planAsyncApiUpdate']>;
  asyncApiApplyUpdate(
    ...args: Parameters<ProjectHost['applyAsyncApiUpdate']>
  ): ReturnType<ProjectHost['applyAsyncApiUpdate']>;
  /** Where a REST API's definition came from, for an update to re-read. */
  restSource(...args: Parameters<ProjectHost['restSource']>): ReturnType<ProjectHost['restSource']>;
  restPlanUpdate(...args: Parameters<ProjectHost['planRestUpdate']>): ReturnType<ProjectHost['planRestUpdate']>;
  restApplyUpdate(...args: Parameters<ProjectHost['applyRestUpdate']>): ReturnType<ProjectHost['applyRestUpdate']>;
  /** An API's webhooks and callbacks, and which of their keys the group linked to it already holds. */
  webhookItems(...args: Parameters<ProjectHost['webhookItems']>): ReturnType<ProjectHost['webhookItems']>;
  /** Places the chosen webhooks/callbacks into the API's linked webhook group, creating it if needed. */
  importWebhooks(...args: Parameters<ProjectHost['importWebhooks']>): ReturnType<ProjectHost['importWebhooks']>;

  // — routed by keystore id ———————————————————————————————————————————————————————————————

  inspectKeystore(...args: Parameters<ProjectHost['inspectKeystore']>): ReturnType<ProjectHost['inspectKeystore']>;
}
