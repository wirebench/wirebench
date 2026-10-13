import { z } from 'zod';
import { defineChannel, defineEvent } from './ipc-contract.js';
import {
  sshCloseRequestSchema,
  sshConnectRequestSchema,
  sshConnectResponseSchema,
  sshDataEventSchema,
  sshExitEventSchema,
  sshImportApplyRequestSchema,
  sshImportApplyResponseSchema,
  sshImportPreviewRequestSchema,
  sshImportPreviewResponseSchema,
  sshListHostsResponseSchema,
  sshResizeRequestSchema,
  sshSaveHostsRequestSchema,
  sshSecretNamesResponseSchema,
  sshSetSecretRequestSchema,
  sshStateEventSchema,
  sshTrustRequestSchema,
  sshKnownHostsResponseSchema,
  sshForgetHostKeyRequestSchema,
  sshHostOsResponseSchema,
  sshSetHostOsRequestSchema,
  sshWriteRequestSchema,
} from './ssh-wire.js';
import {
  sshListSnippetsResponseSchema,
  sshPreviewSnippetRequestSchema,
  sshPreviewSnippetResponseSchema,
  sshRunSnippetRequestSchema,
  sshSaveSnippetsRequestSchema,
} from './snippets-wire.js';
import {
  sftpChmodRequestSchema,
  sftpCloseRequestSchema,
  sftpClosedEventSchema,
  sftpConflictEventSchema,
  sftpCopyRequestSchema,
  sftpCopyResponseSchema,
  sftpEditEventSchema,
  sftpEditReplyRequestSchema,
  sftpEditRequestSchema,
  sftpEditResponseSchema,
  sftpEndEditRequestSchema,
  sftpListRequestSchema,
  sftpListResponseSchema,
  sftpLocalHomeRequestSchema,
  sftpLocalHomeResponseSchema,
  sftpMkdirRequestSchema,
  sftpOpenRequestSchema,
  sftpOpenResponseSchema,
  sftpRemoveRequestSchema,
  sftpRenameRequestSchema,
  sftpResolveRequestSchema,
  sftpTransferEventSchema,
  sftpTransferRequestSchema,
} from './sftp-wire.js';
import {
  sshGenerateKeyRequestSchema,
  sshInstallKeyRequestSchema,
  sshInstallKeyResponseSchema,
  sshKeyWireSchema,
  sshKeysResponseSchema,
} from './ssh-keys-wire.js';
import {
  accountAcceptInvitationRequestSchema,
  accountCancelResponseSchema,
  accountChangedEventSchema,
  accountListResponseSchema,
  accountLookupInvitationRequestSchema,
  accountLookupInvitationResponseSchema,
  accountProbeResponseSchema,
  accountResponseSchema,
  accountSignInLocalRequestSchema,
  accountStartOidcRequestSchema,
  accountUrlRequestSchema,
  apiCancelImportRequestSchema,
  apiCancelImportResponseSchema,
  apiDefinitionDocumentsResponseSchema,
  apiDefinitionTextRequestSchema,
  apiDefinitionTextResponseSchema,
  apiExportDefinitionResponseSchema,
  apiIdRequestSchema,
  appRegisterMenuRequestSchema,
  appRegisterMenuResponseSchema,
  appUpdateStatusSchema,
  auditExportRequestWireSchema,
  auditExportResponseWireSchema,
  auditPageWireSchema,
  auditQueryRequestWireSchema,
  certificatesCheckRequestSchema,
  certificatesCheckResponseSchema,
  ciTokenCreateRequestWireSchema,
  ciTokenCreatedWireSchema,
  ciTokenRevokeRequestWireSchema,
  ciTokenRevokeResponseWireSchema,
  ciTokensListResponseWireSchema,
  ciTokensRequestWireSchema,
  commandInvokeEventSchema,
  cookieJarStateWireSchema,
  cookiesRemoveDomainRequestSchema,
  cookiesRemoveRequestSchema,
  cookiesSetRequestSchema,
  currentValuesResetRequestSchema,
  currentValuesSetRequestSchema,
  currentValuesStateWireSchema,
  dialogsOpenFileRequestSchema,
  dialogsOpenFileResponseSchema,
  dialogsOpenFolderRequestSchema,
  dialogsOpenFolderResponseSchema,
  dialogsSaveFileRequestSchema,
  dialogsSaveFileResponseSchema,
  engineProgressEventSchema,
  exchangeFailedEventSchema,
  exchangesGetRequestSchema,
  fsOpenTextRequestSchema,
  fsOpenTextResponseSchema,
  fsSaveTextRequestSchema,
  fsSaveTextResponseSchema,
  gitClearPathRequestSchema,
  gitClearPathResponseSchema,
  gitDetectRequestSchema,
  gitDetectResponseSchema,
  gitIdentityNeededEventSchema,
  gitLocateRequestSchema,
  gitLocateResponseSchema,
  globalsRemoveRequestSchema,
  globalsSetEnabledRequestSchema,
  globalsSetRequestSchema,
  globalsStateSchema,
  historyChangedEventSchema,
  historyClearResponseSchema,
  historyGetRequestSchema,
  historyListRequestSchema,
  hooksCaptureRequestWireSchema,
  hooksCaptureResponseWireSchema,
  hooksCapturedEventWireSchema,
  hooksCapturesEventWireSchema,
  hooksChangedEventWireSchema,
  hooksCreateRequestWireSchema,
  hooksDoneResponseWireSchema,
  hooksHookResponseWireSchema,
  hooksListResponseWireSchema,
  hooksOpenResponseWireSchema,
  hooksPageResponseWireSchema,
  hooksRefRequestWireSchema,
  hooksServerRequestWireSchema,
  hooksStatusResponseWireSchema,
  hooksUnseenRequestWireSchema,
  hooksUnseenResponseWireSchema,
  hooksUpdateRequestWireSchema,
  hooksViewRequestWireSchema,
  hooksWorkspaceRequestWireSchema,
  keystoresInspectRequestSchema,
  keystoresInspectResponseSchema,
  keystoresPickFileRequestSchema,
  keystoresPickFileResponseSchema,
  licenseInstallRequestWireSchema,
  licenseRemoveResponseWireSchema,
  licenseRequestWireSchema,
  licenseStateWireSchema,
  logExportHarResponseSchema,
  logResendRequestSchema,
  mockCheckResponseSchema,
  mockExchangeEventSchema,
  mockIdRequestSchema,
  mockResetResponseSchema,
  mockStateEventSchema,
  mockStatesResponseSchema,
  mockStopResponseSchema,
  oauth2OwnerRequestSchema,
  oauth2StatusSchema,
  preferencesPolicyResponseSchema,
  preferencesResetRequestSchema,
  preferencesResponseSchema,
  preferencesUpdateRequestSchema,
  projectChangedOnDiskEventSchema,
  projectHydrationEventSchema,
  projectIdRequestSchema,
  projectMoveToWorkspaceRequestSchema,
  projectSaveResponseSchema,
  requestCancelRequestSchema,
  requestCancelResponseSchema,
  requestCurlResponseSchema,
  requestPreflightRequestSchema,
  requestVariablesRequestSchema,
  requestVariablesResponseSchema,
  scriptCloseModelRequestSchema,
  scriptCloseModelResponseSchema,
  scriptCompletionsResponseSchema,
  scriptDiagnosticsResponseSchema,
  scriptPositionRequestSchema,
  scriptQuickInfoResponseSchema,
  scriptSignatureHelpResponseSchema,
  scriptSourceRequestSchema,
  scriptValuesChangedEventSchema,
  scriptValuesClearResponseSchema,
  scriptValuesListResponseSchema,
  scriptValuesRequestSchema,
  searchQueryRequestSchema,
  searchQueryResponseSchema,
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
  secretSourcesApproveRequestSchema,
  secretSourcesSetRequestSchema,
  secretSourcesSetResponseSchema,
  secretSourcesStateSchema,
  secretSourcesTestRequestSchema,
  secretSourcesTestResponseSchema,
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
  sequenceCancelRequestSchema,
  sequenceCancelResponseSchema,
  sequenceProgressEventSchema,
  sequenceRunRequestSchema,
  sequenceRunResultWireSchema,
  sequenceWaitingEventSchema,
  snapshotReadResponseSchema,
  snapshotRemoveResponseSchema,
  snapshotRequestSchema,
  snapshotSavedResponseSchema,
  snapshotSetIgnoreRequestSchema,
  snapshotWriteRequestSchema,
  sslClearCaBundleRequestSchema,
  sslClearCaBundleResponseSchema,
  sslPickCaBundleRequestSchema,
  sslPickCaBundleResponseSchema,
  syncCommitRequestSchema,
  syncConflictEventSchema,
  syncConflictsResponseSchema,
  syncLogRequestSchema,
  syncLogResponseSchema,
  syncPulledEventSchema,
  syncResolveRequestSchema,
  syncRevealTreeRequestSchema,
  syncRevealTreeResponseSchema,
  syncSetIdentityRequestSchema,
  syncSetIdentityResponseSchema,
  syncSettingsPatchWireSchema,
  syncStatusChangedEventSchema,
  syncStatusWireSchema,
  teamAccessRefRequestWireSchema,
  teamAccessResponseWireSchema,
  teamAddMemberRequestWireSchema,
  teamCreateRequestWireSchema,
  teamCreateWorkspaceRequestWireSchema,
  teamDoneResponseWireSchema,
  teamInvitationRefRequestWireSchema,
  teamInvitationsResponseWireSchema,
  teamInviteRequestWireSchema,
  teamInviteResponseWireSchema,
  teamListResponseWireSchema,
  teamMemberRefRequestWireSchema,
  teamMemberResponseWireSchema,
  teamMemberRoleRequestWireSchema,
  teamMembersResponseWireSchema,
  teamRefRequestWireSchema,
  teamRenameRequestWireSchema,
  teamResponseWireSchema,
  teamSecretsChangedEventSchema,
  teamSecretsEntryActionRequestSchema,
  teamSecretsKeyActionRequestSchema,
  teamSecretsStatusWireSchema,
  teamServerRequestWireSchema,
  teamSetAccessRequestWireSchema,
  teamUpdateWorkspaceRequestWireSchema,
  teamWorkspaceRefRequestWireSchema,
  teamWorkspaceResponseWireSchema,
  teamWorkspacesResponseWireSchema,
  themeChangedEventSchema,
  themeGetResponseSchema,
  workspaceAddProjectRequestSchema,
  workspaceAddProjectResponseSchema,
  workspaceChangedEventSchema,
  workspaceChangedOnDiskEventSchema,
  workspaceCreateRequestSchema,
  workspaceExportCollectionRequestSchema,
  workspaceExportCollectionResponseSchema,
  workspaceExportProjectResponseSchema,
  workspaceFlushDraftsEventSchema,
  workspaceIdRequestSchema,
  workspaceImportSuggestionRequestSchema,
  workspaceImportSuggestionResponseSchema,
  workspaceJoinFromServerRequestWireSchema,
  workspaceJoinRequestSchema,
  workspaceListResponseSchema,
  workspaceMutateRequestSchema,
  workspaceMutateResponseSchema,
  workspaceProjectIdRequestSchema,
  workspaceRemoveProjectRequestSchema,
  workspaceRenameRequestSchema,
  workspaceResponseSchema,
  workspaceRevealResponseSchema,
  workspaceServerTargetsRequestWireSchema,
  workspaceServerTargetsResponseWireSchema,
  workspaceSetActiveEnvironmentRequestSchema,
  workspaceShareRequestSchema,
  workspaceShareToServerRequestWireSchema,
  workspaceSnapshotResponseSchema,
  workspaceSummariesResponseSchema,
  workspaceTeamWorkspacesResponseWireSchema,
} from './wire-base.js';
import {
  apiImportOpenCollectionRequestSchema,
  apiImportOpenCollectionResponseSchema,
  apiImportPostmanFolderRequestSchema,
  apiImportPostmanFolderResponseSchema,
  exchangeLoggedEventSchema,
  exchangesGetResponseSchema,
  historyAppendedEventSchema,
  historyGetResponseSchema,
  historyListResponseSchema,
  logCurlRequestSchema,
  logExportHarRequestSchema,
  logResendResponseSchema,
  projectChangedEventSchema,
  projectMutateRequestSchema,
  projectMutateResponseSchema,
  projectSnapshotResponseSchema,
  requestCurlRequestSchema,
  requestCodeRequestSchema,
  requestPreflightResponseSchema,
  workspaceRestoredResponseSchema,
  workspaceStashDraftsRequestSchema,
} from './wire-types.js';
import {
  runnerCancelRequestSchema,
  runnerCancelResponseSchema,
  runnerDataChooseResponseSchema,
  runnerHistoryGetRequestSchema,
  runnerHistoryGetResponseSchema,
  runnerHistoryListResponseSchema,
  runnerOkSchema,
  runnerProgressEventSchema,
  runnerRunRequestSchema,
  runnerRunResultSchema,
  runnerSettingsSetSchema,
  runnerStateSchema,
  runnerTargetRequestSchema,
} from './runner-wire.js';
import { soapChannels } from './kinds/soap/channels.js';
import { restChannels, restEvents } from './kinds/rest/channels.js';
import { grpcChannels, grpcEvents } from './kinds/grpc/channels.js';
import { wsChannels, wsEvents } from './kinds/ws/channels.js';

export { defineChannel, defineEvent } from './ipc-contract.js';
export type { ChannelRequest, ChannelResponse, EventPayload, IpcChannel, IpcEvent } from './ipc-contract.js';

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
    /** The sidebar areas this run has switched on (`WIREBENCH_AREAS`); the renderer hides the rest. */
    areas: defineChannel('app.areas', z.undefined(), z.object({ enabled: z.array(z.string()) })),
    /** The protocol kinds this run has switched on (`WIREBENCH_KINDS`); the renderer shows the rest as placeholders. */
    kinds: defineChannel('app.kinds', z.undefined(), z.object({ enabled: z.array(z.string()) })),
    /**
     * Opens another window at the workspace picker (the "New Window" command). Each window holds its
     * own workspace; see the multi-window design.
     */
    newWindow: defineChannel('app.newWindow', z.undefined(), z.object({})),
  },
  auth: {
    /** Whether this build can do Kerberos/SPNEGO here, and why not when it cannot. */
    kerberosAvailability: defineChannel(
      'auth.kerberosAvailability',
      z.undefined(),
      z.object({
        available: z.boolean(),
        reason: z.string().optional(),
        platform: z.enum(['win32', 'darwin', 'linux']),
      }),
    ),
  },
  search: {
    /**
     * Project-wide find. Runs in main so cached definition documents are searched where they
     * already live: only matching lines come back, never the documents themselves.
     */
    query: defineChannel('search.query', searchQueryRequestSchema, searchQueryResponseSchema),
  },
  definition: soapChannels.definition,
  request: {
    cancel: defineChannel('request.cancel', requestCancelRequestSchema, requestCancelResponseSchema),
    preflight: defineChannel('request.preflight', requestPreflightRequestSchema, requestPreflightResponseSchema),
    curl: defineChannel('request.curl', requestCurlRequestSchema, requestCurlResponseSchema),
    /**
     * The variables one request can reference, as its send resolves them, for the editor's completion,
     * hover and unresolved marks (#340). A value reaching a secret comes back masked, without it.
     */
    variables: defineChannel('request.variables', requestVariablesRequestSchema, requestVariablesResponseSchema),
    code: defineChannel('request.code', requestCodeRequestSchema, requestCurlResponseSchema),
    ...soapChannels.request,
    ...restChannels.request,
    ...grpcChannels.request,
    ...wsChannels.request,
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
   * The session's issued SAML tokens (WS-Trust), one entry of an outgoing WS-Security configuration
   * at a time. Main reads the entry and the request it is fetched for from the model; the assertion
   * comes back only when the session shows secrets.
   */
  issuedTokens: soapChannels.issuedTokens,
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
  /** Catch URLs and captures on Wirebench Server (webhook-capture spec §4). */
  hooks: {
    /** The server's `/meta` `hooks`, `null` without the module: whether to show the Webhooks node. */
    status: defineChannel('hooks.status', hooksServerRequestWireSchema, hooksStatusResponseWireSchema),
    list: defineChannel('hooks.list', hooksWorkspaceRequestWireSchema, hooksListResponseWireSchema),
    create: defineChannel('hooks.create', hooksCreateRequestWireSchema, hooksHookResponseWireSchema),
    update: defineChannel('hooks.update', hooksUpdateRequestWireSchema, hooksHookResponseWireSchema),
    rotate: defineChannel('hooks.rotate', hooksRefRequestWireSchema, hooksHookResponseWireSchema),
    remove: defineChannel('hooks.remove', hooksRefRequestWireSchema, hooksDoneResponseWireSchema),
    clear: defineChannel('hooks.clear', hooksRefRequestWireSchema, hooksDoneResponseWireSchema),
    unseen: defineChannel('hooks.unseen', hooksUnseenRequestWireSchema, hooksUnseenResponseWireSchema),
    /** Follow the workspace's live nudges while the Webhooks node shows. */
    watch: defineChannel('hooks.watch', hooksWorkspaceRequestWireSchema, hooksDoneResponseWireSchema),
    unwatch: defineChannel('hooks.unwatch', hooksWorkspaceRequestWireSchema, hooksDoneResponseWireSchema),
    /** A catch URL tab opens a view: its captures stay in main's memory until `close`. */
    open: defineChannel('hooks.open', hooksRefRequestWireSchema, hooksOpenResponseWireSchema),
    older: defineChannel('hooks.older', hooksViewRequestWireSchema, hooksPageResponseWireSchema),
    capture: defineChannel('hooks.capture', hooksCaptureRequestWireSchema, hooksCaptureResponseWireSchema),
    close: defineChannel('hooks.close', hooksViewRequestWireSchema, hooksDoneResponseWireSchema),
  },
  /** CI tokens of a server workspace (callback-assertion §5); main adds the account's token. */
  ciTokens: {
    list: defineChannel('ciTokens.list', ciTokensRequestWireSchema, ciTokensListResponseWireSchema),
    create: defineChannel('ciTokens.create', ciTokenCreateRequestWireSchema, ciTokenCreatedWireSchema),
    revoke: defineChannel('ciTokens.revoke', ciTokenRevokeRequestWireSchema, ciTokenRevokeResponseWireSchema),
  },
  /** The server's license (licensing spec §3.8): server admins only; main adds the account's token. */
  license: {
    get: defineChannel('license.get', licenseRequestWireSchema, licenseStateWireSchema),
    install: defineChannel('license.install', licenseInstallRequestWireSchema, licenseStateWireSchema),
    remove: defineChannel('license.remove', licenseRequestWireSchema, licenseRemoveResponseWireSchema),
  },
  /** The server's audit log (audit-log spec §3.6): server admins on Enterprise; main adds the token and picks the export file. */
  audit: {
    query: defineChannel('audit.query', auditQueryRequestWireSchema, auditPageWireSchema),
    export: defineChannel('audit.export', auditExportRequestWireSchema, auditExportResponseWireSchema),
  },
  // An API and the definition it was imported from. Separate from `definition.*` because the two
  // describe different things — a WSDL bundle is resolved into memory and stays there, an OpenAPI
  // definition is read back from its cache on demand — and nothing here addresses an interface.
  api: {
    importOpenCollection: defineChannel(
      'api.importOpenCollection',
      apiImportOpenCollectionRequestSchema,
      apiImportOpenCollectionResponseSchema,
    ),
    importPostmanFolder: defineChannel(
      'api.importPostmanFolder',
      apiImportPostmanFolderRequestSchema,
      apiImportPostmanFolderResponseSchema,
    ),
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
    ...restChannels.api,
    ...grpcChannels.api,
    ...wsChannels.api,
  },
  // A workspace owns its projects: creating, opening and closing one is a `workspace.*` call,
  // not a `project.*` one. What is left here addresses *one* project of the open workspace,
  // named by `projectId` — never by a path, which the renderer never sees or sends.
  project: {
    snapshot: defineChannel('project.snapshot', projectIdRequestSchema, projectSnapshotResponseSchema),
    mutate: defineChannel('project.mutate', projectMutateRequestSchema, projectMutateResponseSchema),
    save: defineChannel('project.save', projectIdRequestSchema, projectSaveResponseSchema),
    moveToWorkspace: defineChannel(
      'project.moveToWorkspace',
      projectMoveToWorkspaceRequestSchema,
      workspaceResponseSchema,
    ),
    reload: defineChannel('project.reload', projectIdRequestSchema, projectSnapshotResponseSchema),
    ...soapChannels.project,
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
    // A project, API or interface as a Postman Collection or an OpenCollection; main picks the folder.
    exportCollection: defineChannel(
      'workspace.exportCollection',
      workspaceExportCollectionRequestSchema,
      workspaceExportCollectionResponseSchema,
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
  /** The open workspace's cookie jar (cookie jar spec §2.2). Every channel answers with the whole jar. */
  cookies: {
    list: defineChannel('cookies.list', z.undefined(), cookieJarStateWireSchema),
    set: defineChannel('cookies.set', cookiesSetRequestSchema, cookieJarStateWireSchema),
    remove: defineChannel('cookies.remove', cookiesRemoveRequestSchema, cookieJarStateWireSchema),
    removeDomain: defineChannel('cookies.removeDomain', cookiesRemoveDomainRequestSchema, cookieJarStateWireSchema),
    clear: defineChannel('cookies.clear', z.undefined(), cookieJarStateWireSchema),
  },
  /** The open workspace's current values (cookie jar spec §5.3). In memory only; every channel answers with the whole state. */
  currentValues: {
    get: defineChannel('currentValues.get', z.undefined(), currentValuesStateWireSchema),
    set: defineChannel('currentValues.set', currentValuesSetRequestSchema, currentValuesStateWireSchema),
    reset: defineChannel('currentValues.reset', currentValuesResetRequestSchema, currentValuesStateWireSchema),
  },
  theme: {
    /** The OS colour scheme right now; the renderer asks once at startup, then listens. */
    get: defineChannel('theme.get', z.undefined(), themeGetResponseSchema),
  },
  dialogs: {
    openFile: defineChannel('dialogs.openFile', dialogsOpenFileRequestSchema, dialogsOpenFileResponseSchema),
    openFolder: defineChannel('dialogs.openFolder', dialogsOpenFolderRequestSchema, dialogsOpenFolderResponseSchema),
    saveFile: defineChannel('dialogs.saveFile', dialogsSaveFileRequestSchema, dialogsSaveFileResponseSchema),
  },
  preferences: {
    get: defineChannel('preferences.get', z.undefined(), preferencesResponseSchema),
    update: defineChannel('preferences.update', preferencesUpdateRequestSchema, preferencesResponseSchema),
    reset: defineChannel('preferences.reset', preferencesResetRequestSchema, preferencesResponseSchema),
    /** The managed-preferences policy; read once at startup, so the renderer asks once. */
    policy: defineChannel('preferences.policy', z.undefined(), preferencesPolicyResponseSchema),
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
  // Secret sources (secret sources spec D6). No reply carries a secret value: `test` answers with a length.
  // `setShared` and `setLocal` write one entry and are validated in main (A6).
  secretSources: {
    get: defineChannel('secretSources.get', z.undefined(), secretSourcesStateSchema),
    setShared: defineChannel('secretSources.setShared', secretSourcesSetRequestSchema, secretSourcesSetResponseSchema),
    setLocal: defineChannel('secretSources.setLocal', secretSourcesSetRequestSchema, secretSourcesSetResponseSchema),
    approve: defineChannel('secretSources.approve', secretSourcesApproveRequestSchema, secretSourcesStateSchema),
    test: defineChannel('secretSources.test', secretSourcesTestRequestSchema, secretSourcesTestResponseSchema),
    clearCache: defineChannel('secretSources.clearCache', z.undefined(), z.undefined()),
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
  // Team secrets in the open shared workspace (team-secrets spec §4). Nothing here carries a value
  // or a private key in either direction: ids, names, fingerprints and labels only.
  teamSecrets: {
    status: defineChannel('teamSecrets.status', z.undefined(), teamSecretsStatusWireSchema),
    turnOn: defineChannel('teamSecrets.turnOn', z.undefined(), teamSecretsStatusWireSchema),
    requestAccess: defineChannel('teamSecrets.requestAccess', z.undefined(), teamSecretsStatusWireSchema),
    approve: defineChannel('teamSecrets.approve', teamSecretsKeyActionRequestSchema, teamSecretsStatusWireSchema),
    decline: defineChannel('teamSecrets.decline', teamSecretsKeyActionRequestSchema, teamSecretsStatusWireSchema),
    remove: defineChannel('teamSecrets.remove', teamSecretsKeyActionRequestSchema, teamSecretsStatusWireSchema),
    grantAdmin: defineChannel('teamSecrets.grantAdmin', teamSecretsKeyActionRequestSchema, teamSecretsStatusWireSchema),
    revokeAdmin: defineChannel(
      'teamSecrets.revokeAdmin',
      teamSecretsKeyActionRequestSchema,
      teamSecretsStatusWireSchema,
    ),
    restoreMine: defineChannel(
      'teamSecrets.restoreMine',
      teamSecretsEntryActionRequestSchema,
      teamSecretsStatusWireSchema,
    ),
    dismissReplaced: defineChannel(
      'teamSecrets.dismissReplaced',
      teamSecretsEntryActionRequestSchema,
      teamSecretsStatusWireSchema,
    ),
  },
  // Re-reads one cached exchange, redacted per the show-secrets flag as it stands *now*, so a
  // toggle can reveal (or re-hide) an entry the HTTP log already holds.
  exchanges: {
    get: defineChannel('exchanges.get', exchangesGetRequestSchema, exchangesGetResponseSchema),
    ...restChannels.exchanges,
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
    ...soapChannels.history,
    ...restChannels.history,
    ...grpcChannels.history,
  },
  // A sequence (`sequences/<slug>.sequence.yaml`) run end to end; edits go through `project.mutate`.
  sequence: {
    /** Runs a sequence; resolves when it ends, with every step. `sequence.progress` reports each as it ends. */
    run: defineChannel('sequence.run', sequenceRunRequestSchema, sequenceRunResultWireSchema),
    /** Stops a run: the step in flight is cancelled and the rest are skipped. */
    cancel: defineChannel('sequence.cancel', sequenceCancelRequestSchema, sequenceCancelResponseSchema),
  },
  // The Runner (#336): a folder, an API, the project or a sequence run per data row. Its settings and
  // runs are kept under user data, never in the project; the data file's path never leaves main.
  runner: {
    /** The target, its requests in run order, its settings and its data file's name and columns. */
    state: defineChannel('runner.state', runnerTargetRequestSchema, runnerStateSchema),
    settings: {
      set: defineChannel('runner.settings.set', runnerSettingsSetSchema, runnerOkSchema),
    },
    data: {
      /** Opens a picker for a CSV or JSON file and keeps it for the target; answers its name only. */
      choose: defineChannel('runner.data.choose', runnerTargetRequestSchema, runnerDataChooseResponseSchema),
      clear: defineChannel('runner.data.clear', runnerTargetRequestSchema, runnerOkSchema),
    },
    /** Runs the target; resolves when it ends. `runner.progress` reports each request as it ends. */
    run: defineChannel('runner.run', runnerRunRequestSchema, runnerRunResultSchema),
    /** Stops a run: the request in flight is cancelled and nothing after it runs. */
    cancel: defineChannel('runner.cancel', runnerCancelRequestSchema, runnerCancelResponseSchema),
    history: {
      list: defineChannel('runner.history.list', runnerTargetRequestSchema, runnerHistoryListResponseSchema),
      get: defineChannel('runner.history.get', runnerHistoryGetRequestSchema, runnerHistoryGetResponseSchema),
    },
  },
  // A mock service (#59) served from this machine; edits go through `project.mutate`.
  mock: {
    /** Starts a mock, or restarts it when it runs; resolves with where it listens. */
    start: defineChannel('mock.start', mockIdRequestSchema, mockStateEventSchema),
    stop: defineChannel('mock.stop', mockIdRequestSchema, mockStopResponseSchema),
    /** Puts every scenario of a running mock back to its start state. */
    reset: defineChannel('mock.reset', mockIdRequestSchema, mockResetResponseSchema),
    /** The state of every mock this window started that is still running, for a renderer that reloads. */
    states: defineChannel('mock.states', z.object({}), mockStatesResponseSchema),
    /** Checks every stub of a mock against its contract (#325); it need not be running. */
    check: defineChannel('mock.check', mockIdRequestSchema, mockCheckResponseSchema),
  },
  // A request's scripts (#63): the editor's language features, answered by main's checker against
  // the request's own types, and a project's session values. Edits go through `project.mutate`.
  script: {
    diagnostics: defineChannel('script.diagnostics', scriptSourceRequestSchema, scriptDiagnosticsResponseSchema),
    completions: defineChannel('script.completions', scriptPositionRequestSchema, scriptCompletionsResponseSchema),
    quickInfo: defineChannel('script.quickInfo', scriptPositionRequestSchema, scriptQuickInfoResponseSchema),
    signatureHelp: defineChannel(
      'script.signatureHelp',
      scriptPositionRequestSchema,
      scriptSignatureHelpResponseSchema,
    ),
    /** An editor closed: its language service can go. */
    closeModel: defineChannel('script.closeModel', scriptCloseModelRequestSchema, scriptCloseModelResponseSchema),
    /** A project's session values, masked, a secret one without its value. */
    listValues: defineChannel('script.listValues', scriptValuesRequestSchema, scriptValuesListResponseSchema),
    clearValues: defineChannel('script.clearValues', scriptValuesRequestSchema, scriptValuesClearResponseSchema),
  },
  // A request's golden response, kept beside its files as `<slug>.golden.yaml`.
  snapshot: {
    read: defineChannel('snapshot.read', snapshotRequestSchema, snapshotReadResponseSchema),
    write: defineChannel('snapshot.write', snapshotWriteRequestSchema, snapshotSavedResponseSchema),
    setIgnore: defineChannel('snapshot.setIgnore', snapshotSetIgnoreRequestSchema, snapshotSavedResponseSchema),
    remove: defineChannel('snapshot.remove', snapshotRequestSchema, snapshotRemoveResponseSchema),
  },
  xml: soapChannels.xml,
  fs: {
    saveText: defineChannel('fs.saveText', fsSaveTextRequestSchema, fsSaveTextResponseSchema),
    openText: defineChannel('fs.openText', fsOpenTextRequestSchema, fsOpenTextResponseSchema),
  },
  // Attachment bytes never cross the context bridge: each of these moves them entirely inside
  // main, addressed by a handle the renderer already holds (`sendId` + index, or ids).
  attachments: soapChannels.attachments,
  certificates: {
    check: defineChannel('certificates.check', certificatesCheckRequestSchema, certificatesCheckResponseSchema),
  },
  keystores: {
    inspect: defineChannel('keystores.inspect', keystoresInspectRequestSchema, keystoresInspectResponseSchema),
    pickFile: defineChannel('keystores.pickFile', keystoresPickFileRequestSchema, keystoresPickFileResponseSchema),
  },
  wsa: soapChannels.wsa,
  wss: soapChannels.wss,
  ssh: {
    listHosts: defineChannel('ssh.listHosts', z.undefined(), sshListHostsResponseSchema),
    saveHosts: defineChannel('ssh.saveHosts', sshSaveHostsRequestSchema, sshListHostsResponseSchema),
    secretNames: defineChannel('ssh.secretNames', z.undefined(), sshSecretNamesResponseSchema),
    setSecret: defineChannel('ssh.setSecret', sshSetSecretRequestSchema, z.object({})),
    connect: defineChannel('ssh.connect', sshConnectRequestSchema, sshConnectResponseSchema),
    write: defineChannel('ssh.write', sshWriteRequestSchema, z.object({})),
    resize: defineChannel('ssh.resize', sshResizeRequestSchema, z.object({})),
    close: defineChannel('ssh.close', sshCloseRequestSchema, z.object({})),
    trustHostKey: defineChannel('ssh.trustHostKey', sshTrustRequestSchema, z.object({})),
    knownHosts: defineChannel('ssh.knownHosts', z.undefined(), sshKnownHostsResponseSchema),
    forgetHostKey: defineChannel('ssh.forgetHostKey', sshForgetHostKeyRequestSchema, z.object({})),
    hostOs: defineChannel('ssh.hostOs', z.undefined(), sshHostOsResponseSchema),
    setHostOs: defineChannel('ssh.setHostOs', sshSetHostOsRequestSchema, z.object({})),
    importPreview: defineChannel('ssh.importPreview', sshImportPreviewRequestSchema, sshImportPreviewResponseSchema),
    importApply: defineChannel('ssh.importApply', sshImportApplyRequestSchema, sshImportApplyResponseSchema),
    // Keychain keys (#409): only the public half crosses; the private key and passphrase stay in main.
    generateKey: defineChannel('ssh.generateKey', sshGenerateKeyRequestSchema, sshKeyWireSchema),
    keys: defineChannel('ssh.keys', z.undefined(), sshKeysResponseSchema),
    installKey: defineChannel('ssh.installKey', sshInstallKeyRequestSchema, sshInstallKeyResponseSchema),
    // Snippets (#356): scripts cross with `${secret:NAME}` tokens only, never a value.
    listSnippets: defineChannel('ssh.listSnippets', z.undefined(), sshListSnippetsResponseSchema),
    saveSnippets: defineChannel('ssh.saveSnippets', sshSaveSnippetsRequestSchema, sshListSnippetsResponseSchema),
    // Main types the saved snippet by id, resolving its secrets itself; a preview never resolves one.
    runSnippet: defineChannel('ssh.runSnippet', sshRunSnippetRequestSchema, z.object({})),
    previewSnippet: defineChannel(
      'ssh.previewSnippet',
      sshPreviewSnippetRequestSchema,
      sshPreviewSnippetResponseSchema,
    ),
  },
  // The Files tab (SSH area slice 3). Registered only while the SSH area is on; a local place is used as given.
  sftp: {
    open: defineChannel('sftp.open', sftpOpenRequestSchema, sftpOpenResponseSchema),
    close: defineChannel('sftp.close', sftpCloseRequestSchema, z.object({})),
    list: defineChannel('sftp.list', sftpListRequestSchema, sftpListResponseSchema),
    mkdir: defineChannel('sftp.mkdir', sftpMkdirRequestSchema, z.object({})),
    rename: defineChannel('sftp.rename', sftpRenameRequestSchema, z.object({})),
    remove: defineChannel('sftp.remove', sftpRemoveRequestSchema, z.object({})),
    chmod: defineChannel('sftp.chmod', sftpChmodRequestSchema, z.object({})),
    copy: defineChannel('sftp.copy', sftpCopyRequestSchema, sftpCopyResponseSchema),
    resolve: defineChannel('sftp.resolve', sftpResolveRequestSchema, z.object({})),
    cancel: defineChannel('sftp.cancel', sftpTransferRequestSchema, z.object({})),
    retry: defineChannel('sftp.retry', sftpTransferRequestSchema, z.object({})),
    localHome: defineChannel('sftp.localHome', sftpLocalHomeRequestSchema, sftpLocalHomeResponseSchema),
    edit: defineChannel('sftp.edit', sftpEditRequestSchema, sftpEditResponseSchema),
    endEdit: defineChannel('sftp.endEdit', sftpEndEditRequestSchema, z.object({})),
    editReply: defineChannel('sftp.editReply', sftpEditReplyRequestSchema, z.object({})),
  },
  xpath: soapChannels.xpath,
  validate: soapChannels.validate,
  // The WS-I catalogue, both runners and the HTML renderer live in the engine, which is a
  // main-process dependency; the renderer only ever sees a finished report.
  wsi: soapChannels.wsi,
} as const;

/** The registry of main-to-renderer events. */
export const events = {
  sftp: {
    /** A transfer's state or progress (at most four a second, plus every state change); names and sizes only. */
    transfer: defineEvent('sftp.transfer', sftpTransferEventSchema),
    /** The first clash of a batch (or each, until one is answered for the rest): `sftp.resolve` answers. */
    conflict: defineEvent('sftp.conflict', sftpConflictEventSchema),
    /** The session ended (closed, lost, or with its window's workspace); the id is gone. To its window only. */
    closed: defineEvent('sftp.closed', sftpClosedEventSchema),
    /** An edit in the system editor changed state. */
    edit: defineEvent('sftp.edit', sftpEditEventSchema),
  },
  ssh: {
    /** `hosts.yaml` was written: a view re-lists. */
    hostsChanged: defineEvent('ssh.hostsChanged', z.object({})),
    /** `snippets.yaml` was written or the workspace changed: the Snippets view re-lists. */
    snippetsChanged: defineEvent('ssh.snippetsChanged', z.object({})),
    /** A connect detected a host's OS, or a choice changed: read `ssh.hostOs` again. */
    hostOsChanged: defineEvent('ssh.hostOsChanged', z.object({})),
    /** Terminal output (stdout and stderr), base64, to the window that opened the session only. */
    data: defineEvent('ssh.data', sshDataEventSchema),
    /** The remote shell ended; the session id is gone. */
    exit: defineEvent('ssh.exit', sshExitEventSchema),
    state: defineEvent('ssh.state', sshStateEventSchema),
    /** The machine woke from sleep: a terminal waiting to reconnect tries at once. To every window. */
    resumed: defineEvent('ssh.resumed', z.object({})),
  },
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
  grpc: grpcEvents.grpc,
  rest: restEvents.rest,
  ws: wsEvents.ws,
  globals: {
    changed: defineEvent('globals.changed', globalsStateSchema),
  },
  cookies: {
    /** The open workspace's jar changed: a send stored cookies, the manager edited, or the workspace switched. */
    changed: defineEvent('cookies.changed', cookieJarStateWireSchema),
  },
  currentValues: {
    changed: defineEvent('currentValues.changed', currentValuesStateWireSchema),
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
    /** Another process (`wirebench mcp`, `wirebench send`) wrote a project's History file. */
    changed: defineEvent('history.changed', historyChangedEventSchema),
  },
  sequence: {
    /** One step of a running sequence has ended, keyed by the run's id. */
    progress: defineEvent('sequence.progress', sequenceProgressEventSchema),
    /** A step of a running sequence has sent and waits for its callback assertions. */
    waiting: defineEvent('sequence.waiting', sequenceWaitingEventSchema),
  },
  runner: {
    /** One request of a running Runner run has ended, keyed by the run's id. */
    progress: defineEvent('runner.progress', runnerProgressEventSchema),
  },
  mock: {
    /** A mock started, stopped, restarted after an edit, or failed to start. */
    state: defineEvent('mock.state', mockStateEventSchema),
    /** A running mock answered a request. */
    exchange: defineEvent('mock.exchange', mockExchangeEventSchema),
  },
  script: {
    /** A project's session values changed; `script.listValues` has the new list. */
    valuesChanged: defineEvent('script.valuesChanged', scriptValuesChangedEventSchema),
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
  teamSecrets: {
    /** The open shared workspace's team-secrets status changed (a pull, an approval, a save). */
    changed: defineEvent('teamSecrets.changed', teamSecretsChangedEventSchema),
  },
  hooks: {
    /** Re-list a workspace's catch URLs: a `hooks` nudge, or the live socket came back. */
    changed: defineEvent('hooks.changed', hooksChangedEventWireSchema),
    /** A `capture` nudge: recount that catch URL's unseen badge. */
    captured: defineEvent('hooks.captured', hooksCapturedEventWireSchema),
    /** An open view's summaries changed: new ones on top, a fresh first page, or a failed fetch. */
    captures: defineEvent('hooks.captures', hooksCapturesEventWireSchema),
  },
  account: {
    /** The list of known servers changed (sign-in, sign-out, removal, a token the server refused). */
    changed: defineEvent('account.changed', accountChangedEventSchema),
  },
} as const;
