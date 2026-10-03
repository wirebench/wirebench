export { evaluateAssertions } from './assert/index.js';
export { checkRequestAssertions } from './assert/check.js';
export type {
  Assertion,
  AssertionLanguage,
  AssertionResult,
  AssertionSubject,
  CallbackAssertion,
  CallbackBodyCheck,
  CallbackCheck,
  CallbackHeaderCheck,
  CallbackMatch,
  HeaderAssertion,
  MatchAssertion,
  SchemaAssertion,
  SlaAssertion,
  SoapFaultAssertion,
  StatusAssertion,
  StatusNames,
  StepAssertion,
} from './assert/model.js';
export { CALLBACK_LIMITS, callbackLabel } from './assert/model.js';
export {
  assertionsSchema,
  callbackAssertionSchema,
  stepAssertionsSchema,
  toCallbackAssertion,
} from './assert/schema.js';
export {
  FIRST_CAPTURE_CURSOR,
  captureDetailView,
  captureSourceOver,
  captureSummaryView,
  unavailableCaptureSource,
} from './assert/capture-source.js';
export type {
  CaptureDetailView,
  CaptureServerReads,
  CaptureSource,
  CaptureSummaryView,
} from './assert/capture-source.js';
export {
  NO_CAPTURE_SOURCE_MESSAGE,
  awaitCallbacks,
  expandCallback,
  isCallbackAssertion,
  prepareCallbacks,
  realCallbackClock,
  seconds,
  sendAwaitingCallbacks,
  waitingOf,
} from './assert/callback.js';
export type {
  AwaitCallbacksOptions,
  CallbackClock,
  CallbackWiring,
  CallbackWaiting,
  PendingCallback,
} from './assert/callback.js';

export * from './run/index.js';

// Protocol modules, the registry and features (ADR-0017). Exported for the engine's own hosts and
// tagged `@internal` where they are declared: they are not yet a plugin API.
export { createFeatureSet } from './protocol/features.js';
export type { FeatureDescriptor, FeatureSet, WhyDisabled } from './protocol/features.js';
export { defineProtocol } from './protocol/module.js';
export type {
  ContainerBase,
  ContainerDir,
  LoadContext,
  ProtocolModule,
  ProtocolRun,
  ProtocolScripting,
  ProtocolStorage,
  RequestSnapshotBase,
  ResponseSnapshotBase,
  RunGroup,
  RunScope,
  ScriptedSend,
  SelectedBase,
  SnapshotFacts,
} from './protocol/module.js';
export { createProtocolRegistry } from './protocol/registry.js';
export type { ProtocolRegistry, ProtocolRegistryOptions } from './protocol/registry.js';
export { BUILTIN_PROTOCOLS, createBuiltinRegistry } from './protocols.js';
export { extraContainersOf, unsupportedOf } from './project/model.js';
export type { UnsupportedContainer } from './project/model.js';

// What three core files re-exported until 3.0, from the module that declares it.
export { soapResponseSubject } from './soap/run.js';
// The SOAP run facet's item and its effective credentials, for a host that sends one SOAP item itself.
export { soapEffectiveAuth, soapItemFor } from './soap/run.js';
export type { SoapOverride, SoapSelected } from './soap/run.js';
export { restSubject } from './rest/run.js';
// The REST run facet and its effective credentials, for a host that sends one REST item itself.
export { restEffectiveAuth, restItemFor, restRun } from './rest/run.js';
export type { RestSelected } from './rest/run.js';
export { grpcSubject } from './grpc/run.js';
// The gRPC run facet's item and its effective credentials, for a host that sends one gRPC item itself.
export { grpcEffectiveAuth, grpcItemFor } from './grpc/run.js';
export type { GrpcFailedInput, GrpcResolvedInput, GrpcSelected } from './grpc/run.js';
// The WebSocket run facet's item and its effective credentials, for a host that opens one itself.
export { wsEffectiveAuth, wsItemFor, wsSubject } from './ws/run.js';
export type { WsSelected } from './ws/run.js';
// One WebSocket session as History records it, for every host that writes History.
export { buildWsHistoryEntry, redactWsExchange } from './ws/history-entry.js';
export type { WsHistoryInput, WsHistoryMasks } from './ws/history-entry.js';
export type { RequestSnapshot, ResponseSnapshot } from './protocols.js';
export { applySoapSnapshot, soapRequestSnapshot, soapResponseSnapshot } from './soap/scripting.js';
export type { SoapRequestSnapshot, SoapResponseSnapshot } from './soap/scripting.js';
export {
  projectSoapBody,
  qnameFromClark,
  replaceSoapBody,
  soapOperationElements,
  soapScriptTypes,
} from './soap/script-types.js';
export { applyRestSnapshot, restRequestSnapshot, restResponseSnapshot } from './rest/scripting.js';
export type { RestRequestSnapshot, RestResponseSnapshot } from './rest/scripting.js';
export { restOperationFor, restScriptTypes } from './rest/script-types.js';
export { applyGrpcSnapshot, grpcRequestSnapshot, grpcResponseSnapshot } from './grpc/scripting.js';
export type { GrpcRequestSnapshot, GrpcResponseSnapshot } from './grpc/scripting.js';
export { grpcMessageTypes, grpcScriptTypes } from './grpc/script-types.js';
export { interfaceFileSchema, requestFileSchema } from './soap/files.js';
export type { InterfaceFile, RequestFile } from './soap/files.js';
export { apiFileSchema, restBodySchema, restRequestFileSchema } from './rest/files.js';
export type { ApiFile, RestRequestFile } from './rest/files.js';
export { grpcApiFileSchema, grpcMethodKindSchema, grpcRequestFileSchema } from './grpc/files.js';
export type { GrpcApiFile, GrpcRequestFile } from './grpc/files.js';

export {
  WirebenchError,
  WsdlParseError,
  SchemaError,
  HttpError,
  WsaError,
  WssError,
  ProjectError,
  ValidationError,
  SequenceError,
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
export { evaluateWithTimeout, matchRegexWithTimeout } from './xpath/evaluate-async.js';
export type { EvaluateWithTimeoutOptions, RegexMatchResult } from './xpath/evaluate-async.js';
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
export { createDefaultFetchDocument } from './http/fetch-document.js';
export { createHttpFetchDocument } from './http/document-fetch.js';
export type { DocumentFetchOptions } from './http/document-fetch.js';
export { assignFileNames } from './project/cache-naming.js';
export type { NamedDocument } from './project/cache-naming.js';
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
export { createJsonSchemaWriter, jsonSchemaOf, MAX_PROPERTY_DESCRIPTION } from './xsd/json-bridge.js';
export type { BridgeTarget, JsonSchemaObject, JsonSchemaOfResult, JsonSchemaWriter } from './xsd/json-bridge.js';

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
export { prefixForNamespace, RESERVED_PREFIXES } from './xml/prefixes.js';
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
export { toCurl } from './http/curl.js';
export type { CurlBody, CurlCommand, CurlHeader, CurlPart, ToCurlOptions } from './http/curl.js';
export { fromCurl, soapToCurl } from './soap/curl.js';
export type { FromCurlResult } from './soap/curl.js';
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

export { importWsdl } from './soap/import.js';
export { sendSoapRequest } from './soap/send.js';
export { generateEmptySoapRequest, generateSoapRequest } from './soap/generate.js';
export { summarizeSoapOperations } from './soap/operations.js';
export type {
  SoapAttachmentOptions,
  SoapExchange,
  SoapOperationSummary,
  SoapSendInput,
  SoapSendWsa,
  SoapSendWss,
  WsdlImportCacheOptions,
  WsdlImportOptions,
  WsdlImportProblem,
  WsdlImportProgress,
  WsdlImportResult,
  WsdlImportSource,
} from './soap/types.js';
export type { AuthSummary, SendAuth } from './http/auth/send-auth.js';

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
  takenContainerSlugs,
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
  DefinitionAuth,
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
export {
  DEFAULT_WEBHOOK_TARGET,
  WEBHOOKS_COLLECTION_PREFIX,
  WEBHOOK_TARGET_PROPERTY,
  assertWebhookTarget,
  createWebhookCollection,
  createWebhookFolder,
  effectiveSigning,
  effectiveTarget,
  findWebhookRequest,
  hookKey,
  signingAlong,
  signingSecretMissing,
  signingSecretRef,
  signingSourceLabel,
  webhookFolders,
  webhookPath,
  webhookRequests,
} from './webhooks/model.js';
export type {
  CreateWebhookCollectionInput,
  CreateWebhookFolderInput,
  EffectiveSigning,
  HookLink,
  WebhookCollection,
  WebhookFolder,
  WebhookSigning,
} from './webhooks/model.js';
export {
  DEFAULT_SIGNATURE_TOLERANCE_SEC,
  SIGNATURE_FAILURES,
  isCanonicalBase64,
  signWebhook,
  signatureHeaderNames,
  signatureSchemeSchema,
  toSignatureScheme,
  verifyWebhook,
} from './http/webhook-signature.js';
export type {
  SignatureAlgorithm,
  SignatureFailure,
  SignatureScheme,
  SignatureVerdict,
} from './http/webhook-signature.js';
export { bodyLanguage, encodeFormFields, encodeRestBody, escapeForLanguage, rawContentType } from './rest/body.js';
export type { EncodeBodyOptions, EncodedBody, FileResolver } from './rest/body.js';
export { applyAuth, missingSecretRef, resolveAuthChain, resolveAuthChainIndex } from './http/auth/apply-auth.js';
export type { AppliedAuth } from './http/auth/apply-auth.js';
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
} from './http/auth/oauth2.js';
export type {
  AuthorizationUrlInput,
  OAuth2Secrets,
  PkcePair,
  TokenGrantInput,
  TokenRequestOptions,
  TokenResponseInput,
  TokenSet,
} from './http/auth/oauth2.js';
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
export { loadOpenApiDocument } from './rest/script-types.js';
export {
  apiFromDocument,
  authFromScheme,
  mapScheme,
  webhookItemsOf,
  webhookSourcesOf,
  webhooksFromDocument,
} from './rest/openapi/map.js';
export type {
  MapApiOptions,
  MappedApi,
  MapWebhooksOptions,
  OpenApiImportSummary,
  OpenApiSchemeCandidate,
  WebhookItemRef,
} from './rest/openapi/map.js';
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
export {
  applyRestUpdate,
  applyWebhookUpdate,
  planRestUpdate,
  planWebhookUpdate,
  sameStructure,
} from './rest/openapi/update.js';
export type {
  ApplyRestUpdateOptions,
  RestApiChangeReason,
  RestApplyResult,
  RestChangeReason,
  RestOpRef,
  RestUpdatePlan,
  WebhookApplyResult,
  WebhookUpdatePlan,
} from './rest/openapi/update.js';
export { matchOperation } from './rest/openapi/match.js';
export type { RestOperationRef } from './rest/openapi/match.js';
export {
  evaluateRuntimeTemplate,
  parseRuntimeExpression,
  parseRuntimeTemplate,
  resolveJsonPointer,
} from './rest/openapi/runtime-expression.js';
export type {
  RuntimeExchange,
  RuntimeExpression,
  RuntimeSource,
  TemplatePart,
} from './rest/openapi/runtime-expression.js';
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
export { resolvePointer, resolveRefs, unescapePointerToken, MAX_REF_DEPTH } from './json/schema/refs.js';
export type { RefProblem, ResolvedDocument, ResolvedRefs, ResolveRefsOptions } from './json/schema/refs.js';
export { sampleFromSchema, sampleXml, MAX_SAMPLE_DEPTH } from './json/schema/sample.js';
export type { SampleOptions, SampleXmlOptions } from './json/schema/sample.js';
export { applyJsonFormEdit, buildJsonForm, toWireSchema } from './rest/json-form.js';
export type { JsonFormEdit, JsonFormKind, JsonFormNode, JsonFormOptions, JsonFormValueType } from './rest/json-form.js';
export { serverUrl, HTTP_METHODS } from './rest/openapi/model.js';
export type {
  JsonSchema,
  JsonValue,
  OpenApiCallback,
  OpenApiDocument,
  OpenApiExample,
  OpenApiHook,
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
  WEBHOOKS_DIR,
  WEBHOOKS_FILE,
  wssFile,
} from './project/paths.js';
export type { RequestFilePair } from './project/paths.js';
export {
  attachmentSourceSchema,
  authConfigSchema,
  definitionAuthSchema,
  definitionCacheManifestSchema,
  environmentFileSchema,
  keyValueEntrySchema,
  soapOwnerAuthSchema,
  keystoreEntrySchema,
  keystoresFileSchema,
  manifestSchema,
  parseFile,
  apiDefinitionCacheManifestSchema,
  restFolderFileSchema,
  protoDefinitionCacheManifestSchema,
  hookLinkSchema,
  webhookFolderFileSchema,
  webhooksFileSchema,
  wssIncomingFileSchema,
  wssEntrySchema,
  wssOutgoingFileSchema,
} from './project/schema.js';
export type {
  ApiDefinitionCacheDocument,
  ApiDefinitionCacheManifest,
  DefinitionCacheDocument,
  DefinitionCacheManifest,
  EnvironmentFile,
  KeyValueEntryFile,
  ManifestFile,
  RestFolderFile,
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
export { toSoapSendInput } from './soap/send-input.js';
export { toRestSendInput } from './rest/send-input.js';
export { toGrpcSendInput } from './grpc/send-input.js';
export type { AttachmentResolvers, SoapSendRequestInput, ToSoapSendInputArgs } from './soap/send-input.js';
export type { RestSendRequestInput, ToRestSendInputArgs } from './rest/send-input.js';
export type { GrpcSendRequestInput, ToGrpcSendInputArgs } from './grpc/send-input.js';
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
  AppendHistoryOptions,
  HistoryEntry,
  HistoryError,
  HistoryFault,
  HistoryFile,
  HistoryGrpc,
  HistoryHeader,
  HistoryListQuery,
  HistoryLockOptions,
  HistoryOptions,
  HistorySse,
  HistoryWs,
  RestEventStreamLike,
} from './project/history.js';
export { enabledProperties, expand, hasExpansions, secretNamesIn } from './project/properties.js';
export { expandSendInput } from './soap/expand.js';
export type { ExpandOptions, ExpandResult, PropertyScopes, UnresolvedRef } from './project/properties.js';
export { effectiveAuth, isEndpointAuth } from './project/endpoints.js';
export { toKeystoreDef, toKeystoreRef } from './project/keystores.js';
export { toWssIncomingConfig, toWssIncomingRef, toWssOutgoingConfig, toWssOutgoingRef } from './wss/configs.js';
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
} from './keystore/index.js';
export type {
  Keystore,
  KeystoreAlias,
  KeystoreDef,
  KeystoreType,
  LoadKeystoreOptions,
  TlsClientIdentity,
} from './keystore/index.js';
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
  TEAM_SECRETS_DIR,
  WORKSPACE_LOCAL_FILE,
  EMPTY_LOCAL_STATE,
  WORKSPACE_SHARE_FILE,
  DEFAULT_GIT_SHARE_SETTINGS,
  DEFAULT_SYNC_SETTINGS,
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
  shareSyncSettings,
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
  ServerShareSettings,
  ShareKind,
  ShareOptions,
  SyncSettings,
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
  grpcStatusNames,
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
  resolveSecretTokens,
  resolveSoapAuth,
  secretMissingMessage,
  secretTokenMissingMessage,
  toSendAuth,
} from './secrets/resolve.js';
export type { GetSecret, ResolvedAuth } from './secrets/resolve.js';
export {
  envVariablesFor,
  secretNeedsOfAuth,
  SECRET_ENV_PREFIX,
  SIGNING_PSEUDO_REF_PREFIX,
} from './secrets/env-names.js';
export type { SecretNeed } from './secrets/env-names.js';
export {
  SECRET_NAME_PATTERN,
  secretEnvName,
  secretPseudoRef,
  secretToken,
  parseSecretPseudoRef,
} from './secrets/secret-token.js';
export { detectInText, SECRET_TEXT_SCAN_LIMIT } from './secrets/scan/rules.js';
export type { DetectContext, SecretMatch, SecretRule } from './secrets/scan/rules.js';
export { maskedPreview, scanProjectForSecrets } from './secrets/scan/scan.js';
export { applySecretMoves, proposeSecretName } from './secrets/scan/apply.js';
export type { SecretMove, SecretMovesResult } from './secrets/scan/apply.js';
export type { SecretFinding, SecretLocation } from './secrets/scan/walk.js';

export { SECRET_REF_PATTERN, secretRefsInValue } from './secrets/secret-refs.js';

// ---------------------------------------------------------------------------
// Team secrets: machine keys, the access log and the vault (team-secrets spec §4, §5.2)
// ---------------------------------------------------------------------------
export {
  ACCESS_ACTIONS,
  accessEntryFileSchema,
  accessEntryPath,
  approvedRecipients,
  base32,
  base64url,
  buildVaultEntry,
  canonicalJson,
  decryptValue,
  encryptValue,
  encryptionPrivateKey,
  encryptionPublicKey,
  fingerprintOf,
  fromBase64url,
  generateMachineKeys,
  healVaultEntry,
  isTeamSecretsPath,
  isVaultEntryPath,
  KEY_ID_PATTERN,
  keyIdOf,
  keyIdSchema,
  keyRequestFileSchema,
  keyRequestPath,
  newDataKey,
  nextAccessEntryId,
  openVaultEntry,
  parseMachineKeys,
  parseTeamSecretsFile,
  readTeamSecretsFiles,
  replayAccessLog,
  rotateMarks,
  rotateMarksFor,
  sameSecret,
  sealVaultEntry,
  secretKeySchema,
  serializeMachineKeys,
  signDocument,
  signingPrivateKey,
  signingPublicKey,
  TEAM_SECRETS_ACCESS_DIR,
  TEAM_SECRETS_FORMAT_VERSION,
  TEAM_SECRETS_KEYS_DIR,
  TEAM_SECRETS_MESSAGES,
  TEAM_SECRETS_VALUES_DIR,
  teamSecretsError,
  teamSecretsFileText,
  ULID_PATTERN,
  unwrapDataKey,
  vaultConflictWinner,
  vaultEntryFileSchema,
  vaultEntryId,
  vaultEntryIdOfPath,
  vaultEntryPath,
  verifiedKeys,
  verifyDocument,
  verifyVaultEntry,
  withoutSignature,
  WRAP_INFO,
  wrapDataKey,
  wrapsUnapprovedKey,
} from './team-secrets/index.js';
export type {
  AccessAction,
  AccessEntryFile,
  AccessState,
  KeyInfo,
  KeyRequestFile,
  LogProblem,
  MachineKeys,
  MachinePublicKeys,
  Removal,
  RotateMark,
  SecretKey,
  Signed,
  TeamSecretsErrorCode,
  TeamSecretsFiles,
  VaultEntryFile,
  VaultVerdict,
} from './team-secrets/index.js';

export {
  REDACTED_MARKER,
  SECRET_BODY_KEYS,
  containsRedaction,
  isSensitiveHeaderName,
  isSensitiveQueryParam,
  redactHeaderPairs,
  redactHeaders,
  redactRawHttp,
  redactResponseAttachments,
  redactStructuredBody,
  redactUrl,
  redactXml,
} from './redact/index.js';
export { createSecretBytesMasker, createSecretMasker } from './redact/literal.js';

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
export { connectWebSocket } from './ws/connect.js';
export type { ConnectedWebSocket, ConnectOptions } from './ws/connect.js';
export { capFrames, WS_HISTORY_HEAD, WS_HISTORY_MAX_BYTES, WS_HISTORY_TAIL } from './ws/transcript.js';
export type { WsTranscript } from './ws/transcript.js';
export { expandWsInput, expandWsMessage } from './ws/expand.js';
export type { WsCallInput } from './ws/expand.js';
export { toWsSessionOptions } from './ws/call.js';
export type { WsSessionMaterial } from './ws/call.js';
export { wsToCommand } from './ws/command.js';

export {
  GIT_CALL_ENV,
  GIT_PLUMBING_SUBCOMMANDS,
  GIT_SUBCOMMANDS,
  GitCli,
  assertBranchName,
  assertRemoteUrl,
  assertSafeLocalConfig,
  findGit,
  parseGitVersion,
  refusedLocalConfigKeys,
} from './sync/git-cli.js';
export type {
  GitCallEnv,
  GitLocation,
  GitPlumbingSubcommand,
  GitRunOptions,
  GitSubcommand,
  Runner,
} from './sync/git-cli.js';

export { mergeFiles } from './sync/three-way-merge.js';
export type { FileMerge, MergeFilesOptions } from './sync/three-way-merge.js';

export {
  MACHINE_LOCAL_PATHS,
  MAX_TREE_PATH_LENGTH,
  TREE_ITEMS,
  assertTreePath,
  isSafeTreeSegment,
  isTreePath,
} from './sync/tree-paths.js';

// ---------------------------------------------------------------------------
// Wirebench Server API: wire schemas shared by packages/server and the desktop client
// ---------------------------------------------------------------------------
export { SERVER_API_VERSION, SERVER_NAME, metaResponseSchema } from './server-api/meta.js';
export type { MetaResponse } from './server-api/meta.js';
export {
  DEVICE_TOKEN_PATTERN,
  MAX_DEVICE_NAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PKCE_VERIFIER_PATTERN,
  SECRET_PATTERN,
  deviceSchema,
  devicesResponseSchema,
  deviceSummarySchema,
  emailSchema,
  identityIdParamsSchema,
  identityIdSchema,
  invitationAcceptRequestSchema,
  invitationCreatedSchema,
  invitationCreateRequestSchema,
  invitationLookupQuerySchema,
  invitationLookupResponseSchema,
  invitationsResponseSchema,
  invitationSummarySchema,
  localSignInRequestSchema,
  meResponseSchema,
  oidcCallbackQuerySchema,
  oidcCompleteRequestSchema,
  oidcStartRequestSchema,
  oidcStartResponseSchema,
  passwordChangeRequestSchema,
  passwordResetCreatedSchema,
  passwordSchema,
  serverUserSchema,
  signInMethodsSchema,
  signInResponseSchema,
  userPatchRequestSchema,
  usersResponseSchema,
  userSummarySchema,
} from './server-api/identity.js';
export type {
  DeviceSummary,
  InvitationAcceptRequest,
  InvitationCreated,
  InvitationCreateRequest,
  InvitationLookupResponse,
  InvitationSummary,
  LocalSignInRequest,
  MeResponse,
  OidcCallbackQuery,
  OidcCompleteRequest,
  OidcStartRequest,
  OidcStartResponse,
  PasswordChangeRequest,
  PasswordResetCreated,
  ServerUser,
  SignInResponse,
  UserPatchRequest,
  UserSummary,
} from './server-api/identity.js';
export {
  MAX_TEAMS_NAME_LENGTH,
  TEAMS_ID_PATTERN,
  accessEntrySchema,
  accessParamsSchema,
  accessResponseSchema,
  defaultRoleSchema,
  effectiveRoleSchema,
  memberAddRequestSchema,
  memberParamsSchema,
  memberRoleRequestSchema,
  roleSourceSchema,
  setAccessRequestSchema,
  teamInvitationCreatedSchema,
  teamInvitationCreateRequestSchema,
  teamInvitationParamsSchema,
  teamInvitationSchema,
  teamInvitationsResponseSchema,
  teamMemberSchema,
  teamMembersResponseSchema,
  teamNameRequestSchema,
  teamParamsSchema,
  teamRoleSchema,
  teamSchema,
  teamsIdSchema,
  teamsNameSchema,
  teamsResponseSchema,
  teamWorkspaceCreateRequestSchema,
  teamWorkspaceParamsSchema,
  teamWorkspaceSchema,
  teamWorkspacesResponseSchema,
  teamWorkspaceUpdateRequestSchema,
  workspaceRoleSchema,
} from './server-api/teams.js';
export type {
  AccessEntry,
  DefaultRole,
  EffectiveRole,
  MemberAddRequest,
  MemberRoleRequest,
  RoleSource,
  SetAccessRequest,
  Team,
  TeamInvitation,
  TeamInvitationCreated,
  TeamInvitationCreateRequest,
  TeamMember,
  TeamNameRequest,
  TeamRole,
  TeamWorkspace,
  TeamWorkspaceCreateRequest,
  TeamWorkspaceUpdateRequest,
  WorkspaceRole,
} from './server-api/teams.js';
export {
  MAX_SYNC_FILE_BYTES,
  MAX_SYNC_LOG_LIMIT,
  MAX_SYNC_SUBJECT_LENGTH,
  SYNC_COMMIT_ID_PATTERN,
  syncChangeSchema,
  syncChangesQuerySchema,
  syncChangesResponseSchema,
  syncCommitIdSchema,
  syncEncodingSchema,
  syncFileSchema,
  syncHeadQuerySchema,
  syncHeadResponseSchema,
  syncLogEntrySchema,
  syncLogQuerySchema,
  syncLogResponseSchema,
  syncPushCommitSchema,
  syncPushRequestSchema,
  syncPushResponseSchema,
  syncSnapshotQuerySchema,
  syncSnapshotResponseSchema,
  TEAM_SECRETS_KEY_REQUEST_MAX_BYTES,
  teamSecretsKeyRequestSchema,
  teamSecretsKeyRequestResponseSchema,
} from './server-api/sync.js';
export type {
  SyncChange,
  SyncChangesQuery,
  SyncChangesResponse,
  SyncEncoding,
  SyncFile,
  SyncHeadQuery,
  SyncHeadResponse,
  SyncLogEntry,
  SyncLogQuery,
  SyncPushCommit,
  SyncPushRequest,
  SyncPushResponse,
  SyncSnapshotQuery,
  SyncSnapshotResponse,
  TeamSecretsKeyRequest,
  TeamSecretsKeyRequestResponse,
} from './server-api/sync.js';
export {
  LIVE_CAPABILITY,
  LIVE_CLOSE,
  LIVE_LIMITS,
  LIVE_PATH,
  LIVE_REFUSED_CODES,
  liveClientMessageSchema,
  livePresenceUserSchema,
  liveServerMessageSchema,
} from './server-api/live.js';
export type { LiveClientMessage, LivePresenceUser, LiveRefusedCode, LiveServerMessage } from './server-api/live.js';
export {
  CATCH_CONTENT_TYPE_PATTERN,
  CATCH_SECRET_PATTERN,
  CATCH_URL_DEFAULT_RESPONSE,
  CATCH_URL_PATH_PREFIX,
  captureParamsSchema,
  captureSchema,
  capturesQuerySchema,
  capturesResponseSchema,
  captureSignatureSchema,
  captureSummarySchema,
  catchUrlCreateRequestSchema,
  catchUrlParamsSchema,
  catchUrlResponseSchema,
  catchUrlSchema,
  catchUrlSignatureSchema,
  catchUrlsResponseSchema,
  catchUrlUpdateRequestSchema,
  HOOKS_LIMITS,
  hooksMetaSchema,
  SIGNATURE_SECRET_MAX_LENGTH,
} from './server-api/hooks.js';
export type {
  Capture,
  CaptureSignature,
  CapturesQuery,
  CaptureSummary,
  CatchUrl,
  CatchUrlCreateRequest,
  CatchUrlResponse,
  CatchUrlSignature,
  CatchUrlUpdateRequest,
  HooksMeta,
} from './server-api/hooks.js';
export {
  CI_TOKEN_NAME_MAX_LENGTH,
  ciTokenCreatedSchema,
  ciTokenParamsSchema,
  ciTokenSummarySchema,
  ciTokensResponseSchema,
  ciWhoamiResponseSchema,
} from './server-api/ci-tokens.js';
export type { CiTokenCreateRequest, CiTokenCreated, CiTokenSummary, CiWhoamiResponse } from './server-api/ci-tokens.js';
export {
  COMMUNITY_SEATS,
  EDITIONS,
  FEATURES,
  GRACE_DAYS,
  LICENSE_FORMAT,
  LICENSE_STATUSES,
  LICENSE_TEXT_MAX_LENGTH,
  LICENSE_TEXT_PATTERN,
  editionSchema,
  featureSchema,
  licenseInstallRequestSchema,
  licensePayloadSchema,
  licenseStateSchema,
} from './server-api/licensing.js';
export type {
  Edition,
  Feature,
  LicenseInstallRequest,
  LicenseInvalidReason,
  LicensePayload,
  LicenseState,
  LicenseStatus,
} from './server-api/licensing.js';
export {
  AUDIT_ACTION_GROUPS,
  AUDIT_ACTIONS,
  AUDIT_ACTOR_KINDS,
  AUDIT_LIMITS,
  AUDIT_TARGET_KINDS,
  DESKTOP_AUDIT_LIMITS,
  auditActionSchema,
  auditActorSchema,
  auditDetailsSchema,
  auditEventSchema,
  auditExportQuerySchema,
  auditPageSchema,
  auditQuerySchema,
  desktopAuditBatchSchema,
  desktopAuditEventSchema,
  desktopRequestSentDetailsSchema,
  desktopRunFinishedDetailsSchema,
} from './server-api/audit.js';
export type {
  AuditAction,
  AuditActionGroup,
  AuditActor,
  AuditActorKind,
  AuditDetails,
  AuditEvent,
  AuditExportQuery,
  AuditPage,
  AuditQuery,
  AuditTargetKind,
  DesktopAuditBatch,
  DesktopAuditEvent,
  DesktopRequestSentDetails,
  DesktopRunFinishedDetails,
} from './server-api/audit.js';
export { ACCOUNTS_FILE_VERSION, accountsFileSchema, parseAccountsFile, serverAccountSchema } from './account/schema.js';
export type { AccountsFile, ServerAccount } from './account/schema.js';
export * from './sequence/index.js';
export * from './script/index.js';
export { readSequences } from './sequence/load.js';
export type { SequenceFileProblem, SequenceFiles } from './sequence/load.js';
export {
  assertNoControlCharacters,
  assertOriginIndependent,
  expandWithSequenceEscaped,
  hasSequenceValues,
  urlOrigin,
} from './project/sequence-guards.js';
