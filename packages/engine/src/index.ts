export {
  WirebenchError,
  WsdlParseError,
  SchemaError,
  HttpError,
  WsaError,
  WssError,
  ProjectError,
  ValidationError,
  isWirebenchError,
} from './errors.js';
export type { WirebenchErrorOptions } from './errors.js';

export { parseXml, parseXmlDetailed, getPosition, classifyParseEvent } from './xml/parse.js';
export type { ParseXmlOptions, XmlProblem, ParseEventClassification } from './xml/parse.js';
export { serializeXml } from './xml/serialize.js';
export { NS, PREFIX } from './xml/namespaces.js';
export type { NamespaceUri } from './xml/namespaces.js';
export { LineIndex } from './xml/positions.js';
export type { LinePosition } from './xml/positions.js';

export { evaluate } from './xpath/evaluate.js';
export type { EvaluateOptions, QueryResult, QueryNodeItem, QueryValueItem } from './xpath/evaluate.js';
export { evaluateWithTimeout } from './xpath/evaluate-async.js';
export type { EvaluateWithTimeoutOptions } from './xpath/evaluate-async.js';
export { collectNamespaces, suggestPrefixes } from './xpath/namespaces.js';

export { parseQName, qnameEquals, qnameToString } from './wsdl/qname.js';
export type { QName } from './wsdl/qname.js';
export { findBinding, findMessage, findPortType, findService } from './wsdl/model.js';
export type {
  Binding,
  BindingFault,
  BindingMessage,
  BindingOperation,
  Fault,
  Message,
  MessageRef,
  MimePartInfo,
  Operation,
  Part,
  Port,
  PortType,
  Service,
  SoapBody,
  SoapHeader,
  SoapHeaderFault,
  SoapUse,
  SoapVersion,
  WsdlDefinition,
  WsdlImport,
} from './wsdl/model.js';
export { parseWsdl, parseWsdlDocument } from './wsdl/parse-wsdl.js';
export type { ParseWsdlOptions, WsdlDocumentSource } from './wsdl/parse-wsdl.js';
export { parseWsdlBundle } from './wsdl/merge.js';
export { resolveDefinition } from './wsdl/resolver.js';
export type {
  BundledDocument,
  DefinitionBundle,
  DefinitionSource,
  FetchDocument,
  FetchedDocument,
  ResolveOptions,
  ResolveProblem,
} from './wsdl/resolver.js';
export { createDefaultFetchDocument } from './wsdl/fetch.js';
export { assignFileNames } from './wsdl/cache-naming.js';
export type { NamedDocument } from './wsdl/cache-naming.js';
export { createCachedFetchDocument, readDefinitionCache, writeDefinitionCache } from './wsdl/cache.js';
export type { DefinitionCacheOptions, WriteDefinitionCacheOptions } from './wsdl/cache.js';
export { exportDefinition } from './wsdl/export-definition.js';
export type { ExportDefinitionOptions, ExportedFile, ExportResult } from './wsdl/export-definition.js';
export { generateDocs } from './wsdl/docs-generator.js';
export type { GenerateDocsOptions } from './wsdl/docs-generator.js';
export { applyUpdate, planUpdate } from './wsdl/update-definition.js';
export type {
  ApplyUpdateOptions,
  ApplyUpdateResult,
  ChangedOperation,
  OperationChangeReason,
  UpdatePlan,
} from './wsdl/update-definition.js';

export { buildSchemaSet } from './xsd/schema-set.js';
export type { SchemaSet, SchemaSetInput, SchemaElementsInput } from './xsd/schema-set.js';
export {
  elementPathAt,
  completionContextAt,
  childrenAllowedAt,
  attributesAllowedAt,
  declarationOf,
} from './xsd/locate.js';
export type { CompletionContext, TextRange } from './xsd/locate.js';
export { BUILTIN_TYPES, SOAP_ENC_ATTRIBUTES, XSD_BUILTIN_NAMES, isBuiltinType, lookupBuiltin } from './xsd/builtins.js';
export type { BuiltinType } from './xsd/builtins.js';
export {
  DEFAULT_GENERATE_OPTIONS,
  generateElement,
  generateSoapEncArray,
  generateType,
} from './xsd/sample-generator.js';
export type { GenerateOptions, GeneratedFragment } from './xsd/sample-generator.js';
export { PLACEHOLDER, facetsOf, sampleValueFor, typeCommentFor } from './xsd/sample-values.js';
export type { FormFacets, SampleValueContext, SampleValueOptions, SimpleTypeRef } from './xsd/sample-values.js';
export { scanXml } from './xsd/xml-scan.js';
export type { ScanXmlResult, ScannedAttribute, ScannedElement } from './xsd/xml-scan.js';
export { applyForm, buildForm, buildFormForType } from './xsd/form-model.js';
export type {
  ApplyFormOptions,
  BuildFormOptions,
  FormExtraAttribute,
  FormNode,
  FormRepeat,
  FormType,
  FormValueBase,
} from './xsd/form-model.js';
export { applyFormEdit } from './xsd/form-edits.js';
export type { FormEdit } from './xsd/form-edits.js';

export type {
  All,
  AnyAttribute,
  AnyParticle,
  AttributeDecl,
  AttributeGroup,
  AttributeGroupRef,
  AttributeRef,
  AttributeUse,
  AttributeUseKind,
  Choice,
  ComplexContentModel,
  ComplexType,
  Compositor,
  ElementDecl,
  ElementRef,
  Facet,
  Group,
  GroupRef,
  LocalElement,
  Occurs,
  Particle,
  ProcessContents,
  ResolvedAttribute,
  ResolvedContent,
  SchemaProblem,
  Sequence,
  SimpleType,
  SourceRef,
  TypeDefinition,
} from './xsd/model.js';

export { createEnvelope, detectEnvelopeVersion, envelopeNamespace, SOAP_ENVELOPE_PREFIX } from './soap/envelope.js';
export type { EnvelopeParts, SoapEnvelopeVersion } from './soap/envelope.js';
export { prefixForNamespace, RESERVED_PREFIXES } from './soap/prefixes.js';
export { NamespaceScope } from './soap/namespace-scope.js';
export { soapActionHeaders } from './soap/soap-action.js';
export type { SoapActionHeaders, SoapActionOptions } from './soap/soap-action.js';
export type { BuildProblem, BuildProblemCode } from './soap/build-problems.js';
export { buildEmptyRequest, buildSampleRequest } from './soap/request-builder.js';
export type { GeneratedRequest, OperationRef, RequestBuildInput, RequestBuildOptions } from './soap/request-builder.js';
export { buildRequestForm } from './soap/form-request.js';
export type { RequestForm } from './soap/form-request.js';
export { isSoapFault, parseFault } from './soap/fault.js';
export type { FaultReason, SoapFault } from './soap/fault.js';
export { recreateRequest } from './soap/recreate.js';
export type { RecreateOptions, RecreateResult } from './soap/recreate.js';
export { fromCurl, toCurl } from './http/curl.js';
export type { FromCurlResult, ToCurlOptions } from './http/curl.js';
export { parseSoapResponse } from './soap/response-parser.js';
export type { ParsedSoapResponse } from './soap/response-parser.js';

export {
  DEFAULT_ROOT_CONTENT_ID,
  buildMultipartRelated,
  mediaTypeOf,
  mimeParameter,
  parseMultipartRelated,
  stripContentId,
} from './soap/mime/multipart.js';
export type { BuildMultipartInput, BuiltMultipart, ParsedMultipart } from './soap/mime/multipart.js';
export { XOP_NS, expandMtomResponse, prepareMtomRequest, xopContentType } from './soap/mime/mtom.js';
export type { ExpandedMtom, MtomOptions, PreparedMtom } from './soap/mime/mtom.js';
export { collectResponseAttachments, prepareSwaRequest } from './soap/mime/swa.js';
export type { PreparedSwa, SwaOptions } from './soap/mime/swa.js';
export { inlineFiles } from './soap/mime/inline-files.js';
export type { InlineFileProblem, InlineFilesOptions, InlinedFiles } from './soap/mime/inline-files.js';
export { findCidReferences, forEachScannedElement, spliceRanges } from './soap/mime/cid-scan.js';
export type { CidReference, CidScan } from './soap/mime/cid-scan.js';
export type {
  AttachmentResolver,
  BuildTransferEncoding,
  MimePart,
  MultipartPart,
  MultipartRoot,
  ResponseAttachment,
  TransferEncoding,
} from './soap/mime/types.js';

export { basicAuthorization, isBasicChallenge, parseWwwAuthenticate } from './http/auth/basic.js';
export type { AuthChallenge } from './http/auth/basic.js';
export {
  AV_IDS,
  DEFAULT_NEGOTIATE_FLAGS,
  NTLM_FLAGS,
  buildAvPairs,
  createType1,
  createType3,
  encodeNtlmAuthorization,
  lmv2Response,
  ntProofString,
  ntlmv2Blob,
  ntowfv2,
  offersNtlm,
  parseAvPairs,
  parseNtlmChallengeHeader,
  parseType2,
  parseType3,
  toFileTime,
} from './http/auth/ntlm.js';
export type { Type1Options, Type2Message, Type3Message, Type3Params, Type3Result } from './http/auth/ntlm.js';
export { md4 } from './http/auth/md4.js';
export { ntlmHandshake } from './http/auth/ntlm-transport.js';
export type { NtlmCredentials, NtlmHandshakeOptions, NtlmHandshakeResult } from './http/auth/ntlm-transport.js';
export { createDispatcher, createSingleConnectionDispatcher, sendHttp } from './http/client.js';
export { buildRawRequest, buildRawResponse } from './http/raw-capture.js';
export type { HttpErrorCode, HttpExchange, HttpRequest, ProxyOptions, Timings, TlsOptions } from './http/types.js';
export { isExcluded, parseSystemProxy, resolveProxyFor } from './http/proxy.js';
export type { ProxyConfig, ResolveProxyOptions } from './http/proxy.js';
export { captureSslInfo } from './http/tls.js';
export type { PeerCert, SslInfo, TlsSocketLike } from './http/tls.js';

export { importDefinition } from './import.js';
export { sendSoapRequest } from './send.js';
export { generateEmptyRequest, generateRequest } from './generate.js';
export { summarizeOperations } from './operations.js';
export type {
  ImportCacheOptions,
  ImportOptions,
  ImportProblem,
  ImportProgress,
  ImportResult,
  ImportSource,
  OperationSummary,
  AuthSummary,
  SendAttachmentOptions,
  SendAuth,
  SoapExchange,
  SoapSendInput,
  SoapSendWsa,
  SoapSendWss,
} from './types.js';

export {
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_REQUEST_PROPERTIES,
  FORMAT_VERSION,
  createInterface,
  createProject,
  createRequest,
  defaultContentId,
  generateId,
} from './project/model.js';
export type {
  Attachment,
  AttachmentSource,
  AttachmentType,
  CreateInterfaceInput,
  CreateOptions,
  CreateRequestInput,
  Endpoint,
  EndpointAuth,
  Environment,
  HeaderEntry,
  IdGenerator,
  Interface,
  OperationDef,
  Project,
  ProjectSettings,
  PropertyMap,
  RequestDef,
  RequestProperties,
  WsaConfig,
  WssRef,
} from './project/model.js';
export {
  ATTACHMENTS_DIR,
  ENVIRONMENTS_DIR,
  INTERFACES_DIR,
  OPERATIONS_DIR,
  REQUEST_SUFFIX,
  WSS_DIR,
  definitionCacheDir,
  definitionDir,
  environmentFile,
  interfaceDir,
  interfaceFile,
  keystoresFile,
  manifestFile,
  operationDir,
  requestFiles,
  slugify,
  uniqueSlug,
  wssFile,
} from './project/paths.js';
export type { RequestFilePair } from './project/paths.js';
export {
  definitionCacheManifestSchema,
  environmentFileSchema,
  interfaceFileSchema,
  keystoreEntrySchema,
  keystoresFileSchema,
  manifestSchema,
  parseFile,
  requestFileSchema,
  wssIncomingFileSchema,
  wssEntrySchema,
  wssOutgoingFileSchema,
} from './project/schema.js';
export type {
  DefinitionCacheDocument,
  DefinitionCacheManifest,
  EnvironmentFile,
  InterfaceFile,
  ManifestFile,
  RequestFile,
} from './project/schema.js';
export { DEFAULT_PREFERENCES, mergePreferences, preferencesSchema, resetPreferences } from './project/preferences.js';
export type {
  EditorPreferences,
  HttpPreferences,
  LayoutPreference,
  Preferences,
  PreferencesPatch,
  PreferencesSection,
  ProxyPreferences,
  SslPreferences,
  UiPreferences,
  WsdlPreferences,
  WsiPreferences,
} from './project/preferences.js';
export { toSendInput } from './send-options.js';
export type { AttachmentResolvers, SendRequestInput, ToSendInputArgs } from './send-options.js';
export { entitizeValue, prettyPrint, removeEmptyContent, stripWhitespaces } from './soap/transforms.js';
export { formatXml } from './xml/pretty.js';
export type { FormatXmlOptions, FormatXmlResult } from './xml/pretty.js';
export { migrate } from './project/migrate.js';
export { KEYSTORES_PATH, MANIFEST_PATH, projectFiles } from './project/serialize.js';
export type { ProjectFiles } from './project/serialize.js';
export { loadProject } from './project/load.js';
export type { LoadProjectOptions, LoadResult, ProjectProblem } from './project/load.js';
export { saveProject } from './project/save.js';
export type { SaveProjectOptions, SaveResult } from './project/save.js';
export {
  attachmentFile,
  attachmentsDir,
  attachmentsIndexFile,
  createFileAttachmentResolver,
  listAttachments,
  pruneAttachments,
  putAttachment,
  readAttachment,
} from './project/attachments-cache.js';
export type { AttachmentCacheEntry, AttachmentCacheOptions } from './project/attachments-cache.js';
export { nodeFs } from './project/fs.js';
export type { DirEntry, FileStat, FsLike } from './project/fs.js';
export { appendHistory, generateHistoryId, openHistory } from './project/history.js';
export type {
  HistoryEntry,
  HistoryError,
  HistoryFault,
  HistoryFile,
  HistoryHeader,
  HistoryListQuery,
  HistoryOptions,
} from './project/history.js';
export { expand, expandSendInput, hasExpansions } from './project/properties.js';
export type { ExpandOptions, ExpandResult, PropertyScopes, UnresolvedRef } from './project/properties.js';
export { effectiveAuth } from './project/endpoints.js';
export { toKeystoreDef, toKeystoreRef } from './project/keystores.js';
export { toWssIncomingConfig, toWssIncomingRef, toWssOutgoingConfig, toWssOutgoingRef } from './project/wss-configs.js';
// ---------------------------------------------------------------------------
// WS-Addressing (Task 41)
// ---------------------------------------------------------------------------
export { DEFAULT_WSA_CONFIG, effectiveWsa, normalizeWsa } from './wsa/model.js';
export type { WsaConfigPatch, WsaMustUnderstand, WsaVersion } from './wsa/model.js';
export {
  WSA_PREFIX,
  anonymousAddress,
  applyWsaHeaders,
  buildWsaHeaders,
  defaultRelationshipType,
  effectiveAction,
  effectiveMessageId,
  effectiveTo,
  stripWsaHeaders,
  wsaNamespace,
} from './wsa/headers.js';
export type { WsaHeaderContext } from './wsa/headers.js';
export { defaultAction, detectWsaDefaults, summarizeWsa } from './wsa/policy-detect.js';
export type { WsaDetection, WsaSummary } from './wsa/policy-detect.js';

export { applyOutgoingWss, removeOutgoingWss } from './wss/apply.js';
export type { ApplyOutgoingWssOptions, WssRequestProperties } from './wss/apply.js';
export {
  createWssContext,
  DEFAULT_WSS_ENCRYPTION_PARTS,
  DEFAULT_WSS_TIMESTAMP_SKEW_SECONDS,
  DEFAULT_WSS_SIGNATURE_PARTS,
  WSS_ENTRY_KINDS,
} from './wss/model.js';
export type {
  WssContext,
  WssDigestAlgorithm,
  WssEncryptionEntry,
  WssEntry,
  WssKeyIdentifierType,
  WssKeyTransportAlgorithm,
  WssPart,
  WssSymmetricAlgorithm,
  WssIncomingConfig,
  WssOutgoingConfig,
  WssPasswordType,
  WssSignatureAlgorithm,
  WssSignatureEntry,
  WssTimestampEntry,
  WssUsernameTokenEntry,
} from './wss/model.js';
export { buildTimestamp, formatWssDateTime } from './wss/outgoing/timestamp.js';
export type { BuildTimestampInput } from './wss/outgoing/timestamp.js';
export { buildUsernameToken, passwordDigest } from './wss/outgoing/username-token.js';
export type { BuildUsernameTokenInput } from './wss/outgoing/username-token.js';
export { signEnvelope, verifySignature } from './wss/outgoing/signature.js';
export type { ResolvedSigningKey, VerifySignatureOptions, VerifySignatureResult } from './wss/outgoing/signature.js';
export { processIncomingWss } from './wss/incoming/index.js';
export type { ProcessIncomingWssOptions, WssAction, WssActionKind, WssResult } from './wss/incoming/index.js';
export { decryptIncoming } from './wss/incoming/decrypt.js';
export type { DecryptIncomingResult, ResolvedDecryptionKey } from './wss/incoming/decrypt.js';
export { verifyIncoming } from './wss/incoming/verify.js';
export type {
  IncomingSignatureResult,
  IncomingTimestampResult,
  VerifyIncomingOptions,
  VerifyIncomingResult,
} from './wss/incoming/verify.js';
export { decryptEnvelope, encryptEnvelope } from './wss/outgoing/encryption.js';
export type {
  DecryptEnvelopeOptions,
  DecryptEnvelopeResult,
  ResolvedEncryptionKey,
} from './wss/outgoing/encryption.js';
export {
  buildKeyIdentifier,
  certificateBase64,
  certificateDer,
  issuerDnRfc2253,
  pkiPathBase64,
  serialNumberDecimal,
  subjectKeyIdentifierBase64,
  thumbprintSha1Base64,
  WSS_TOKEN_TYPES,
} from './wss/key-identifiers.js';
export type { KeyIdentifier, KeyIdentifierInput } from './wss/key-identifiers.js';
export {
  keystoreTypeForPath,
  loadKeystore,
  loadPem,
  loadPkcs12,
  selectAlias,
  toTlsClientIdentity,
} from './wss/keystore/index.js';
export type {
  Keystore,
  KeystoreAlias,
  KeystoreDef,
  KeystoreType,
  LoadKeystoreOptions,
  TlsClientIdentity,
} from './wss/keystore/index.js';
export {
  findEnvironment,
  removeEnvironment,
  resolveAuthEndpoint,
  resolveEndpoint,
  resolveScopes,
  upsertEnvironment,
} from './project/environments.js';
export type { EndpointSource } from './project/environments.js';
export {
  bindingContextFor,
  checkSoapStructure,
  validateAgainstSchemaSet,
  validateMessage,
  DEFAULT_VALIDATION_TIMEOUT_MS,
} from './validate/index.js';
export type {
  MessageDirection,
  SchemaValidationOptions,
  SchemaValidationTarget,
  SoapStructureOptions,
  ValidateMessageInput,
  ValidateMessageResult,
  ValidationBinding,
  ValidationPart,
  ValidationProblem,
  ValidationSeverity,
  ValidationSource,
} from './validate/index.js';

export {
  WSI_WSDL_ASSERTIONS,
  WSI_MESSAGE_ASSERTIONS,
  messageBindingFor,
  runMessageAssertions,
  wsiMessageContext,
  renderWsiReportHtml,
  escapeHtml,
  runWsdlAssertions,
  wsiWsdlContext,
  wsiProblems,
  NOT_APPLICABLE,
  isNotApplicable,
} from './validate/wsi/index.js';
export type {
  RunWsdlAssertionsOptions,
  WsiAssertion,
  WsiAssertionLevel,
  WsiAssertionReport,
  WsiAssertionResult,
  WsiCheckOutcome,
  WsiFinding,
  WsiLocation,
  WsiNotApplicable,
  WsiReport,
  WsiSummary,
  WsiWsdlContext,
  WsiWsdlContextInput,
  WsiMessageAssertion,
  WsiMessageBinding,
  WsiMessageContext,
  WsiMessageDirection,
  WsiMessageView,
  RunMessageAssertionsOptions,
  RenderWsiReportHtmlOptions,
} from './validate/wsi/index.js';
export { renderWsiAssertionsMarkdown, WSI_PLANNED_ASSERTIONS } from './validate/wsi/index.js';
export type { PlannedAssertion } from './validate/wsi/index.js';
