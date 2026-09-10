export {
  WirebenchError,
  WsdlParseError,
  SchemaError,
  HttpError,
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

export { buildSchemaSet } from './xsd/schema-set.js';
export type { SchemaSet, SchemaSetInput, SchemaElementsInput } from './xsd/schema-set.js';
export { BUILTIN_TYPES, SOAP_ENC_ATTRIBUTES, XSD_BUILTIN_NAMES, isBuiltinType, lookupBuiltin } from './xsd/builtins.js';
export type { BuiltinType } from './xsd/builtins.js';
export {
  DEFAULT_GENERATE_OPTIONS,
  generateElement,
  generateSoapEncArray,
  generateType,
} from './xsd/sample-generator.js';
export type { GenerateOptions, GeneratedFragment } from './xsd/sample-generator.js';
export { PLACEHOLDER, sampleValueFor, typeCommentFor } from './xsd/sample-values.js';
export type { SampleValueContext, SampleValueOptions, SimpleTypeRef } from './xsd/sample-values.js';

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
export { isSoapFault, parseFault } from './soap/fault.js';
export type { FaultReason, SoapFault } from './soap/fault.js';
export { parseSoapResponse } from './soap/response-parser.js';
export type { ParsedSoapResponse } from './soap/response-parser.js';

export { createDispatcher, sendHttp } from './http/client.js';
export { buildRawRequest, buildRawResponse } from './http/raw-capture.js';
export type { HttpErrorCode, HttpExchange, HttpRequest, ProxyOptions, Timings, TlsOptions } from './http/types.js';

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
  SoapExchange,
  SoapSendInput,
} from './types.js';

export {
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_REQUEST_PROPERTIES,
  FORMAT_VERSION,
  createInterface,
  createProject,
  createRequest,
  generateId,
} from './project/model.js';
export type {
  AttachmentRef,
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
  keystoresFileSchema,
  manifestSchema,
  parseFile,
  requestFileSchema,
  wssIncomingFileSchema,
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
export { migrate } from './project/migrate.js';
export { KEYSTORES_PATH, MANIFEST_PATH, projectFiles } from './project/serialize.js';
export type { ProjectFiles } from './project/serialize.js';
export { loadProject } from './project/load.js';
export type { LoadProjectOptions, LoadResult, ProjectProblem } from './project/load.js';
export { saveProject } from './project/save.js';
export type { SaveProjectOptions, SaveResult } from './project/save.js';
export { nodeFs } from './project/fs.js';
export type { DirEntry, FileStat, FsLike } from './project/fs.js';
export { expand, expandSendInput, hasExpansions } from './project/properties.js';
export type { ExpandResult, PropertyScopes, UnresolvedRef } from './project/properties.js';
export {
  findEnvironment,
  removeEnvironment,
  resolveEndpoint,
  resolveScopes,
  upsertEnvironment,
} from './project/environments.js';
export type { EndpointSource } from './project/environments.js';
