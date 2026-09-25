import { z } from 'zod';
import {
  apiCancelImportRequestSchema,
  apiCancelImportResponseSchema,
  apiDefinitionDocumentsResponseSchema,
  apiDefinitionTextRequestSchema,
  apiDefinitionTextResponseSchema,
  apiExportDefinitionResponseSchema,
  apiIdRequestSchema,
  apiAsyncApiServersRequestSchema,
  apiAsyncApiServersResponseSchema,
  apiImportAsyncApiRequestSchema,
  apiImportAsyncApiResponseSchema,
  apiAsyncApiApplyUpdateResponseSchema,
  apiAsyncApiApplyUpdateRequestSchema,
  apiAsyncApiPlanUpdateResponseSchema,
  apiRestApplyUpdateRequestSchema,
  apiRestApplyUpdateResponseSchema,
  apiRestPlanUpdateRequestSchema,
  apiRestPlanUpdateResponseSchema,
  apiImportOpenApiRequestSchema,
  apiImportOpenApiResponseSchema,
  apiImportPostmanRequestSchema,
  apiImportPostmanResponseSchema,
  apiImportProtoRequestSchema,
  apiImportProtoResponseSchema,
  apiGrpcDefinitionResponseSchema,
  apiGrpcRefreshRequestSchema,
  apiGrpcRefreshResponseSchema,
  apiGrpcFieldsRequestSchema,
  apiGrpcFieldsResponseSchema,
  apiGrpcSampleRequestSchema,
  apiGrpcSampleResponseSchema,
  grpcExchangeSummarySchema,
  grpcLiveEventSchema,
  wsExchangeSummarySchema,
  wsLiveEventSchema,
  requestOpenWsRequestSchema,
  requestWsSendRequestSchema,
  requestWsSendResponseSchema,
  requestWsCloseRequestSchema,
  requestWsCloseResponseSchema,
  requestPreflightWsRequestSchema,
  requestGrpcHalfCloseRequestSchema,
  requestGrpcHalfCloseResponseSchema,
  requestGrpcPushRequestSchema,
  requestGrpcPushResponseSchema,
  requestPreflightGrpcRequestSchema,
  requestSendGrpcRequestSchema,
  oauth2OwnerRequestSchema,
  oauth2StatusSchema,
  requestPreflightRestRequestSchema,
  requestSendRestRequestSchema,
  requestSendToEnvironmentsRequestSchema,
  requestSendToEnvironmentsResponseSchema,
  restExchangeSummarySchema,
  restLiveEventSchema,
  definitionCancelImportRequestSchema,
  definitionCancelImportResponseSchema,
  definitionCloseRequestSchema,
  definitionCloseResponseSchema,
  definitionApplyUpdateRequestSchema,
  definitionApplyUpdateResponseSchema,
  definitionDeclarationAtRequestSchema,
  definitionDeclarationAtResponseSchema,
  definitionDocumentsResponseSchema,
  definitionExportRequestSchema,
  definitionExportResponseSchema,
  definitionGenerateDocsRequestSchema,
  definitionGenerateDocsResponseSchema,
  definitionPlanUpdateRequestSchema,
  definitionUpdatePlanResponseSchema,
  definitionDocumentTextRequestSchema,
  definitionDocumentTextResponseSchema,
  definitionImportRequestSchema,
  definitionInterfaceRequestSchema,
  definitionSchemaIndexResponseSchema,
  appRegisterMenuRequestSchema,
  appUpdateStatusSchema,
  appRegisterMenuResponseSchema,
  commandInvokeEventSchema,
  themeChangedEventSchema,
  themeGetResponseSchema,
  searchQueryRequestSchema,
  searchQueryResponseSchema,
  dialogsOpenFileRequestSchema,
  dialogsOpenFileResponseSchema,
  dialogsSaveFileRequestSchema,
  dialogsSaveFileResponseSchema,
  preferencesResetRequestSchema,
  preferencesResponseSchema,
  preferencesUpdateRequestSchema,
  sslClearCaBundleRequestSchema,
  sslClearCaBundleResponseSchema,
  sslPickCaBundleRequestSchema,
  sslPickCaBundleResponseSchema,
  gitDetectRequestSchema,
  gitDetectResponseSchema,
  gitLocateRequestSchema,
  gitLocateResponseSchema,
  gitClearPathRequestSchema,
  gitClearPathResponseSchema,
  gitIdentityNeededEventSchema,
  syncStatusWireSchema,
  syncCommitRequestSchema,
  syncConflictsResponseSchema,
  syncResolveRequestSchema,
  syncLogRequestSchema,
  syncLogResponseSchema,
  syncSettingsPatchWireSchema,
  syncSetIdentityRequestSchema,
  syncSetIdentityResponseSchema,
  syncRevealTreeRequestSchema,
  syncRevealTreeResponseSchema,
  syncStatusChangedEventSchema,
  syncConflictEventSchema,
  syncPulledEventSchema,
  workspaceShareRequestSchema,
  workspaceJoinRequestSchema,
  workspaceShareToServerRequestWireSchema,
  workspaceJoinFromServerRequestWireSchema,
  workspaceServerTargetsRequestWireSchema,
  workspaceServerTargetsResponseWireSchema,
  workspaceTeamWorkspacesResponseWireSchema,
  workspaceChangedOnDiskEventSchema,
  projectMoveToWorkspaceRequestSchema,
  engineProgressEventSchema,
  exchangeFailedEventSchema,
  exchangeLoggedEventSchema,
  exchangeSummarySchema,
  exchangesGetRequestSchema,
  exchangesGetResponseSchema,
  exchangesSaveRestBodyRequestSchema,
  exchangesSaveRestBodyResponseSchema,
  globalsStateSchema,
  historyAppendedEventSchema,
  historyClearResponseSchema,
  historyGetRequestSchema,
  historyGetResponseSchema,
  historyListRequestSchema,
  historyListResponseSchema,
  historyResendRequestSchema,
  historyResendGrpcRequestSchema,
  snapshotReadResponseSchema,
  snapshotRemoveResponseSchema,
  snapshotRequestSchema,
  snapshotSavedResponseSchema,
  snapshotSetIgnoreRequestSchema,
  snapshotWriteRequestSchema,
  globalsRemoveRequestSchema,
  globalsSetEnabledRequestSchema,
  globalsSetRequestSchema,
  projectAddInterfaceRequestSchema,
  projectAddInterfaceResponseSchema,
  projectImportLegacyRequestSchema,
  projectImportLegacyResponseSchema,
  projectChangedEventSchema,
  projectChangedOnDiskEventSchema,
  projectHydrationEventSchema,
  projectMutateRequestSchema,
  projectMutateResponseSchema,
  projectIdRequestSchema,
  projectSaveResponseSchema,
  projectSnapshotResponseSchema,
  interfaceSummarySchema,
  requestCancelRequestSchema,
  requestCancelResponseSchema,
  requestGenerateRequestSchema,
  requestGenerateResponseSchema,
  requestPreflightRequestSchema,
  requestPreflightResponseSchema,
  requestRecreateRequestSchema,
  requestRecreateResponseSchema,
  requestCurlRequestSchema,
  requestCurlResponseSchema,
  logCurlRequestSchema,
  logExportHarRequestSchema,
  logExportHarResponseSchema,
  logResendRequestSchema,
  logResendResponseSchema,
  requestImportCurlRequestSchema,
  requestImportCurlResponseSchema,
  requestRestBodySchemaRequestSchema,
  requestRestBodySchemaResponseSchema,
  requestSendRequestSchema,
  secretsDeleteRequestSchema,
  secretsDeleteResponseSchema,
  secretsExistsRequestSchema,
  secretsExistsResponseSchema,
  secretsListResponseSchema,
  secretsRefResponseSchema,
  secretsReplaceRequestSchema,
  secretsSetRequestSchema,
  secretsSetShowSecretsRequestSchema,
  secretsShowSecretsResponseSchema,
  secretScanHoldRequestSchema,
  secretScanHoldResponseSchema,
  secretScanKeepRequestSchema,
  secretScanKeepResponseSchema,
  secretScanMoveRequestSchema,
  secretScanMoveResponseSchema,
  secretScanReleaseRequestSchema,
  secretScanReleaseResponseSchema,
  secretScanScanRequestSchema,
  secretScanScanResponseSchema,
  secretScanSetValueRequestSchema,
  secretScanSetValueResponseSchema,
  secretScanTokensRequestSchema,
  secretScanTokensResponseSchema,
  xmlCompletionsRequestSchema,
  xmlCompletionsResponseSchema,
  xmlPathRequestSchema,
  xmlDeclarationResponseSchema,
  xmlDescribeManyRequestSchema,
  xmlDescribeManyResponseSchema,
  xmlFormRequestSchema,
  xmlFormResponseSchema,
  xmlApplyFormEditRequestSchema,
  xmlApplyFormEditResponseSchema,
  attachmentsAddDroppedRequestSchema,
  attachmentsAddDroppedResponseSchema,
  attachmentsOpenRequestRequestSchema,
  attachmentsOpenResponseRequestSchema,
  attachmentsOpenResponseSchema,
  attachmentsPickFilesRequestSchema,
  wsaInsertHeadersRequestSchema,
  wsaRemoveHeadersRequestSchema,
  wsaEnvelopeResponseSchema,
  wssPreviewOutgoingRequestSchema,
  wssInsertEntryRequestSchema,
  wssRemoveOutgoingRequestSchema,
  wssEnvelopeResponseSchema,
  keystoresInspectRequestSchema,
  keystoresInspectResponseSchema,
  keystoresPickFileRequestSchema,
  keystoresPickFileResponseSchema,
  attachmentsPickFilesResponseSchema,
  attachmentsSaveResponseRequestSchema,
  attachmentsSaveResponseResponseSchema,
  fsSaveTextRequestSchema,
  fsSaveTextResponseSchema,
  fsOpenTextRequestSchema,
  fsOpenTextResponseSchema,
  xpathEvaluateRequestSchema,
  xpathEvaluateResponseSchema,
  xpathNamespacesRequestSchema,
  xpathNamespacesResponseSchema,
  validateMessageRequestSchema,
  validateMessageResponseSchema,
  wsiCheckExchangeRequestSchema,
  wsiCheckWsdlRequestSchema,
  wsiExportHtmlRequestSchema,
  wsiExportHtmlResponseSchema,
  wsiReportWireSchema,
  workspaceAddProjectRequestSchema,
  workspaceAddProjectResponseSchema,
  workspaceChangedEventSchema,
  workspaceFlushDraftsEventSchema,
  workspaceRestoredResponseSchema,
  workspaceStashDraftsRequestSchema,
  workspaceCreateRequestSchema,
  workspaceExportProjectResponseSchema,
  workspaceIdRequestSchema,
  workspaceImportSuggestionRequestSchema,
  workspaceImportSuggestionResponseSchema,
  workspaceListResponseSchema,
  workspaceMutateRequestSchema,
  workspaceMutateResponseSchema,
  workspaceProjectIdRequestSchema,
  workspaceRemoveProjectRequestSchema,
  workspaceRenameRequestSchema,
  workspaceResponseSchema,
  workspaceRevealResponseSchema,
  workspaceSetActiveEnvironmentRequestSchema,
  workspaceSnapshotResponseSchema,
  workspaceSummariesResponseSchema,
  accountListResponseSchema,
  accountUrlRequestSchema,
  accountProbeResponseSchema,
  accountSignInLocalRequestSchema,
  accountStartOidcRequestSchema,
  accountResponseSchema,
  accountLookupInvitationRequestSchema,
  accountLookupInvitationResponseSchema,
  accountAcceptInvitationRequestSchema,
  accountCancelResponseSchema,
  accountChangedEventSchema,
  teamServerRequestWireSchema,
  teamCreateRequestWireSchema,
  teamRenameRequestWireSchema,
  teamRefRequestWireSchema,
  teamAddMemberRequestWireSchema,
  teamMemberRoleRequestWireSchema,
  teamMemberRefRequestWireSchema,
  teamInviteRequestWireSchema,
  teamInvitationRefRequestWireSchema,
  teamCreateWorkspaceRequestWireSchema,
  teamWorkspaceRefRequestWireSchema,
  teamUpdateWorkspaceRequestWireSchema,
  teamSetAccessRequestWireSchema,
  teamAccessRefRequestWireSchema,
  teamListResponseWireSchema,
  teamResponseWireSchema,
  teamMembersResponseWireSchema,
  teamMemberResponseWireSchema,
  teamInvitationsResponseWireSchema,
  teamInviteResponseWireSchema,
  teamWorkspacesResponseWireSchema,
  teamWorkspaceResponseWireSchema,
  teamAccessResponseWireSchema,
  teamDoneResponseWireSchema,
} from './wire-types.js';

/**
 * A typed request/response contract for one `ipcMain.handle` / `ipcRenderer.invoke` pair.
 * Carries the channel name plus the zod schemas used to validate both directions, so main
 * and renderer share a single source of truth for the wire shape.
 */
export interface IpcChannel<Req extends z.ZodType, Res extends z.ZodType> {
  readonly name: string;
  readonly request: Req;
  readonly response: Res;
}

/**
 * Declares one IPC channel. The returned object is passed to both
 * `registerHandler` (main process) and the preload API builder so the request/response
 * shape only needs to be written once.
 */
export function defineChannel<Req extends z.ZodType, Res extends z.ZodType>(
  name: string,
  request: Req,
  response: Res,
): IpcChannel<Req, Res> {
  return { name, request, response };
}

/** The parsed request payload type for a given {@link IpcChannel}. */
export type ChannelRequest<C> = C extends IpcChannel<infer Req, z.ZodType> ? z.infer<Req> : never;

/** The parsed response payload type for a given {@link IpcChannel}. */
export type ChannelResponse<C> = C extends IpcChannel<z.ZodType, infer Res> ? z.infer<Res> : never;

/** Wire shape for an IPC failure, safe to send across the context bridge. */
export const ipcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** The error shape produced by {@link ipcErrorSchema}. */
export type IpcError = z.infer<typeof ipcErrorSchema>;

/**
 * Envelope returned by every `invoke` call: either a validated success value, or a
 * serialisable error. Renderer code must check `ok` before reading `value`/`error`.
 */
export type IpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: IpcError };

/** The registry of request/response IPC channels shared by main, preload, and renderer. */
export const channels = {
  app: {
    version: defineChannel(
      'app.version',
      z.undefined(),
      z.object({
        version: z.string(),
        electron: z.string(),
        node: z.string(),
      }),
    ),
    /**
     * The renderer hands main the command manifest to build the application menu from. Sent
     * once per window at startup, and again whenever the effective keymap changes.
     */
    registerMenu: defineChannel('app.registerMenu', appRegisterMenuRequestSchema, appRegisterMenuResponseSchema),
    /**
     * Runs one update check (the "Check for Updates…" command). Nothing is downloaded or
     * installed without a further, separate confirmation from the user; see `main/updater.ts`.
     */
    checkForUpdates: defineChannel('app.checkForUpdates', z.undefined(), appUpdateStatusSchema),
  },
  search: {
    /**
     * Project-wide find. Runs in main so cached definition documents are searched where they
     * already live: only matching lines come back, never the documents themselves.
     */
    query: defineChannel('search.query', searchQueryRequestSchema, searchQueryResponseSchema),
  },
  definition: {
    import: defineChannel('definition.import', definitionImportRequestSchema, interfaceSummarySchema),
    close: defineChannel('definition.close', definitionCloseRequestSchema, definitionCloseResponseSchema),
    cancelImport: defineChannel(
      'definition.cancelImport',
      definitionCancelImportRequestSchema,
      definitionCancelImportResponseSchema,
    ),
    documents: defineChannel(
      'definition.documents',
      definitionInterfaceRequestSchema,
      definitionDocumentsResponseSchema,
    ),
    documentText: defineChannel(
      'definition.documentText',
      definitionDocumentTextRequestSchema,
      definitionDocumentTextResponseSchema,
    ),
    schemaIndex: defineChannel(
      'definition.schemaIndex',
      definitionInterfaceRequestSchema,
      definitionSchemaIndexResponseSchema,
    ),
    declarationAt: defineChannel(
      'definition.declarationAt',
      definitionDeclarationAtRequestSchema,
      definitionDeclarationAtResponseSchema,
    ),
    planUpdate: defineChannel(
      'definition.planUpdate',
      definitionPlanUpdateRequestSchema,
      definitionUpdatePlanResponseSchema,
    ),
    applyUpdate: defineChannel(
      'definition.applyUpdate',
      definitionApplyUpdateRequestSchema,
      definitionApplyUpdateResponseSchema,
    ),
    export: defineChannel('definition.export', definitionExportRequestSchema, definitionExportResponseSchema),
    generateDocs: defineChannel(
      'definition.generateDocs',
      definitionGenerateDocsRequestSchema,
      definitionGenerateDocsResponseSchema,
    ),
  },
  request: {
    generate: defineChannel('request.generate', requestGenerateRequestSchema, requestGenerateResponseSchema),
    send: defineChannel('request.send', requestSendRequestSchema, exchangeSummarySchema),
    /**
     * A REST send. Separate from `request.send` rather than a discriminated union of it: the two
     * payloads share no fields — one carries an envelope the user typed, the other a request id and
     * the editor's draft — and one channel for both would give every SOAP call a kind tag it never
     * reads.
     */
    sendRest: defineChannel('request.sendRest', requestSendRestRequestSchema, restExchangeSummarySchema),
    /**
     * One saved request sent under several environments in parallel, each resolved in main as if
     * it were active. `request.cancel` with the `batchId` stops every send still running.
     */
    sendToEnvironments: defineChannel(
      'request.sendToEnvironments',
      requestSendToEnvironmentsRequestSchema,
      requestSendToEnvironmentsResponseSchema,
    ),
    preflightRest: defineChannel(
      'request.preflightRest',
      requestPreflightRestRequestSchema,
      requestPreflightResponseSchema,
    ),
    /** A gRPC send: its own channel for the same reason `sendRest` is, and its own summary shape. */
    sendGrpc: defineChannel('request.sendGrpc', requestSendGrpcRequestSchema, grpcExchangeSummarySchema),
    preflightGrpc: defineChannel(
      'request.preflightGrpc',
      requestPreflightGrpcRequestSchema,
      requestPreflightResponseSchema,
    ),
    /**
     * One more message on a gRPC call opened with `interactive`. An ordinary invoke rather than a
     * channel of its own kind: the call it belongs to is named by the same `sendId` the send used,
     * which is how `request.cancel` already addresses a send in flight.
     */
    grpcPush: defineChannel('request.grpcPush', requestGrpcPushRequestSchema, requestGrpcPushResponseSchema),
    /** Half-closes an interactive gRPC call's request side; the server may still be answering. */
    grpcHalfClose: defineChannel(
      'request.grpcHalfClose',
      requestGrpcHalfCloseRequestSchema,
      requestGrpcHalfCloseResponseSchema,
    ),
    /**
     * Opens a WebSocket session from a saved request and drives it by `sendId`: this invoke stays
     * pending for the life of the session and resolves with the whole exchange once it closes,
     * while `events.ws.live` reports the handshake and each frame as they happen.
     */
    openWs: defineChannel('request.openWs', requestOpenWsRequestSchema, wsExchangeSummarySchema),
    /** One message on an open WebSocket session, named by the same `sendId` the open used. */
    wsSend: defineChannel('request.wsSend', requestWsSendRequestSchema, requestWsSendResponseSchema),
    /** Closes an open WebSocket session. `{ closed: false }` when no such session is open. */
    wsClose: defineChannel('request.wsClose', requestWsCloseRequestSchema, requestWsCloseResponseSchema),
    preflightWs: defineChannel('request.preflightWs', requestPreflightWsRequestSchema, requestPreflightResponseSchema),
    cancel: defineChannel('request.cancel', requestCancelRequestSchema, requestCancelResponseSchema),
    preflight: defineChannel('request.preflight', requestPreflightRequestSchema, requestPreflightResponseSchema),
    recreate: defineChannel('request.recreate', requestRecreateRequestSchema, requestRecreateResponseSchema),
    curl: defineChannel('request.curl', requestCurlRequestSchema, requestCurlResponseSchema),
    importCurl: defineChannel('request.importCurl', requestImportCurlRequestSchema, requestImportCurlResponseSchema),
    /** The JSON schema of the body a REST request's operation declares, or `null`; feeds the body form. */
    restBodySchema: defineChannel(
      'request.restBodySchema',
      requestRestBodySchemaRequestSchema,
      requestRestBodySchemaResponseSchema,
    ),
  },
  /**
   * Obtaining an OAuth2 token. Every call names the entity whose configuration to use, never the
   * configuration itself: the client secret is a keychain reference main resolves, and the access
   * token comes back only as a status unless the session shows secrets.
   */
  oauth2: {
    fetchToken: defineChannel('oauth2.fetchToken', oauth2OwnerRequestSchema, oauth2StatusSchema),
    status: defineChannel('oauth2.status', oauth2OwnerRequestSchema, oauth2StatusSchema),
    clearToken: defineChannel('oauth2.clearToken', oauth2OwnerRequestSchema, oauth2StatusSchema),
    cancel: defineChannel('oauth2.cancel', oauth2OwnerRequestSchema.partial(), requestCancelResponseSchema),
  },
  /**
   * Accounts on Wirebench Server. A password crosses exactly once, in `signInLocal` or
   * `acceptInvitation`; the token never crosses at all — main keeps it in the secret store and
   * answers with the account minus its ref.
   */
  account: {
    list: defineChannel('account.list', z.undefined(), accountListResponseSchema),
    probe: defineChannel('account.probe', accountUrlRequestSchema, accountProbeResponseSchema),
    signInLocal: defineChannel('account.signInLocal', accountSignInLocalRequestSchema, accountResponseSchema),
    /** Resolves when the browser hand-off has completed; `cancelSignIn` ends it early. */
    startOidc: defineChannel('account.startOidc', accountStartOidcRequestSchema, accountResponseSchema),
    cancelSignIn: defineChannel('account.cancelSignIn', z.undefined(), accountCancelResponseSchema),
    lookupInvitation: defineChannel(
      'account.lookupInvitation',
      accountLookupInvitationRequestSchema,
      accountLookupInvitationResponseSchema,
    ),
    acceptInvitation: defineChannel(
      'account.acceptInvitation',
      accountAcceptInvitationRequestSchema,
      accountResponseSchema,
    ),
    signOut: defineChannel('account.signOut', accountUrlRequestSchema, accountListResponseSchema),
    remove: defineChannel('account.remove', accountUrlRequestSchema, accountListResponseSchema),
  },
  /**
   * Teams on Wirebench Server (teams-access §3.5). Every request names the server by `url`; main
   * adds that account's token, and a server that no longer accepts it marks the account signed out.
   */
  team: {
    list: defineChannel('team.list', teamServerRequestWireSchema, teamListResponseWireSchema),
    create: defineChannel('team.create', teamCreateRequestWireSchema, teamResponseWireSchema),
    rename: defineChannel('team.rename', teamRenameRequestWireSchema, teamResponseWireSchema),
    delete: defineChannel('team.delete', teamRefRequestWireSchema, teamDoneResponseWireSchema),
    members: defineChannel('team.members', teamRefRequestWireSchema, teamMembersResponseWireSchema),
    addMember: defineChannel('team.addMember', teamAddMemberRequestWireSchema, teamMemberResponseWireSchema),
    setMemberRole: defineChannel('team.setMemberRole', teamMemberRoleRequestWireSchema, teamMemberResponseWireSchema),
    removeMember: defineChannel('team.removeMember', teamMemberRefRequestWireSchema, teamDoneResponseWireSchema),
    invitations: defineChannel('team.invitations', teamRefRequestWireSchema, teamInvitationsResponseWireSchema),
    invite: defineChannel('team.invite', teamInviteRequestWireSchema, teamInviteResponseWireSchema),
    revokeInvitation: defineChannel(
      'team.revokeInvitation',
      teamInvitationRefRequestWireSchema,
      teamDoneResponseWireSchema,
    ),
    /** What a member can open, with role and source; `server-sync`'s join dialog reads it too (§3.6). */
    listWorkspaces: defineChannel('team.listWorkspaces', teamServerRequestWireSchema, teamWorkspacesResponseWireSchema),
    createWorkspace: defineChannel(
      'team.createWorkspace',
      teamCreateWorkspaceRequestWireSchema,
      teamWorkspaceResponseWireSchema,
    ),
    updateWorkspace: defineChannel(
      'team.updateWorkspace',
      teamUpdateWorkspaceRequestWireSchema,
      teamWorkspaceResponseWireSchema,
    ),
    deleteWorkspace: defineChannel(
      'team.deleteWorkspace',
      teamWorkspaceRefRequestWireSchema,
      teamDoneResponseWireSchema,
    ),
    access: defineChannel('team.access', teamWorkspaceRefRequestWireSchema, teamAccessResponseWireSchema),
    setAccess: defineChannel('team.setAccess', teamSetAccessRequestWireSchema, teamDoneResponseWireSchema),
    clearAccess: defineChannel('team.clearAccess', teamAccessRefRequestWireSchema, teamDoneResponseWireSchema),
  },
  // An API and the definition it was imported from. Separate from `definition.*` because the two
  // describe different things — a WSDL bundle is resolved into memory and stays there, an OpenAPI
  // definition is read back from its cache on demand — and nothing here addresses an interface.
  api: {
    importOpenApi: defineChannel('api.importOpenApi', apiImportOpenApiRequestSchema, apiImportOpenApiResponseSchema),
    importPostman: defineChannel('api.importPostman', apiImportPostmanRequestSchema, apiImportPostmanResponseSchema),
    importAsyncApi: defineChannel(
      'api.importAsyncApi',
      apiImportAsyncApiRequestSchema,
      apiImportAsyncApiResponseSchema,
    ),
    /** Reads an AsyncAPI document's WebSocket servers, for the Import dialog's server picker. */
    asyncApiServers: defineChannel(
      'api.asyncApiServers',
      apiAsyncApiServersRequestSchema,
      apiAsyncApiServersResponseSchema,
    ),
    /** Re-reads an AsyncAPI-imported API's source and reports what updating to it would change. */
    asyncApiPlanUpdate: defineChannel(
      'api.asyncApiPlanUpdate',
      apiIdRequestSchema,
      apiAsyncApiPlanUpdateResponseSchema,
    ),
    /** Applies that update: orphans, adds and rewrites requests, rewrites the cache, and saves. */
    asyncApiApplyUpdate: defineChannel(
      'api.asyncApiApplyUpdate',
      apiAsyncApiApplyUpdateRequestSchema,
      apiAsyncApiApplyUpdateResponseSchema,
    ),
    /** Reads a REST API's source (or a chosen one) and reports what updating to it would change. */
    restPlanUpdate: defineChannel(
      'api.restPlanUpdate',
      apiRestPlanUpdateRequestSchema,
      apiRestPlanUpdateResponseSchema,
    ),
    /** Applies that update: orphans, adds and rewrites requests, rewrites the cache, and saves. */
    restApplyUpdate: defineChannel(
      'api.restApplyUpdate',
      apiRestApplyUpdateRequestSchema,
      apiRestApplyUpdateResponseSchema,
    ),
    importProto: defineChannel('api.importProto', apiImportProtoRequestSchema, apiImportProtoResponseSchema),
    /** The services and files of a gRPC API's cached `.proto` set, for the method picker. */
    grpcDefinition: defineChannel('api.grpcDefinition', apiIdRequestSchema, apiGrpcDefinitionResponseSchema),
    /** A sample message for one type of a gRPC API's definition. */
    grpcSample: defineChannel('api.grpcSample', apiGrpcSampleRequestSchema, apiGrpcSampleResponseSchema),
    grpcFields: defineChannel('api.grpcFields', apiGrpcFieldsRequestSchema, apiGrpcFieldsResponseSchema),
    /** Asks a reflection-sourced API's server to describe itself again. */
    grpcRefresh: defineChannel('api.grpcRefresh', apiGrpcRefreshRequestSchema, apiGrpcRefreshResponseSchema),
    cancelImport: defineChannel('api.cancelImport', apiCancelImportRequestSchema, apiCancelImportResponseSchema),
    definitionDocuments: defineChannel(
      'api.definitionDocuments',
      apiIdRequestSchema,
      apiDefinitionDocumentsResponseSchema,
    ),
    definitionText: defineChannel(
      'api.definitionText',
      apiDefinitionTextRequestSchema,
      apiDefinitionTextResponseSchema,
    ),
    exportDefinition: defineChannel('api.exportDefinition', apiIdRequestSchema, apiExportDefinitionResponseSchema),
  },
  // A workspace owns its projects: creating, opening and closing one is a `workspace.*` call,
  // not a `project.*` one. What is left here addresses *one* project of the open workspace,
  // named by `projectId` — never by a path, which the renderer never sees or sends.
  project: {
    snapshot: defineChannel('project.snapshot', projectIdRequestSchema, projectSnapshotResponseSchema),
    mutate: defineChannel('project.mutate', projectMutateRequestSchema, projectMutateResponseSchema),
    save: defineChannel('project.save', projectIdRequestSchema, projectSaveResponseSchema),
    addInterface: defineChannel(
      'project.addInterface',
      projectAddInterfaceRequestSchema,
      projectAddInterfaceResponseSchema,
    ),
    /** Imports a legacy single-XML SOAP project file into a project, answering with what came across. */
    importLegacy: defineChannel(
      'project.importLegacy',
      projectImportLegacyRequestSchema,
      projectImportLegacyResponseSchema,
    ),
    moveToWorkspace: defineChannel(
      'project.moveToWorkspace',
      projectMoveToWorkspaceRequestSchema,
      workspaceResponseSchema,
    ),
    reload: defineChannel('project.reload', projectIdRequestSchema, projectSnapshotResponseSchema),
  },
  // The workspace itself: the picker, the open workspace's manifest, and the project
  // membership operations. `linkProject`, `importProjectFolder`, `exportProject` and
  // `locateProject` take no path — each runs its own native dialog in main and records the
  // pick, so a folder outside the workspace is only ever one the user chose in person.
  workspace: {
    list: defineChannel('workspace.list', z.undefined(), workspaceListResponseSchema),
    create: defineChannel('workspace.create', workspaceCreateRequestSchema, workspaceResponseSchema),
    open: defineChannel('workspace.open', workspaceIdRequestSchema, workspaceResponseSchema),
    close: defineChannel('workspace.close', z.undefined(), workspaceSnapshotResponseSchema),
    snapshot: defineChannel('workspace.snapshot', z.undefined(), workspaceSnapshotResponseSchema),
    // Unsaved changes across sessions: the renderer hands main its staged request edits (kept with
    // the workspace, never written to a project), and takes back what the last open restored.
    stashDrafts: defineChannel(
      'workspace.stashDrafts',
      workspaceStashDraftsRequestSchema,
      workspaceRevealResponseSchema,
    ),
    takeRestored: defineChannel('workspace.takeRestored', z.undefined(), workspaceRestoredResponseSchema),
    rename: defineChannel('workspace.rename', workspaceRenameRequestSchema, workspaceSummariesResponseSchema),
    delete: defineChannel('workspace.delete', workspaceIdRequestSchema, workspaceSummariesResponseSchema),
    addProject: defineChannel(
      'workspace.addProject',
      workspaceAddProjectRequestSchema,
      workspaceAddProjectResponseSchema,
    ),
    linkProject: defineChannel('workspace.linkProject', z.undefined(), workspaceSnapshotResponseSchema),
    importProjectFolder: defineChannel('workspace.importProjectFolder', z.undefined(), workspaceSnapshotResponseSchema),
    // One of `workspace.list`'s suggestions, by position; creates a workspace when none is open.
    importSuggestion: defineChannel(
      'workspace.importSuggestion',
      workspaceImportSuggestionRequestSchema,
      workspaceImportSuggestionResponseSchema,
    ),
    // Shows a workspace's folder in the OS file manager — the way out for an unreadable row.
    reveal: defineChannel('workspace.reveal', workspaceIdRequestSchema, workspaceRevealResponseSchema),
    // The same for one project's folder, by id: main holds the path, the renderer never does.
    revealProject: defineChannel(
      'workspace.revealProject',
      workspaceProjectIdRequestSchema,
      workspaceRevealResponseSchema,
    ),
    exportProject: defineChannel(
      'workspace.exportProject',
      workspaceProjectIdRequestSchema,
      workspaceExportProjectResponseSchema,
    ),
    locateProject: defineChannel(
      'workspace.locateProject',
      workspaceProjectIdRequestSchema,
      workspaceSnapshotResponseSchema,
    ),
    removeProject: defineChannel(
      'workspace.removeProject',
      workspaceRemoveProjectRequestSchema,
      workspaceResponseSchema,
    ),
    setActiveEnvironment: defineChannel(
      'workspace.setActiveEnvironment',
      workspaceSetActiveEnvironmentRequestSchema,
      workspaceResponseSchema,
    ),
    mutate: defineChannel('workspace.mutate', workspaceMutateRequestSchema, workspaceMutateResponseSchema),
    // Share/join/stop: none of these takes a filesystem path either — `shareToFolder` and
    // `joinFromFolder` run their own native dialog in main, exactly like `linkProject`.
    share: defineChannel('workspace.share', workspaceShareRequestSchema, workspaceResponseSchema),
    shareToFolder: defineChannel('workspace.shareToFolder', z.undefined(), workspaceSnapshotResponseSchema),
    join: defineChannel('workspace.join', workspaceJoinRequestSchema, workspaceResponseSchema),
    joinFromFolder: defineChannel('workspace.joinFromFolder', z.undefined(), workspaceSnapshotResponseSchema),
    stopSharing: defineChannel('workspace.stopSharing', z.undefined(), workspaceResponseSchema),
    // Wirebench Server (server-sync §3.4). No path here either: main checks the url and every id,
    // and a workspace id only becomes a folder after it has matched a ULID there.
    shareToServer: defineChannel(
      'workspace.shareToServer',
      workspaceShareToServerRequestWireSchema,
      workspaceResponseSchema,
    ),
    joinFromServer: defineChannel(
      'workspace.joinFromServer',
      workspaceJoinFromServerRequestWireSchema,
      workspaceResponseSchema,
    ),
    // The share dialog's *existing empty workspace* list (O1), and *Open a team workspace…*'s rows.
    serverTargets: defineChannel(
      'workspace.serverTargets',
      workspaceServerTargetsRequestWireSchema,
      workspaceServerTargetsResponseWireSchema,
    ),
    teamWorkspaces: defineChannel('workspace.teamWorkspaces', z.undefined(), workspaceTeamWorkspacesResponseWireSchema),
  },
  globals: {
    get: defineChannel('globals.get', z.undefined(), globalsStateSchema),
    set: defineChannel('globals.set', globalsSetRequestSchema, globalsStateSchema),
    remove: defineChannel('globals.remove', globalsRemoveRequestSchema, globalsStateSchema),
    setEnabled: defineChannel('globals.setEnabled', globalsSetEnabledRequestSchema, globalsStateSchema),
  },
  theme: {
    /** The OS colour scheme right now; the renderer asks once at startup, then listens. */
    get: defineChannel('theme.get', z.undefined(), themeGetResponseSchema),
  },
  dialogs: {
    openFile: defineChannel('dialogs.openFile', dialogsOpenFileRequestSchema, dialogsOpenFileResponseSchema),
    saveFile: defineChannel('dialogs.saveFile', dialogsSaveFileRequestSchema, dialogsSaveFileResponseSchema),
  },
  preferences: {
    get: defineChannel('preferences.get', z.undefined(), preferencesResponseSchema),
    update: defineChannel('preferences.update', preferencesUpdateRequestSchema, preferencesResponseSchema),
    reset: defineChannel('preferences.reset', preferencesResetRequestSchema, preferencesResponseSchema),
  },
  // The CA bundle preference has channels of its own because only main may set it: the path is
  // a file main reads on every send, so it comes from a native picker main ran, never from a
  // string the renderer sends (`preferences.update` refuses one).
  ssl: {
    pickCaBundle: defineChannel('ssl.pickCaBundle', sslPickCaBundleRequestSchema, sslPickCaBundleResponseSchema),
    clearCaBundle: defineChannel('ssl.clearCaBundle', sslClearCaBundleRequestSchema, sslClearCaBundleResponseSchema),
  },
  // The git executable preference has channels of its own for the same reason `ssl` does: main
  // *executes* the path (a stricter reason than reading), so it must come from discovery or a
  // native picker main ran itself, never from a string the renderer sends.
  git: {
    detect: defineChannel('git.detect', gitDetectRequestSchema, gitDetectResponseSchema),
    locate: defineChannel('git.locate', gitLocateRequestSchema, gitLocateResponseSchema),
    clearPath: defineChannel('git.clearPath', gitClearPathRequestSchema, gitClearPathResponseSchema),
  },
  // Drives the open workspace's `SyncService`. Every handler either routes to `WorkspaceService.sync()`
  // or throws `sync-not-supported` for a local (unshared) workspace — `sync.status` is the one
  // exception, answering with a synthetic `kind: 'local'` status instead so the badge never needs
  // a special case. `revealTree`'s `path`, when present, is tree-relative and produced by main
  // itself (a conflict entry) — it is joined to the tree and containment-checked before main
  // shows it in the file manager, never a filesystem path the renderer made up.
  sync: {
    status: defineChannel('sync.status', z.undefined(), syncStatusWireSchema),
    fetch: defineChannel('sync.fetch', z.undefined(), syncStatusWireSchema),
    pull: defineChannel('sync.pull', z.undefined(), syncStatusWireSchema),
    push: defineChannel('sync.push', z.undefined(), syncStatusWireSchema),
    commit: defineChannel('sync.commit', syncCommitRequestSchema, syncStatusWireSchema),
    conflicts: defineChannel('sync.conflicts', z.undefined(), syncConflictsResponseSchema),
    resolve: defineChannel('sync.resolve', syncResolveRequestSchema, syncStatusWireSchema),
    abortMerge: defineChannel('sync.abortMerge', z.undefined(), syncStatusWireSchema),
    log: defineChannel('sync.log', syncLogRequestSchema, syncLogResponseSchema),
    updateSettings: defineChannel('sync.updateSettings', syncSettingsPatchWireSchema, syncStatusWireSchema),
    setIdentity: defineChannel('sync.setIdentity', syncSetIdentityRequestSchema, syncSetIdentityResponseSchema),
    revealTree: defineChannel('sync.revealTree', syncRevealTreeRequestSchema, syncRevealTreeResponseSchema),
  },
  // No `secrets.get`: the renderer may create/replace/check/delete/list secret refs, but can
  // never read a value back — resolution happens only in main, at send/import time.
  secrets: {
    set: defineChannel('secrets.set', secretsSetRequestSchema, secretsRefResponseSchema),
    replace: defineChannel('secrets.replace', secretsReplaceRequestSchema, secretsRefResponseSchema),
    exists: defineChannel('secrets.exists', secretsExistsRequestSchema, secretsExistsResponseSchema),
    delete: defineChannel('secrets.delete', secretsDeleteRequestSchema, secretsDeleteResponseSchema),
    list: defineChannel('secrets.list', z.undefined(), secretsListResponseSchema),
    setShowSecrets: defineChannel(
      'secrets.setShowSecrets',
      secretsSetShowSecretsRequestSchema,
      secretsShowSecretsResponseSchema,
    ),
    getShowSecrets: defineChannel('secrets.getShowSecrets', z.undefined(), secretsShowSecretsResponseSchema),
  },
  // Plain-text credentials in one project: found and moved in main. A finding crosses the bridge as
  // a masked preview; its value never does, in either direction. `setValue` is the one call that
  // carries a value — typed by the user, renderer to main — and nothing answers with one.
  secretScan: {
    scan: defineChannel('secretScan.scan', secretScanScanRequestSchema, secretScanScanResponseSchema),
    keep: defineChannel('secretScan.keep', secretScanKeepRequestSchema, secretScanKeepResponseSchema),
    move: defineChannel('secretScan.move', secretScanMoveRequestSchema, secretScanMoveResponseSchema),
    hold: defineChannel('secretScan.hold', secretScanHoldRequestSchema, secretScanHoldResponseSchema),
    release: defineChannel('secretScan.release', secretScanReleaseRequestSchema, secretScanReleaseResponseSchema),
    tokens: defineChannel('secretScan.tokens', secretScanTokensRequestSchema, secretScanTokensResponseSchema),
    setValue: defineChannel('secretScan.setValue', secretScanSetValueRequestSchema, secretScanSetValueResponseSchema),
  },
  // Re-reads one cached exchange, redacted per the show-secrets flag as it stands *now*, so a
  // toggle can reveal (or re-hide) an entry the HTTP log already holds.
  exchanges: {
    get: defineChannel('exchanges.get', exchangesGetRequestSchema, exchangesGetResponseSchema),
    // The REST response body, written to a file the *user* picks. The bytes never cross the bridge:
    // main holds them in the exchange cache and writes them itself.
    saveRestBody: defineChannel(
      'exchanges.saveRestBody',
      exchangesSaveRestBodyRequestSchema,
      exchangesSaveRestBodyResponseSchema,
    ),
  },
  // What the HTTP Log asks main to do with a row it already holds.
  log: {
    curl: defineChannel('log.curl', logCurlRequestSchema, requestCurlResponseSchema),
    resend: defineChannel('log.resend', logResendRequestSchema, logResendResponseSchema),
    exportHar: defineChannel('log.exportHar', logExportHarRequestSchema, logExportHarResponseSchema),
  },
  history: {
    list: defineChannel('history.list', historyListRequestSchema, historyListResponseSchema),
    get: defineChannel('history.get', historyGetRequestSchema, historyGetResponseSchema),
    clear: defineChannel('history.clear', z.undefined(), historyClearResponseSchema),
    resend: defineChannel('history.resend', historyResendRequestSchema, exchangeSummarySchema),
    resendGrpc: defineChannel('history.resendGrpc', historyResendGrpcRequestSchema, grpcExchangeSummarySchema),
  },
  // A request's golden response, kept beside its files as `<slug>.golden.yaml`.
  snapshot: {
    read: defineChannel('snapshot.read', snapshotRequestSchema, snapshotReadResponseSchema),
    write: defineChannel('snapshot.write', snapshotWriteRequestSchema, snapshotSavedResponseSchema),
    setIgnore: defineChannel('snapshot.setIgnore', snapshotSetIgnoreRequestSchema, snapshotSavedResponseSchema),
    remove: defineChannel('snapshot.remove', snapshotRequestSchema, snapshotRemoveResponseSchema),
  },
  xml: {
    completions: defineChannel('xml.completions', xmlCompletionsRequestSchema, xmlCompletionsResponseSchema),
    declaration: defineChannel('xml.declaration', xmlPathRequestSchema, xmlDeclarationResponseSchema),
    describeMany: defineChannel('xml.describeMany', xmlDescribeManyRequestSchema, xmlDescribeManyResponseSchema),
    form: defineChannel('xml.form', xmlFormRequestSchema, xmlFormResponseSchema),
    applyFormEdit: defineChannel('xml.applyFormEdit', xmlApplyFormEditRequestSchema, xmlApplyFormEditResponseSchema),
  },
  fs: {
    saveText: defineChannel('fs.saveText', fsSaveTextRequestSchema, fsSaveTextResponseSchema),
    openText: defineChannel('fs.openText', fsOpenTextRequestSchema, fsOpenTextResponseSchema),
  },
  // Attachment bytes never cross the context bridge: each of these moves them entirely inside
  // main, addressed by a handle the renderer already holds (`sendId` + index, or ids).
  attachments: {
    saveResponse: defineChannel(
      'attachments.saveResponse',
      attachmentsSaveResponseRequestSchema,
      attachmentsSaveResponseResponseSchema,
    ),
    openResponse: defineChannel(
      'attachments.openResponse',
      attachmentsOpenResponseRequestSchema,
      attachmentsOpenResponseSchema,
    ),
    openRequest: defineChannel(
      'attachments.openRequest',
      attachmentsOpenRequestRequestSchema,
      attachmentsOpenResponseSchema,
    ),
    pickFiles: defineChannel(
      'attachments.pickFiles',
      attachmentsPickFilesRequestSchema,
      attachmentsPickFilesResponseSchema,
    ),
    addDropped: defineChannel(
      'attachments.addDropped',
      attachmentsAddDroppedRequestSchema,
      attachmentsAddDroppedResponseSchema,
    ),
  },
  keystores: {
    inspect: defineChannel('keystores.inspect', keystoresInspectRequestSchema, keystoresInspectResponseSchema),
    pickFile: defineChannel('keystores.pickFile', keystoresPickFileRequestSchema, keystoresPickFileResponseSchema),
  },
  wsa: {
    insertHeaders: defineChannel('wsa.insertHeaders', wsaInsertHeadersRequestSchema, wsaEnvelopeResponseSchema),
    removeHeaders: defineChannel('wsa.removeHeaders', wsaRemoveHeadersRequestSchema, wsaEnvelopeResponseSchema),
  },
  wss: {
    previewOutgoing: defineChannel('wss.previewOutgoing', wssPreviewOutgoingRequestSchema, wssEnvelopeResponseSchema),
    insertEntry: defineChannel('wss.insertEntry', wssInsertEntryRequestSchema, wssEnvelopeResponseSchema),
    removeOutgoing: defineChannel('wss.removeOutgoing', wssRemoveOutgoingRequestSchema, wssEnvelopeResponseSchema),
  },
  xpath: {
    evaluate: defineChannel('xpath.evaluate', xpathEvaluateRequestSchema, xpathEvaluateResponseSchema),
    namespaces: defineChannel('xpath.namespaces', xpathNamespacesRequestSchema, xpathNamespacesResponseSchema),
  },
  validate: {
    message: defineChannel('validate.message', validateMessageRequestSchema, validateMessageResponseSchema),
  },
  // The WS-I catalogue, both runners and the HTML renderer live in the engine, which is a
  // main-process dependency; the renderer only ever sees a finished report.
  wsi: {
    checkWsdl: defineChannel('wsi.checkWsdl', wsiCheckWsdlRequestSchema, wsiReportWireSchema),
    checkExchange: defineChannel('wsi.checkExchange', wsiCheckExchangeRequestSchema, wsiReportWireSchema),
    exportHtml: defineChannel('wsi.exportHtml', wsiExportHtmlRequestSchema, wsiExportHtmlResponseSchema),
  },
} as const;

/**
 * A typed, one-way, main-to-renderer event contract. Unlike {@link IpcChannel}, events have
 * no response and no request validation — only a payload schema for what main sends.
 */
export interface IpcEvent<Payload extends z.ZodType> {
  readonly name: string;
  readonly payload: Payload;
}

/** Declares one main-to-renderer event, validated with {@link Payload} on the sending side. */
export function defineEvent<Payload extends z.ZodType>(name: string, payload: Payload): IpcEvent<Payload> {
  return { name, payload };
}

/** The payload type for a given {@link IpcEvent}. */
export type EventPayload<E> = E extends IpcEvent<infer Payload> ? z.infer<Payload> : never;

/** The registry of main-to-renderer events. */
export const events = {
  app: {
    ready: defineEvent('app.ready', z.object({ at: z.string() })),
    /** Progress of an update check/download, for the status bar. */
    updateStatus: defineEvent('app.updateStatus', appUpdateStatusSchema),
  },
  command: {
    /** A menu item was clicked; the renderer runs it through the command registry. */
    invoke: defineEvent('command.invoke', commandInvokeEventSchema),
  },
  engine: {
    progress: defineEvent('engine.progress', engineProgressEventSchema),
  },
  grpc: {
    /** A gRPC call in flight reporting what has arrived so far, keyed by the send's id. */
    live: defineEvent('grpc.live', grpcLiveEventSchema),
  },
  rest: {
    /** A REST send whose response is an event stream, reporting rows as they arrive, keyed by `sendId`. */
    live: defineEvent('rest.live', restLiveEventSchema),
  },
  ws: {
    /** A WebSocket session in flight reporting what has arrived so far, keyed by the send's id. */
    live: defineEvent('ws.live', wsLiveEventSchema),
  },
  globals: {
    changed: defineEvent('globals.changed', globalsStateSchema),
  },
  preferences: {
    changed: defineEvent('preferences.changed', preferencesResponseSchema),
  },
  theme: {
    /** The OS flipped between light and dark; `system` re-resolves on it. */
    changed: defineEvent('theme.changed', themeChangedEventSchema),
  },
  workspace: {
    changed: defineEvent('workspace.changed', workspaceChangedEventSchema),
    /** Main is about to close the workspace (quit): answer with `workspace.stashDrafts`. */
    flushDrafts: defineEvent('workspace.flushDrafts', workspaceFlushDraftsEventSchema),
    /** A T4 reload found `workspace.yaml`/`environments/*.yaml` unreadable; `changed` was not fired. */
    changedOnDisk: defineEvent('workspace.changedOnDisk', workspaceChangedOnDiskEventSchema),
  },
  project: {
    changed: defineEvent('project.changed', projectChangedEventSchema),
    changedOnDisk: defineEvent('project.changedOnDisk', projectChangedOnDiskEventSchema),
    hydration: defineEvent('project.hydration', projectHydrationEventSchema),
  },
  history: {
    appended: defineEvent('history.appended', historyAppendedEventSchema),
  },
  exchange: {
    /** A send failed before a response arrived; the console's HTTP Log records it as a failure row. */
    failed: defineEvent('exchange.failed', exchangeFailedEventSchema),
    /**
     * A row for the HTTP Log exists before its own invoke resolved — currently only a WebSocket
     * handshake, the moment it settles.
     */
    logged: defineEvent('exchange.logged', exchangeLoggedEventSchema),
  },
  git: {
    /** The open workspace's sync needs `user.name`/`user.email` before it can commit. */
    identityNeeded: defineEvent('git.identityNeeded', gitIdentityNeededEventSchema),
  },
  sync: {
    statusChanged: defineEvent('sync.statusChanged', syncStatusChangedEventSchema),
    pulled: defineEvent('sync.pulled', syncPulledEventSchema),
    conflict: defineEvent('sync.conflict', syncConflictEventSchema),
  },
  account: {
    /** The list of known servers changed (sign-in, sign-out, removal, a token the server refused). */
    changed: defineEvent('account.changed', accountChangedEventSchema),
  },
} as const;
