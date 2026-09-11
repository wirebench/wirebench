import { z } from 'zod';
import {
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
  appRegisterMenuResponseSchema,
  commandInvokeEventSchema,
  themeChangedEventSchema,
  themeGetResponseSchema,
  searchQueryRequestSchema,
  searchQueryResponseSchema,
  dialogsOpenFileRequestSchema,
  dialogsOpenFileResponseSchema,
  dialogsOpenFolderRequestSchema,
  dialogsSaveFileRequestSchema,
  dialogsSaveFileResponseSchema,
  preferencesResetRequestSchema,
  preferencesResponseSchema,
  preferencesUpdateRequestSchema,
  sslClearCaBundleRequestSchema,
  sslClearCaBundleResponseSchema,
  sslPickCaBundleRequestSchema,
  sslPickCaBundleResponseSchema,
  dialogsOpenFolderResponseSchema,
  engineProgressEventSchema,
  exchangeSummarySchema,
  exchangesGetRequestSchema,
  globalsPropertiesResponseSchema,
  historyAppendedEventSchema,
  historyClearResponseSchema,
  historyGetRequestSchema,
  historyGetResponseSchema,
  historyListRequestSchema,
  historyListResponseSchema,
  historyResendRequestSchema,
  globalsRemoveRequestSchema,
  globalsSetRequestSchema,
  projectAddInterfaceRequestSchema,
  projectAddInterfaceResponseSchema,
  projectChangedEventSchema,
  projectChangedOnDiskEventSchema,
  projectCreateRequestSchema,
  projectHydrationEventSchema,
  projectMutateRequestSchema,
  projectMutateResponseSchema,
  projectOpenRequestSchema,
  projectRecentResponseSchema,
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
  requestImportCurlRequestSchema,
  requestImportCurlResponseSchema,
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
    cancel: defineChannel('request.cancel', requestCancelRequestSchema, requestCancelResponseSchema),
    preflight: defineChannel('request.preflight', requestPreflightRequestSchema, requestPreflightResponseSchema),
    recreate: defineChannel('request.recreate', requestRecreateRequestSchema, requestRecreateResponseSchema),
    curl: defineChannel('request.curl', requestCurlRequestSchema, requestCurlResponseSchema),
    importCurl: defineChannel('request.importCurl', requestImportCurlRequestSchema, requestImportCurlResponseSchema),
  },
  project: {
    create: defineChannel('project.create', projectCreateRequestSchema, projectSnapshotResponseSchema),
    open: defineChannel('project.open', projectOpenRequestSchema, projectSnapshotResponseSchema),
    close: defineChannel('project.close', z.undefined(), projectSnapshotResponseSchema),
    snapshot: defineChannel('project.snapshot', z.undefined(), projectSnapshotResponseSchema),
    mutate: defineChannel('project.mutate', projectMutateRequestSchema, projectMutateResponseSchema),
    save: defineChannel('project.save', z.undefined(), projectSaveResponseSchema),
    recent: defineChannel('project.recent', z.undefined(), projectRecentResponseSchema),
    addInterface: defineChannel(
      'project.addInterface',
      projectAddInterfaceRequestSchema,
      projectAddInterfaceResponseSchema,
    ),
    reload: defineChannel('project.reload', z.undefined(), projectSnapshotResponseSchema),
  },
  globals: {
    get: defineChannel('globals.get', z.undefined(), globalsPropertiesResponseSchema),
    set: defineChannel('globals.set', globalsSetRequestSchema, globalsPropertiesResponseSchema),
    remove: defineChannel('globals.remove', globalsRemoveRequestSchema, globalsPropertiesResponseSchema),
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
  },
  // The CA bundle preference has channels of its own because only main may set it: the path is
  // a file main reads on every send, so it comes from a native picker main ran, never from a
  // string the renderer sends (`preferences.update` refuses one).
  ssl: {
    pickCaBundle: defineChannel('ssl.pickCaBundle', sslPickCaBundleRequestSchema, sslPickCaBundleResponseSchema),
    clearCaBundle: defineChannel('ssl.clearCaBundle', sslClearCaBundleRequestSchema, sslClearCaBundleResponseSchema),
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
  // Re-reads one cached exchange, redacted per the show-secrets flag as it stands *now*, so a
  // toggle can reveal (or re-hide) an entry the HTTP log already holds.
  exchanges: {
    get: defineChannel('exchanges.get', exchangesGetRequestSchema, exchangeSummarySchema),
  },
  history: {
    list: defineChannel('history.list', historyListRequestSchema, historyListResponseSchema),
    get: defineChannel('history.get', historyGetRequestSchema, historyGetResponseSchema),
    clear: defineChannel('history.clear', z.undefined(), historyClearResponseSchema),
    resend: defineChannel('history.resend', historyResendRequestSchema, exchangeSummarySchema),
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
  },
  command: {
    /** A menu item was clicked; the renderer runs it through the command registry. */
    invoke: defineEvent('command.invoke', commandInvokeEventSchema),
  },
  engine: {
    progress: defineEvent('engine.progress', engineProgressEventSchema),
  },
  globals: {
    changed: defineEvent('globals.changed', globalsPropertiesResponseSchema),
  },
  preferences: {
    changed: defineEvent('preferences.changed', preferencesResponseSchema),
  },
  theme: {
    /** The OS flipped between light and dark; `system` re-resolves on it. */
    changed: defineEvent('theme.changed', themeChangedEventSchema),
  },
  project: {
    changed: defineEvent('project.changed', projectChangedEventSchema),
    changedOnDisk: defineEvent('project.changedOnDisk', projectChangedOnDiskEventSchema),
    hydration: defineEvent('project.hydration', projectHydrationEventSchema),
  },
  history: {
    appended: defineEvent('history.appended', historyAppendedEventSchema),
  },
} as const;
