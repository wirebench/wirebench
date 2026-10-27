/**
 * SOAP's share of the IPC registry (kind modules spec §4.3): its channels and events, with
 * the names, groups and payloads they always had. `ipc.ts` composes them with core's.
 */
import { defineChannel } from '../../ipc-contract.js';
import { historyResendRequestSchema } from '../../wire-base.js';
import {
  definitionApplyUpdateResponseSchema,
  projectAddInterfaceResponseSchema,
  projectImportLegacyResponseSchema,
} from '../../wire-types.js';
import {
  attachmentsAddDroppedRequestSchema,
  attachmentsAddDroppedResponseSchema,
  attachmentsOpenRequestRequestSchema,
  attachmentsOpenResponseRequestSchema,
  attachmentsOpenResponseSchema,
  attachmentsPickFilesRequestSchema,
  attachmentsPickFilesResponseSchema,
  attachmentsSaveResponseRequestSchema,
  attachmentsSaveResponseResponseSchema,
  definitionApplyUpdateRequestSchema,
  definitionCancelImportRequestSchema,
  definitionCancelImportResponseSchema,
  definitionCloseRequestSchema,
  definitionCloseResponseSchema,
  definitionDeclarationAtRequestSchema,
  definitionDeclarationAtResponseSchema,
  definitionDocumentTextRequestSchema,
  definitionDocumentTextResponseSchema,
  definitionDocumentsResponseSchema,
  definitionExportRequestSchema,
  definitionExportResponseSchema,
  definitionGenerateDocsRequestSchema,
  definitionGenerateDocsResponseSchema,
  definitionImportRequestSchema,
  definitionInterfaceRequestSchema,
  definitionPlanUpdateRequestSchema,
  definitionSchemaIndexResponseSchema,
  definitionUpdatePlanResponseSchema,
  exchangeSummarySchema,
  interfaceSummarySchema,
  issuedTokenLocatorSchema,
  issuedTokenStatusSchema,
  projectAddInterfaceRequestSchema,
  projectImportLegacyRequestSchema,
  requestGenerateRequestSchema,
  requestGenerateResponseSchema,
  requestRecreateRequestSchema,
  requestRecreateResponseSchema,
  requestSendRequestSchema,
  validateMessageRequestSchema,
  validateMessageResponseSchema,
  wsaEnvelopeResponseSchema,
  wsaInsertHeadersRequestSchema,
  wsaRemoveHeadersRequestSchema,
  wsiCheckExchangeRequestSchema,
  wsiCheckWsdlRequestSchema,
  wsiExportHtmlRequestSchema,
  wsiExportHtmlResponseSchema,
  wsiReportWireSchema,
  wssEnvelopeResponseSchema,
  wssInsertEntryRequestSchema,
  wssPolicyStatusRequestSchema,
  wssPolicyStatusResponseSchema,
  wssPreviewOutgoingRequestSchema,
  wssPreviewResponseSchema,
  wssRemoveOutgoingRequestSchema,
  xmlApplyFormEditRequestSchema,
  xmlApplyFormEditResponseSchema,
  xmlCompletionsRequestSchema,
  xmlCompletionsResponseSchema,
  xmlDeclarationResponseSchema,
  xmlDescribeManyRequestSchema,
  xmlDescribeManyResponseSchema,
  xmlFormRequestSchema,
  xmlFormResponseSchema,
  xmlPathRequestSchema,
  xpathEvaluateRequestSchema,
  xpathEvaluateResponseSchema,
  xpathNamespacesRequestSchema,
  xpathNamespacesResponseSchema,
} from './wire.js';

/** SOAP's IPC channels, by the group each sits in; `ipc.ts` spreads them into `channels`. */
export const soapChannels = {
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
    recreate: defineChannel('request.recreate', requestRecreateRequestSchema, requestRecreateResponseSchema),
  },
  issuedTokens: {
    status: defineChannel('issuedTokens.status', issuedTokenLocatorSchema, issuedTokenStatusSchema),
    fetch: defineChannel('issuedTokens.fetch', issuedTokenLocatorSchema, issuedTokenStatusSchema),
    clear: defineChannel('issuedTokens.clear', issuedTokenLocatorSchema, issuedTokenStatusSchema),
  },
  project: {
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
  },
  history: {
    resend: defineChannel('history.resend', historyResendRequestSchema, exchangeSummarySchema),
  },
  xml: {
    completions: defineChannel('xml.completions', xmlCompletionsRequestSchema, xmlCompletionsResponseSchema),
    declaration: defineChannel('xml.declaration', xmlPathRequestSchema, xmlDeclarationResponseSchema),
    describeMany: defineChannel('xml.describeMany', xmlDescribeManyRequestSchema, xmlDescribeManyResponseSchema),
    form: defineChannel('xml.form', xmlFormRequestSchema, xmlFormResponseSchema),
    applyFormEdit: defineChannel('xml.applyFormEdit', xmlApplyFormEditRequestSchema, xmlApplyFormEditResponseSchema),
  },
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
  wsa: {
    insertHeaders: defineChannel('wsa.insertHeaders', wsaInsertHeadersRequestSchema, wsaEnvelopeResponseSchema),
    removeHeaders: defineChannel('wsa.removeHeaders', wsaRemoveHeadersRequestSchema, wsaEnvelopeResponseSchema),
  },
  wss: {
    previewOutgoing: defineChannel('wss.previewOutgoing', wssPreviewOutgoingRequestSchema, wssPreviewResponseSchema),
    insertEntry: defineChannel('wss.insertEntry', wssInsertEntryRequestSchema, wssEnvelopeResponseSchema),
    removeOutgoing: defineChannel('wss.removeOutgoing', wssRemoveOutgoingRequestSchema, wssEnvelopeResponseSchema),
    policyStatus: defineChannel('wss.policyStatus', wssPolicyStatusRequestSchema, wssPolicyStatusResponseSchema),
  },
  xpath: {
    evaluate: defineChannel('xpath.evaluate', xpathEvaluateRequestSchema, xpathEvaluateResponseSchema),
    namespaces: defineChannel('xpath.namespaces', xpathNamespacesRequestSchema, xpathNamespacesResponseSchema),
  },
  validate: {
    message: defineChannel('validate.message', validateMessageRequestSchema, validateMessageResponseSchema),
  },
  wsi: {
    checkWsdl: defineChannel('wsi.checkWsdl', wsiCheckWsdlRequestSchema, wsiReportWireSchema),
    checkExchange: defineChannel('wsi.checkExchange', wsiCheckExchangeRequestSchema, wsiReportWireSchema),
    exportHtml: defineChannel('wsi.exportHtml', wsiExportHtmlRequestSchema, wsiExportHtmlResponseSchema),
  },
} as const;
