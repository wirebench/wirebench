export { evaluateAssertions } from './assert/index.js';
export type {
  Assertion,
  AssertionLanguage,
  AssertionResult,
  AssertionSubject,
  MatchAssertion,
  SchemaAssertion,
  SlaAssertion,
  SoapFaultAssertion,
  StatusAssertion,
} from './assert/model.js';
export { assertionsSchema } from './assert/schema.js';

export * from './run/index.js';

export {
  WirebenchError,
  WsdlParseError,
  SchemaError,
  HttpError,
  WsaError,
  WssError,
  ProjectError,
  ValidationError,
  WorkspaceError,
  OpenApiError,
  AsyncApiError,
  PostmanError,
  LegacyProjectError,
  ProtoError,
  GrpcError,
  WsError,
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

export { evaluate, evaluateJson } from './xpath/evaluate.js';
export type { EvaluateOptions, QueryLanguage, QueryResult, QueryNodeItem, QueryValueItem } from './xpath/evaluate.js';
export { evaluateJsonPath } from './xpath/jsonpath.js';
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
export { fromCurl, soapToCurl, toCurl } from './http/curl.js';
export type { CurlBody, CurlCommand, CurlHeader, CurlPart } from './http/curl.js';
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
export { FAILED_REQUEST_BODY_CAP_BYTES, failedRequestOf } from './http/failed-request.js';
export type { FailedRequest } from './http/failed-request.js';
export { buildRawRequest, buildRawResponse } from './http/raw-capture.js';
export type {
  HttpErrorCode,
  HttpExchange,
  HttpRequest,
  HttpStreamHook,
  HttpStreamSink,
  ProxyOptions,
  Timings,
  TlsOptions,
} from './http/types.js';
export { isExcluded, parseSystemProxy, resolveProxyFor } from './http/proxy.js';
export type { SystemProxyResolution } from './http/proxy.js';
export type { ProxyConfig, ResolveProxyOptions } from './http/proxy.js';
export { captureSslInfo, splitPemBundle } from './http/tls.js';
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
  DEFAULT_OAUTH2_AUTH,
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
  AnyRequestDef,
  ApiKeyAuth,
  Attachment,
  AttachmentSource,
  AttachmentType,
  AuthConfig,
  AuthType,
  BearerAuth,
  CreateInterfaceInput,
  CreateOptions,
  CreateRequestInput,
  Endpoint,
  EndpointAuth,
  Environment,
  HeaderEntry,
  IdGenerator,
  InheritAuth,
  Interface,
  OAuth2Auth,
  OperationDef,
  Project,
  ProjectSettings,
  PropertyMap,
  RequestDef,
  RequestProperties,
  SoapOwnerAuth,
  SoapRequestDef,
  WsaConfig,
  WssRef,
} from './project/model.js';
export {
  COMMON_METHODS,
  NO_BODY,
  RAW_LANGUAGE_CONTENT_TYPES,
  RAW_LANGUAGE_EXTENSIONS,
  apiFolders,
  apiRequests,
  createApi,
  createFolder,
  createRestRequest,
  entry,
  folderRequests,
} from './rest/model.js';
export { bodyLanguage, encodeFormFields, encodeRestBody, escapeForLanguage, rawContentType } from './rest/body.js';
export type { EncodeBodyOptions, EncodedBody, FileResolver } from './rest/body.js';
export { applyAuth, missingSecretRef, resolveAuthChain, resolveAuthChainIndex } from './rest/auth.js';
export type { AppliedAuth } from './rest/auth.js';
export { applySoapAuth } from './soap/auth.js';
export type { SoapAppliedAuth } from './soap/auth.js';
export { cookieHeader, cookiesToSend, defaultPath, domainMatches, isExpired, pathMatches } from './rest/cookies.js';
export type { CookieMatchOptions } from './rest/cookies.js';
export { decodeResponseText, detectLanguage, parseSetCookie, prettyBody } from './rest/response.js';
export type { BodyLanguage, Cookie, DecodedText, PrettyBody } from './rest/response.js';
export {
  TOKEN_REFRESH_MARGIN_MS,
  authorizationUrl,
  buildTokenRequest,
  needsRefresh,
  newState,
  parseTokenResponse,
  pkce,
} from './rest/oauth2.js';
export type {
  AuthorizationUrlInput,
  OAuth2Secrets,
  PkcePair,
  TokenGrantInput,
  TokenRequestOptions,
  TokenResponseInput,
  TokenSet,
} from './rest/oauth2.js';
export { fromRestCurl, restToCurl, CURL_REDACTED } from './rest/curl.js';
export type { FromRestCurlOptions, FromRestCurlResult, RestToCurlOptions } from './rest/curl.js';
export { expandRestSendInput } from './rest/expand.js';
export type { ExpandRestOptions } from './rest/expand.js';
export { decodeRestResponse, sendRest } from './rest/send.js';
export type { RestEventStream, RestExchange, RestSendInput, RestSendRequest, RestSendSettings } from './rest/send.js';
export { createSseParser, eventStreamDocument, isEventStream, serializeEventStream } from './rest/sse.js';
export type { SseParser, SseRow } from './rest/sse.js';
export { capSseRows, createSseRowStore, SSE_HISTORY_LIMITS, SSE_SUMMARY_LIMITS } from './rest/sse-transcript.js';
export type { SseRowStore, SseTranscript } from './rest/sse-transcript.js';
export { composeUrl, encodeValue, joinBase, joinQuery, parseUrlParams, splitQuery } from './rest/url.js';
// OpenAPI: reading a description into the model an import maps onto an API.
export { parseAsyncApi } from './asyncapi/parse.js';
export type { ParseAsyncApiOptions, ParsedAsyncApi } from './asyncapi/parse.js';
export type * from './asyncapi/model.js';
export { mapAsyncApi } from './asyncapi/map.js';
export type { AsyncApiImportSummary, MapAsyncApiOptions, MappedAsyncApi } from './asyncapi/map.js';
export { authFromScheme as asyncApiAuthFromScheme } from './asyncapi/security.js';
export type { AsyncApiSchemeInput } from './asyncapi/security.js';
export { importAsyncApi } from './asyncapi/import.js';
export { applyAsyncApiUpdate, planAsyncApiUpdate } from './asyncapi/update.js';
export type {
  ApplyAsyncApiUpdateOptions,
  AsyncApiApplyResult,
  AsyncApiChangeReason,
  AsyncApiOpRef,
  AsyncApiUpdatePlan,
} from './asyncapi/update.js';
export {
  channelMessages as asyncApiChannelMessages,
  checkFrame as checkAsyncApiFrame,
  createFrameChecker,
  DEFAULT_FRAME_CHECK_BUDGET_MS,
  MAX_CHECKED_FRAME_BYTES,
} from './asyncapi/frame-check.js';
export type { ChannelMessages, FrameChecker, FrameCheckOptions } from './asyncapi/frame-check.js';
export {
  createWorkerFrameChecker,
  DEFAULT_FRAME_CHECK_DEADLINE_MS,
  DEFAULT_FRAME_CHECK_QUEUE,
  DEFAULT_FRAME_CHECK_QUEUE_BYTES,
} from './asyncapi/frame-check-worker-host.js';
export type { WorkerFrameChecker, WorkerFrameCheckerOptions } from './asyncapi/frame-check-worker-host.js';
export type { ImportAsyncApiOptions, ImportedAsyncApi } from './asyncapi/import.js';
export { importOpenApi, parseOpenApi } from './rest/openapi/import.js';
export type { ImportedOpenApi, ImportOpenApiOptions } from './rest/openapi/import.js';
export { apiFromDocument, authFromScheme, mapScheme } from './rest/openapi/map.js';
export type { MapApiOptions, MappedApi, OpenApiImportSummary, OpenApiSchemeCandidate } from './rest/openapi/map.js';
export { createCachedApiFetch, readApiDefinitionCache, writeApiDefinitionCache } from './rest/openapi/cache.js';
export type {
  ApiDefinitionCacheOptions,
  CachedApiDefinition,
  WriteApiDefinitionCacheOptions,
} from './rest/openapi/cache.js';
export type { OpenApiSource, ParsedOpenApi, ParseOpenApiOptions } from './rest/openapi/import.js';
export { parseDocumentText, parseOpenApiDocument, parseSchema, versionOf } from './rest/openapi/parse.js';
export { selectResponse } from './rest/openapi/responses.js';
export type { ResponseSelection } from './rest/openapi/responses.js';
export { matchOperation } from './rest/openapi/match.js';
export type { RestOperationRef } from './rest/openapi/match.js';
export {
  checkRestResponse,
  DEFAULT_REST_CHECK_BUDGET_MS,
  MAX_CHECKED_BODY_BYTES,
  MAX_CONTRACT_MESSAGE_LENGTH,
  MAX_CONTRACT_PROBLEMS,
} from './rest/contract-check.js';
export type {
  RestContractCheckOptions,
  RestContractInput,
  RestContractProblem,
  RestContractResult,
  RestContractStatus,
} from './rest/contract-check.js';
export {
  createRestContractChecker,
  DEFAULT_REST_CHECK_DEADLINE_MS,
  DEFAULT_REST_CHECK_QUEUE,
} from './rest/contract-check-worker-host.js';
export type { RestContractChecker, RestContractCheckerOptions } from './rest/contract-check-worker-host.js';
export { pointerRange } from './json/pointer-range.js';
export type { PointerTextRange } from './json/pointer-range.js';
export { resolvePointer, resolveRefs, unescapePointerToken, MAX_REF_DEPTH } from './rest/openapi/refs.js';
export type { RefProblem, ResolvedDocument, ResolvedRefs, ResolveRefsOptions } from './rest/openapi/refs.js';
export { sampleFromSchema, sampleXml, MAX_SAMPLE_DEPTH } from './rest/openapi/sample.js';
export type { SampleOptions, SampleXmlOptions } from './rest/openapi/sample.js';
export { applyJsonFormEdit, buildJsonForm, toWireSchema } from './rest/json-form.js';
export type { JsonFormEdit, JsonFormKind, JsonFormNode, JsonFormOptions, JsonFormValueType } from './rest/json-form.js';
export { serverUrl, HTTP_METHODS } from './rest/openapi/model.js';
export type {
  JsonSchema,
  JsonValue,
  OpenApiDocument,
  OpenApiExample,
  OpenApiInfo,
  OpenApiMediaType,
  OpenApiOAuthFlow,
  OpenApiOperation,
  OpenApiResponses,
  OpenApiParameter,
  OpenApiRequestBody,
  OpenApiSecurityRequirement,
  OpenApiSecurityScheme,
  OpenApiServer,
  OpenApiServerVariable,
  OpenApiSkipped,
  OpenApiTag,
  OpenApiVersion,
  OpenApiXml,
  ParameterLocation,
} from './rest/openapi/model.js';
// Postman: importing Postman Collection v2.0 and v2.1 exports into REST APIs.
export {
  apiFromPostmanCollection,
  importPostmanCollection,
  isPostmanCollection,
  normalizePostmanPath,
  parsePostmanCollection,
  parsePostmanCollectionText,
  translatePostmanVariables,
} from './rest/postman/index.js';
export type {
  ImportPostmanOptions,
  MapPostmanOptions,
  MappedPostmanApi,
  PostmanAuth,
  PostmanAuthAttribute,
  PostmanBody,
  PostmanCollection,
  PostmanFormDataParam,
  PostmanHeader,
  PostmanImportSummary,
  PostmanInfo,
  PostmanItem,
  PostmanQueryParam,
  PostmanRequest,
  PostmanSource,
  PostmanUrl,
  PostmanUrlEncodedParam,
  PostmanVariable,
} from './rest/postman/index.js';

// Legacy SOAP projects: reading the single-XML project files of older SOAP workbenches.
export {
  definitionRootOf,
  fetchDocumentFromCache,
  formatLegacyImportReport,
  IMPORTED_SCRIPTS_DIR,
  looksLikeLegacyProject,
  mapLegacyProject,
  MAX_LEGACY_PROJECT_BYTES,
  parseLegacyProject,
  readLegacySoapProject,
  resolvedOperationsOf,
} from './soap/legacy-project/index.js';
export type {
  CacheFetchOptions,
  LegacyImportReport,
  LegacyImportReportItem,
  LegacyMapContext,
  LegacyScriptFile,
  MappedLegacyProject,
  ResolvedLegacyInterface,
  ResolvedOperation,
  LegacyCall,
  LegacyCredentials,
  LegacyDefinitionCache,
  LegacyDefinitionPart,
  LegacyEnvironment,
  LegacyInterface,
  LegacyOperation,
  LegacyProject,
  LegacyProjectSource,
  LegacyProperty,
  LegacyScript,
  LegacyUnmapped,
} from './soap/legacy-project/index.js';
export type { ComposedUrl, ComposeUrlOptions, UrlProblem } from './rest/url.js';
export type {
  CreateApiInput,
  CreateFolderInput,
  CreateRestRequestInput,
  KeyValueEntry,
  MultipartFormPart,
  RawLanguage,
  RestApi,
  RestBody,
  RestDefinitionRef,
  RestFolder,
  RestMethod,
  RestRequestDef,
  RestContractLink,
  RestRequestSettings,
  RestServer,
} from './rest/model.js';
export {
  API_FILE,
  APIS_DIR,
  ATTACHMENTS_DIR,
  ENVIRONMENTS_DIR,
  FOLDER_FILE,
  INTERFACES_DIR,
  MAX_FOLDER_DEPTH,
  OPERATIONS_DIR,
  REQUEST_SUFFIX,
  REQUESTS_DIR,
  WSS_DIR,
  apiDefinitionDir,
  apiDir,
  apiFile,
  definitionCacheDir,
  definitionDir,
  environmentFile,
  interfaceDir,
  interfaceFile,
  keystoresFile,
  manifestFile,
  operationDir,
  requestFiles,
  restBodyFileName,
  restFolderDir,
  restFolderFile,
  restRequestFile,
  slugify,
  uniqueSlug,
  wssFile,
} from './project/paths.js';
export type { RequestFilePair } from './project/paths.js';
export {
  apiFileSchema,
  assertSupportedKind,
  attachmentSourceSchema,
  authConfigSchema,
  definitionCacheManifestSchema,
  environmentFileSchema,
  keyValueEntrySchema,
  interfaceFileSchema,
  soapOwnerAuthSchema,
  keystoreEntrySchema,
  keystoresFileSchema,
  manifestSchema,
  parseFile,
  requestFileSchema,
  restBodySchema,
  apiDefinitionCacheManifestSchema,
  restFolderFileSchema,
  restRequestFileSchema,
  grpcApiFileSchema,
  grpcRequestFileSchema,
  grpcMethodKindSchema,
  protoDefinitionCacheManifestSchema,
  apiKindOf,
  wssIncomingFileSchema,
  wssEntrySchema,
  wssOutgoingFileSchema,
} from './project/schema.js';
export type {
  ApiDefinitionCacheDocument,
  ApiDefinitionCacheManifest,
  ApiFile,
  DefinitionCacheDocument,
  DefinitionCacheManifest,
  EnvironmentFile,
  InterfaceFile,
  KeyValueEntryFile,
  ManifestFile,
  RequestFile,
  RestFolderFile,
  RestRequestFile,
  GrpcApiFile,
  GrpcRequestFile,
  ProtoDefinitionCacheManifest,
} from './project/schema.js';
export {
  DEFAULT_PREFERENCES,
  LOG_SIZE_MAX,
  LOG_SIZE_MIN,
  mergePreferences,
  preferencesSchema,
  resetPreferences,
} from './project/preferences.js';
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
  UpdatePreferences,
  WsdlPreferences,
  RestPreferences,
  WsiPreferences,
} from './project/preferences.js';
export { toGrpcSendInput, toRestSendInput, toSendInput } from './send-options.js';
export type {
  AttachmentResolvers,
  GrpcSendRequestInput,
  RestSendRequestInput,
  SendRequestInput,
  ToGrpcSendInputArgs,
  ToRestSendInputArgs,
  ToSendInputArgs,
} from './send-options.js';
export { entitizeValue, prettyPrint, removeEmptyContent, stripWhitespaces } from './soap/transforms.js';
export { jsonCompletionContextAt } from './json/cursor.js';
export type { JsonCompletionContext, JsonTextRange } from './json/cursor.js';
export { formatXml } from './xml/pretty.js';
export type { FormatXmlOptions, FormatXmlResult } from './xml/pretty.js';
export { migrate } from './project/migrate.js';
export { KEYSTORES_PATH, MANIFEST_PATH, authDocument, projectFiles } from './project/serialize.js';
export type { ProjectFiles } from './project/serialize.js';
export { requestFileLocation } from './project/request-location.js';
export type { RequestFileLocation } from './project/request-location.js';
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
export { nodeFs, writeFileAtomic } from './project/fs.js';
export type { DirEntry, FileStat, FsLike } from './project/fs.js';
export {
  appendHistory,
  generateHistoryId,
  historyContractOf,
  historySseOf,
  historyWsOf,
  normalizeHistoryEntry,
  openHistory,
} from './project/history.js';
export type {
  HistoryEntry,
  HistoryError,
  HistoryFault,
  HistoryFile,
  HistoryGrpc,
  HistoryHeader,
  HistoryListQuery,
  HistoryOptions,
  HistorySse,
  HistoryWs,
  RestEventStreamLike,
} from './project/history.js';
export { enabledProperties, expand, expandSendInput, hasExpansions } from './project/properties.js';
export type { ExpandOptions, ExpandResult, PropertyScopes, UnresolvedRef } from './project/properties.js';
export { effectiveAuth, isEndpointAuth } from './project/endpoints.js';
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
  resolveApiBaseUrl,
  resolveAuthEndpoint,
  resolveEndpoint,
  resolveScopes,
  upsertEnvironment,
} from './project/environments.js';
export type { BaseUrlSource, EndpointSource } from './project/environments.js';
// Workspace
export {
  WORKSPACE_FORMAT_VERSION,
  assertPathSegment,
  WORKSPACES_DIR,
  WORKSPACE_ENVIRONMENTS_DIR,
  WORKSPACE_MANIFEST,
  WORKSPACE_PROJECTS_DIR,
  WORKSPACE_STATE_FILE,
  WORKSPACE_TREE_DIR,
  WORKSPACE_JOINING_DIR,
  GIT_ATTRIBUTES_FILE,
  GIT_ATTRIBUTES,
  WORKSPACE_LOCAL_FILE,
  EMPTY_LOCAL_STATE,
  WORKSPACE_SHARE_FILE,
  DEFAULT_GIT_SHARE_SETTINGS,
  commitMessage,
  createWorkspace,
  createWorkspaceEnvironment,
  deleteShare,
  describeTreePath,
  linkedEnvironment,
  loadLocalState,
  loadShare,
  loadWorkspace,
  migrateWorkspace,
  parseWorkspaceFile,
  reidentifyProject,
  resolveWorkspaceApiBaseUrl,
  resolveWorkspaceEndpoint,
  resolveWorkspaceScopes,
  saveLocalState,
  saveShare,
  saveWorkspace,
  workspaceDir,
  workspaceEnvironmentFile,
  workspaceEnvironmentFileSchema,
  workspaceFiles,
  workspaceLocalStateSchema,
  workspaceManifestFile,
  workspaceManifestSchema,
  workspaceProjectDir,
  workspaceProjectRefSchema,
  workspaceShareSchema,
  workspaceTreeDir,
} from './workspace/index.js';
export type {
  GitShareSettings,
  LoadWorkspaceOptions,
  LoadWorkspaceResult,
  LocalStateOptions,
  MigratedWorkspaceManifest,
  SaveWorkspaceOptions,
  ShareKind,
  ShareOptions,
  TreeChange,
  TreeEntity,
  TreeEntityKind,
  Workspace,
  WorkspaceEnvironment,
  WorkspaceEnvironmentFile,
  WorkspaceFiles,
  WorkspaceLocalState,
  WorkspaceManifestFile,
  WorkspaceProblem,
  WorkspaceProjectRef,
  WorkspaceProjectRefFile,
  WorkspaceShare,
} from './workspace/index.js';
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

export { detectImportFormat } from './import-detect.js';
export type { ImportFormatKind, DetectedImportFormat, ImportDetectInput } from './import-detect.js';

// gRPC: the third protocol, a sibling container to a SOAP interface and a REST API (ADR-0007).
export {
  clientStreams,
  GRPC_REFLECTION_VERSIONS,
  createGrpcApi,
  createGrpcFolder,
  createGrpcRequest,
  defaultTlsFor,
  grpcApiFolders,
  grpcApiRequests,
  grpcFolderRequests,
  grpcMethodPath,
  serverStreams,
} from './grpc/model.js';
export type {
  CreateGrpcApiInput,
  CreateGrpcFolderInput,
  CreateGrpcRequestInput,
  GrpcApi,
  GrpcDefinitionRef,
  GrpcFolder,
  GrpcMethodKind,
  GrpcReflectionVersion,
  GrpcRequestDef,
  GrpcRequestSettings,
} from './grpc/model.js';
export {
  GRPC_STATUS_NAMES,
  decodeGrpcMessage,
  encodeGrpcMessage,
  formatGrpcTimeout,
  grpcStatusName,
} from './grpc/status.js';
export { encodeGrpcFrame, GrpcFrameParser } from './grpc/framing.js';
export type { GrpcFrame } from './grpc/framing.js';
export { loadProtoSet } from './grpc/proto/load.js';
export type { LoadProtoOptions, ProtoSet, ProtoSources } from './grpc/proto/load.js';
export {
  describeMessage,
  describeMessageAt,
  describeMethod,
  describeServices,
  lookupMessageType,
  lookupMethod,
  qualifiedName,
} from './grpc/proto/describe.js';
export type {
  FieldValueKind,
  GrpcMethodDescriptor,
  GrpcServiceDescriptor,
  MessageDescriptor,
  MessageFieldDescriptor,
} from './grpc/proto/describe.js';
export { sampleMessage, sampleMessageText } from './grpc/proto/sample.js';
export type { SampleMessageOptions } from './grpc/proto/sample.js';
export { WELL_KNOWN_TYPES, isWrapperType } from './grpc/proto/well-known.js';
export { decodeMessage, encodeMessage, parseMessageText } from './grpc/codec.js';
export { buildGrpcHeaders, parseGrpcTarget, sendGrpc } from './grpc/send.js';
export type { GrpcExchange, GrpcSendInput, GrpcStatusSource, GrpcStreamHandle, GrpcTarget } from './grpc/send.js';
export { callGrpc, decodeResponseMessage } from './grpc/call.js';
export type { GrpcCallInput, GrpcCallResult, GrpcCallStreamHandle, GrpcResponseMessage } from './grpc/call.js';
export { expandGrpcInput } from './grpc/expand.js';
export type { ExpandGrpcOptions, GrpcExpandable } from './grpc/expand.js';
export { apiFromProtoSet, importProto } from './grpc/import.js';
export { reconcileGrpcApi } from './grpc/reconcile.js';
export type { GrpcReconcileResult, ReconcileGrpcApiOptions } from './grpc/reconcile.js';
export type { ImportProtoOptions, ImportedProto, ProtoImportSummary } from './grpc/import.js';
export {
  DESCRIPTORS_FILE,
  PROTOS_DIR,
  protoPathSegments,
  readDescriptorDefinitionCache,
  readGrpcDefinitionCache,
  readProtoDefinitionCache,
  writeDescriptorDefinitionCache,
  writeProtoDefinitionCache,
} from './grpc/cache.js';
export type {
  CachedDescriptorDefinition,
  CachedGrpcDefinition,
  CachedProtoDefinition,
  ProtoDefinitionCacheOptions,
  WriteDescriptorDefinitionCacheOptions,
  WriteProtoDefinitionCacheOptions,
} from './grpc/cache.js';
export {
  DESCRIPTOR_HEADER_TYPE,
  DESCRIPTOR_SET_HEADER_TYPE,
  REFLECTION_METHOD,
  REFLECTION_VERSIONS,
  descriptorHeaderProtoSet,
  reflectionPackage,
  reflectionProtoSet,
  reflectionProtoSource,
  reflectionServiceName,
} from './grpc/reflection/proto.js';
export {
  descriptorHeader,
  descriptorSetBytes,
  descriptorSetHeaders,
  encodeFileDescriptorSet,
  orderDescriptors,
  protoSetFromDescriptorSet,
  protoSetFromDescriptors,
} from './grpc/reflection/descriptors.js';
export type {
  DescriptorHeader,
  ProtoSetFromDescriptorSetOptions,
  ProtoSetFromDescriptorsInput,
} from './grpc/reflection/descriptors.js';
export { isReflectionService, reflectProtoSet, reflectServices } from './grpc/reflection/client.js';
export type { GrpcReflectInput, GrpcReflectedProtoSet, GrpcReflectionResult } from './grpc/reflection/client.js';
export { GRPC_COMMAND_REDACTED, grpcToCommand } from './grpc/command.js';
export type { GrpcToCommandOptions } from './grpc/command.js';

export {
  resolveAuthConfig,
  resolveEndpointAuth,
  resolveSoapAuth,
  secretMissingMessage,
  toSendAuth,
} from './secrets/resolve.js';
export type { GetSecret, ResolvedAuth } from './secrets/resolve.js';
export { envVariablesFor, secretNeedsOfAuth, SECRET_ENV_PREFIX } from './secrets/env-names.js';
export type { SecretNeed } from './secrets/env-names.js';

export {
  REDACTED_MARKER,
  SECRET_BODY_KEYS,
  containsRedaction,
  redactHeaderPairs,
  redactHeaders,
  redactRawHttp,
  redactResponseAttachments,
  redactStructuredBody,
  redactUrl,
  redactXml,
} from './redact/index.js';
export { createSecretMasker } from './redact/literal.js';

// WebSocket: the fourth protocol, a sibling container to a SOAP interface, a REST API and a gRPC
// API (ADR-0007).
export {
  createWsApi,
  createWsFolder,
  createWsRequest,
  createWsSavedMessage,
  wsApiFolders,
  wsApiRequests,
  wsFolderRequests,
  wsMessageFileName,
} from './ws/model.js';
export type {
  CreateWsApiInput,
  CreateWsFolderInput,
  CreateWsRequestInput,
  WsApi,
  WsContractLink,
  WsDefinitionRef,
  WsMessageContractLink,
  WsExchange,
  WsFolder,
  WsFrame,
  WsFrameContract,
  WsFrameContractStatus,
  WsHandshake,
  WsOpcode,
  WsRequestDef,
  WsRequestSettings,
  WsSavedMessage,
} from './ws/model.js';
export { resolveWsUrl } from './ws/url.js';
export { prettyFrameText } from './ws/pretty.js';
export type { PrettyFrameResult } from './ws/pretty.js';
export { openWsSession } from './ws/session.js';
export type { WsSessionHandle, WsSessionHooks, WsSessionOptions } from './ws/session.js';
export { capFrames, WS_HISTORY_HEAD, WS_HISTORY_MAX_BYTES, WS_HISTORY_TAIL } from './ws/transcript.js';
export type { WsTranscript } from './ws/transcript.js';
export { expandWsInput, expandWsMessage } from './ws/expand.js';
export type { WsCallInput } from './ws/expand.js';
export { toWsSessionOptions } from './ws/call.js';
export type { WsSessionMaterial } from './ws/call.js';
export { wsToCommand } from './ws/command.js';
