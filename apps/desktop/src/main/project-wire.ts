/**
 * Pure conversions between the engine's `Project` model — the authoritative shape the main
 * process owns and saves to disk — and the JSON-serialisable `ProjectWire` the renderer
 * mirrors. No `electron`, no `fs`: unit-tested directly against real engine models.
 */

import {
  DEFAULT_WSS_TIMESTAMP_SKEW_SECONDS,
  grpcApisOf,
  keystoreEntrySchema,
  qnameToString,
  restApisOf,
  soapInterfacesOf,
  toKeystoreDef,
  toWssIncomingConfig,
  toWssOutgoingConfig,
  wsApisOf,
  wssEntrySchema,
  wssIncomingFileSchema,
  wssOutgoingFileSchema,
} from '@wirebench/engine';
import { hasUnmirroredFields, KNOWN_WSS_ENTRY_KINDS, opaqueEntryFingerprint } from './wss-opaque.js';
import type {
  Assertion,
  AuthConfig,
  GrpcApi,
  GrpcRequestDef,
  KeyValueEntry,
  RestApi,
  RestBody,
  RestRequestDef,
  Attachment,
  Endpoint,
  Environment,
  Interface,
  OperationDef,
  Project,
  SoapRequestDef,
  RequestScripts,
  UpdatePlan,
  WebhookCollection,
  WsApi,
  WsRequestDef,
  WssEntry,
  WssRef,
} from '@wirebench/engine';
import type {
  RequestAssertionWire,
  AuthConfigWire,
  GrpcApiWire,
  GrpcRequestWire,
  KeyValueWire,
  RestApiWire,
  RestBodyWire,
  RestFolderWire,
  RestRequestWire,
  AttachmentWire,
  EndpointWire,
  EnvironmentWire,
  HydrationStatus,
  InterfaceSummary,
  UpdatePlanWire,
  InterfaceWire,
  KeystoreWire,
  WsApiWire,
  WsRequestWire,
  WssEntryWire,
  WssIncomingWire,
  WssOutgoingWire,
  OperationSummaryWire,
  ProjectProblemWire,
  ProjectWire,
  RequestScriptsWire,
  RequestWire,
} from '../shared/wire-types.js';
import { toMockWire } from './project-mock-mutations.js';
import { toSequenceWire } from './project-sequence-mutations.js';
import { webhookCollectionId } from './webhook-ids.js';

/** What the main process knows about one interface beyond the saved model. */
export interface InterfaceRuntime {
  readonly hydration: HydrationStatus;
  /** The summary produced from the engine `WsdlImportResult`, once the definition is loaded. */
  readonly summary?: InterfaceSummary;
}

/** Everything {@link toProjectWire} needs beyond the model itself. */
export interface ProjectWireContext {
  readonly dir: string;
  readonly dirty: boolean;
  readonly lastSavedAt?: string;
  readonly problems: readonly ProjectProblemWire[];
  /** Per-interface runtime state, keyed by interface id. */
  readonly runtime: ReadonlyMap<string, InterfaceRuntime>;
  /** What main has read from each AsyncAPI-imported API's cached document, keyed by API id. */
  readonly asyncApiInfo?: ReadonlyMap<string, AsyncApiDefinitionInfo>;
}

/** The facts the Definition card shows that live in the cached document rather than the project. */
export interface AsyncApiDefinitionInfo {
  readonly version: string;
  readonly servers: readonly string[];
}

/** The local part of a Clark-notation QName (`{ns}local`); the input itself when it has none. */
export function clarkLocalName(clark: string): string {
  const match = /^\{[^}]*\}(.*)$/.exec(clark);
  return match?.[1] ?? clark;
}

function toEndpointWire(endpoint: Endpoint): EndpointWire {
  return {
    id: endpoint.id,
    name: endpoint.name,
    url: endpoint.url,
    ...(endpoint.auth !== undefined ? { auth: toAuthConfigWire(endpoint.auth) } : {}),
    authMode: endpoint.authMode,
    ...(endpoint.trustInvalid === true ? { trustInvalid: true } : {}),
  };
}

/**
 * Operation summaries derived from the saved model alone, so the explorer can render an
 * interface's tree before its definition has finished hydrating. Anything only the WSDL
 * knows (ports, style, SOAPAction) is filled in once the real summary arrives.
 */
function operationsFromModel(iface: Interface): OperationSummaryWire[] {
  return iface.operations.map((operation) => ({
    name: operation.name,
    binding: operation.bindingName,
    bindingLocal: clarkLocalName(operation.bindingName),
    soapVersion: operation.requests[0]?.soapVersion ?? '1.1',
    style: 'document' as const,
    ports: [],
    // Only the WSDL knows the binding's MIME parts; until it hydrates there are none to offer.
    inputMimeParts: [],
  }));
}

/**
 * Merges the hydrated summary's operations with the ones the model declares, so a request
 * saved against an operation the current WSDL no longer exposes still shows up in the tree.
 */
function mergeOperations(iface: Interface, summary: InterfaceSummary | undefined): OperationSummaryWire[] {
  const fromModel = operationsFromModel(iface);
  if (summary === undefined) {
    return fromModel;
  }
  const key = (op: OperationSummaryWire): string => `${op.binding} ${op.name}`;
  const known = new Set(summary.operations.map(key));
  return [...summary.operations, ...fromModel.filter((op) => !known.has(key(op)))];
}

/** Converts one saved interface (plus whatever the engine knows about it) to its wire shape. */
export function toInterfaceWire(iface: Interface, runtime: InterfaceRuntime | undefined): InterfaceWire {
  const summary = runtime?.summary;
  return {
    id: iface.id,
    name: iface.name,
    slug: iface.slug,
    definitionUrl: iface.definitionUrl,
    cacheDefinition: iface.cacheDefinition,
    targetNamespace: iface.targetNamespace ?? summary?.targetNamespace ?? '',
    soapVersions: summary?.soapVersions ?? [],
    services: summary?.services ?? [],
    operations: mergeOperations(iface, summary),
    problems: summary?.problems ?? [],
    documentCount: summary?.documentCount ?? 0,
    ...(summary?.loadedAt !== undefined ? { loadedAt: summary.loadedAt } : {}),
    wsa: summary?.wsa ?? { enabled: false, version: '2005/08', defaultActionByOperation: {} },
    wsaConfig: { ...iface.wsa },
    endpoints: iface.endpoints.map(toEndpointWire),
    ...(iface.defaultEndpointId !== undefined ? { defaultEndpointId: iface.defaultEndpointId } : {}),
    hydration: runtime?.hydration ?? 'pending',
    // `EndpointAuth` only ever carries a `passwordRef`, never a password — safe on the wire.
    ...(iface.auth !== undefined ? { auth: toAuthConfigWire(iface.auth) } : {}),
  };
}

/**
 * Copies one attachment onto the wire. Field for field with the engine's `Attachment` — no
 * bytes, only the `source` that tells main where to read them.
 */
function toAttachmentWire(attachment: Attachment): AttachmentWire {
  return {
    id: attachment.id,
    name: attachment.name,
    contentType: attachment.contentType,
    size: attachment.size,
    ...(attachment.part !== undefined ? { part: attachment.part } : {}),
    type: attachment.type,
    contentId: attachment.contentId,
    cached: attachment.cached,
    source:
      attachment.source.kind === 'cache'
        ? { kind: 'cache', sha256: attachment.source.sha256 }
        : { kind: 'path', path: attachment.source.path },
  };
}

/** Converts one saved request to its wire shape, flattened out of its owning operation. */
/** A request's scripts as the renderer sees them: their text, and what kept a file from loading. */
export function toRequestScriptsWire(scripts: RequestScripts | undefined): RequestScriptsWire | undefined {
  if (scripts === undefined) {
    return undefined;
  }
  const problems = (['pre', 'post'] as const).flatMap((phase) => {
    const code = scripts[phase]?.problem;
    return code === undefined ? [] : [{ phase, code }];
  });
  return {
    ...(scripts.pre !== undefined ? { pre: scripts.pre.text } : {}),
    ...(scripts.post !== undefined ? { post: scripts.post.text } : {}),
    api: scripts.api,
    enabled: scripts.enabled,
    secrets: [...scripts.secrets],
    ...(scripts.timeoutMs !== undefined ? { timeoutMs: scripts.timeoutMs } : {}),
    ...(problems.length > 0 ? { problems } : {}),
  };
}

/** A request's own assertions as the renderer edits them: the engine's shapes, copied. */
function toAssertionWires(assertions: readonly Assertion[] | undefined): RequestAssertionWire[] {
  return (assertions ?? []).map((assertion) => structuredClone(assertion) as RequestAssertionWire);
}

/** `{ scripts }` for a wire object, or nothing when the request has none. */
function scriptsField(scripts: RequestScripts | undefined): { scripts?: RequestScriptsWire } {
  const wire = toRequestScriptsWire(scripts);
  return wire === undefined ? {} : { scripts: wire };
}

export function toRequestWire(iface: Interface, operation: OperationDef, request: SoapRequestDef): RequestWire {
  return {
    id: request.id,
    interfaceId: iface.id,
    bindingName: operation.bindingName,
    operationName: operation.name,
    name: request.name,
    slug: request.slug,
    operationSlug: operation.slug,
    envelopeXml: request.envelopeXml,
    soapVersion: request.soapVersion,
    ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
    ...(request.endpointId !== undefined ? { endpointId: request.endpointId } : {}),
    ...(request.endpointUrl !== undefined ? { endpointUrl: request.endpointUrl } : {}),
    headers: request.headers.map((header) => ({
      name: header.name,
      value: header.value,
      ...(header.enabled === false ? { enabled: false } : {}),
      ...(header.description !== undefined ? { description: header.description } : {}),
    })),
    order: request.order,
    ...(request.auth !== undefined ? { auth: toAuthConfigWire(request.auth) } : {}),
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.wsa !== undefined ? { wsa: request.wsa } : {}),
    ...(request.wssOutgoingRef !== undefined ? { wssOutgoingRef: request.wssOutgoingRef } : {}),
    ...(request.wssIncomingRef !== undefined ? { wssIncomingRef: request.wssIncomingRef } : {}),
    attachments: request.attachments.map(toAttachmentWire),
    properties: { ...request.properties },
    ...scriptsField(request.scripts),
    assertions: toAssertionWires(request.assertions),
    ...(request.orphaned === true ? { orphaned: true } : {}),
  };
}

/** Projects an engine {@link UpdatePlan} onto the wire, with Clark-notation binding names. */
export function toUpdatePlanWire(plan: UpdatePlan): UpdatePlanWire {
  const ref = (operation: UpdatePlan['newOperations'][number]): { bindingName: string; operationName: string } => ({
    bindingName: qnameToString(operation.bindingName),
    operationName: operation.operationName,
  });
  return {
    newOperations: plan.newOperations.map(ref),
    removedOperations: plan.removedOperations.map(ref),
    changedOperations: plan.changedOperations.map((changed) => ({ ref: ref(changed.ref), reason: changed.reason })),
    endpointsAdded: [...plan.endpointsAdded],
    endpointsRemoved: [...plan.endpointsRemoved],
  };
}

/** Every request of a project, in interface then operation then request order. */
export function toRequestWires(project: Project): RequestWire[] {
  return soapInterfacesOf(project).flatMap((iface) =>
    iface.operations.flatMap((operation) =>
      operation.requests.map((request) => toRequestWire(iface, operation, request)),
    ),
  );
}

function toEnvironmentWire(environment: Environment): EnvironmentWire {
  return {
    id: environment.id,
    name: environment.name,
    slug: environment.slug,
    order: environment.order,
    endpoints: { ...environment.endpoints },
    properties: { ...environment.properties },
    disabled: [...environment.disabledProperties],
  };
}

/**
 * One keystore registry entry, projected for the renderer. A malformed entry (one an older or
 * hand-edited file left without a path) is described rather than dropped, so the UI can offer
 * to remove it instead of the row silently vanishing.
 */
function toKeystoreWire(ref: WssRef): KeystoreWire {
  const parsed = keystoreEntrySchema.safeParse(ref.document);
  if (!parsed.success) {
    return { id: ref.id, name: ref.name, path: '', type: 'pem' };
  }
  const def = toKeystoreDef(ref);
  return {
    id: def.id,
    name: def.name,
    path: def.path,
    type: def.type,
    ...(def.passwordSecretRef !== undefined ? { passwordSecretRef: def.passwordSecretRef } : {}),
    ...(def.passwordEnv !== undefined ? { passwordEnv: def.passwordEnv } : {}),
    ...(def.defaultAlias !== undefined ? { defaultAlias: def.defaultAlias } : {}),
  };
}

/**
 * One outgoing WS-Security configuration, projected for the renderer. An entry this build does
 * not understand (a kind a later build wrote) is projected as an opaque `unknown` entry so the
 * editor can list it as needing a newer version, and write it back untouched; a document that is
 * not a configuration at all becomes an empty one, for the same "offer to remove it" reason
 * `toKeystoreWire` has.
 */
function toWssOutgoingWire(ref: WssRef): WssOutgoingWire {
  if (!wssOutgoingFileSchema.safeParse(ref.document).success) {
    return { id: ref.id, name: ref.name, mustUnderstand: false, entries: [] };
  }
  const config = toWssOutgoingConfig(ref);
  return {
    id: config.id,
    name: config.name,
    ...(config.defaultAlias !== undefined ? { defaultAlias: config.defaultAlias } : {}),
    ...(config.defaultPasswordRef !== undefined ? { defaultPasswordRef: config.defaultPasswordRef } : {}),
    ...(config.actor !== undefined ? { actor: config.actor } : {}),
    mustUnderstand: config.mustUnderstand,
    entries: config.entries.map((entry, index) => toWssEntryWireAt(ref, entry, index)),
  };
}

/**
 * The wire entry at `index` of a stored list. An entry this build cannot interpret (a kind a
 * later build wrote, or a known kind whose shape fails the engine schema) becomes an opaque
 * `unknown` entry rather than being coerced into one it is not (so is a known kind carrying fields
 * a later build added, which the field-by-field projection would drop): the editor writes the whole list
 * back on every edit, and `updateWssOutgoing` restores the stored entry from its `index`.
 */
function toWssEntryWireAt(ref: WssRef, entry: WssEntry, index: number): WssEntryWire {
  const stored: unknown = Array.isArray(ref.document['entries']) ? ref.document['entries'][index] : undefined;
  // A known kind that parses but carries fields a newer build added is opaque too: rebuilding it
  // field by field would drop them on the next write-back.
  const readable = wssEntrySchema.safeParse(entry).success;
  if (readable) {
    const wire = toWssEntryWire(entry);
    if (!hasUnmirroredFields(stored, wire)) {
      return wire;
    }
  }
  const kind = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>)['kind'] : undefined;
  const originalKind = typeof kind === 'string' ? kind : 'unknown';
  return {
    kind: 'unknown',
    originalKind,
    index,
    fingerprint: opaqueEntryFingerprint(stored),
    unreadable: !readable && KNOWN_WSS_ENTRY_KINDS.has(originalKind),
  };
}

/** One entry on the wire, field by field. */
function toWssEntryWire(entry: WssEntry): WssEntryWire {
  if (entry.kind === 'timestamp') {
    return {
      kind: 'timestamp',
      timeToLiveSeconds: entry.timeToLiveSeconds,
      millisecondPrecision: entry.millisecondPrecision,
    };
  }
  if (entry.kind === 'username-token') {
    return {
      kind: 'username-token',
      username: entry.username,
      ...(entry.passwordRef !== undefined ? { passwordRef: entry.passwordRef } : {}),
      passwordType: entry.passwordType,
      addNonce: entry.addNonce,
      addCreated: entry.addCreated,
    };
  }
  if (entry.kind === 'signature') {
    return {
      kind: 'signature',
      keystoreRef: entry.keystoreRef,
      ...(entry.alias !== undefined ? { alias: entry.alias } : {}),
      ...(entry.keyPasswordRef !== undefined ? { keyPasswordRef: entry.keyPasswordRef } : {}),
      keyIdentifierType: entry.keyIdentifierType,
      signatureAlgorithm: entry.signatureAlgorithm,
      digestAlgorithm: entry.digestAlgorithm,
      canonicalization: 'exc-c14n',
      useSingleCertificate: entry.useSingleCertificate,
      parts: entry.parts.map((part) => ({
        name: part.name,
        namespace: part.namespace,
        encode: part.encode,
        ...(part.token === true ? { token: true as const } : {}),
      })),
    };
  }
  if (entry.kind === 'issued-token' || entry.kind === 'saml-token') {
    // The engine model and the wire schema share these two kinds field for field; the editor
    // owns their optional keys, so they pass through as they are stored.
    return structuredClone(entry) as WssEntryWire;
  }
  return {
    kind: 'encryption',
    keystoreRef: entry.keystoreRef,
    ...(entry.alias !== undefined ? { alias: entry.alias } : {}),
    keyIdentifierType: entry.keyIdentifierType,
    symmetricAlgorithm: entry.symmetricAlgorithm,
    keyTransportAlgorithm: entry.keyTransportAlgorithm,
    embedKey: entry.embedKey,
    encryptSymmetricKey: entry.encryptSymmetricKey,
    parts: entry.parts.map((part) => ({ name: part.name, namespace: part.namespace, encode: part.encode })),
  };
}

/**
 * An API's own row. Its folders and requests travel as flat lists beside it, keyed by `apiId` and
 * `parentId`: the renderer's tree is rebuilt from those, and a nested payload would have to be
 * re-walked on every change anyway.
 */
function toApiWire(api: RestApi): RestApiWire {
  return {
    kind: 'rest',
    id: api.id,
    name: api.name,
    slug: api.slug,
    order: api.order,
    ...(api.description !== undefined ? { description: api.description } : {}),
    baseUrl: api.baseUrl,
    servers: api.servers.map((server) => ({
      url: server.url,
      ...(server.description !== undefined ? { description: server.description } : {}),
    })),
    ...(api.auth !== undefined ? { auth: toAuthConfigWire(api.auth) } : {}),
    ...(api.definition !== undefined
      ? {
          definition: {
            source: api.definition.source,
            cache: api.definition.cache,
            version: api.definition.version,
            ...(api.definition.auth !== undefined ? { auth: toAuthConfigWire(api.definition.auth) } : {}),
          },
        }
      : {}),
  };
}

/** Authentication as the renderer sees it: the engine's union flattened into one optional-field row. */
export function toAuthConfigWire(auth: AuthConfig): AuthConfigWire {
  return { ...auth } as AuthConfigWire;
}

function toKeyValueWires(rows: readonly KeyValueEntry[]): KeyValueWire[] {
  return rows.map((row) => ({
    name: row.name,
    value: row.value,
    enabled: row.enabled,
    ...(row.description !== undefined ? { description: row.description } : {}),
  }));
}

/** A body as the renderer sees it: identical to the model, since the model already holds the text. */
function toRestBodyWire(body: RestBody): RestBodyWire {
  switch (body.kind) {
    case 'raw':
      return {
        kind: 'raw',
        language: body.language,
        ...(body.contentType !== undefined ? { contentType: body.contentType } : {}),
        text: body.text,
      };
    case 'form':
      return { kind: 'form', fields: toKeyValueWires(body.fields) };
    case 'multipart':
      return { kind: 'multipart', parts: body.parts.map((part) => ({ ...part })) };
    case 'binary':
      return { kind: 'binary', source: { ...body.source }, contentType: body.contentType };
    default:
      return { kind: 'none' };
  }
}

function toRestRequestWire(request: RestRequestDef, apiId: string, folderId: string | undefined): RestRequestWire {
  return {
    kind: 'rest',
    id: request.id,
    apiId,
    ...(folderId !== undefined ? { folderId } : {}),
    name: request.name,
    slug: request.slug,
    order: request.order,
    ...(request.description !== undefined ? { description: request.description } : {}),
    method: request.method,
    url: request.url,
    pathParams: toKeyValueWires(request.pathParams),
    query: toKeyValueWires(request.query),
    headers: toKeyValueWires(request.headers),
    body: toRestBodyWire(request.body),
    auth: toAuthConfigWire(request.auth),
    settings: { ...request.settings },
    ...scriptsField(request.scripts),
    assertions: toAssertionWires(request.assertions),
    ...(request.orphaned === true ? { orphaned: true } : {}),
    ...(request.hook !== undefined ? { hook: request.hook } : {}),
    ...(request.signing !== undefined ? { signing: request.signing } : {}),
    ...(request.examples !== undefined
      ? {
          examples: request.examples.map((example) => ({
            id: example.id,
            name: example.name,
            status: example.status,
            statusText: example.statusText,
            headers: toKeyValueWires(example.headers),
            ...(example.contentType !== undefined ? { contentType: example.contentType } : {}),
            ...(example.body !== undefined ? { body: example.body } : {}),
          })),
        }
      : {}),
  };
}

/** Every folder and REST request of every API, flattened for the wire. */
function toRestTreeWires(apis: readonly RestApi[]): {
  readonly folders: RestFolderWire[];
  readonly requests: RestRequestWire[];
} {
  const folders: RestFolderWire[] = [];
  const requests: RestRequestWire[] = [];
  const walk = (api: RestApi, container: Pick<RestApi, 'folders' | 'requests'>, parentId?: string): void => {
    for (const request of container.requests) {
      requests.push(toRestRequestWire(request, api.id, parentId));
    }
    for (const folder of container.folders) {
      folders.push({
        id: folder.id,
        apiId: api.id,
        ...(parentId !== undefined ? { parentId } : {}),
        name: folder.name,
        slug: folder.slug,
        order: folder.order,
        ...(folder.description !== undefined ? { description: folder.description } : {}),
        ...(folder.auth !== undefined ? { auth: toAuthConfigWire(folder.auth) } : {}),
      });
      walk(api, folder, folder.id);
    }
  };
  for (const api of apis) {
    walk(api, api);
  }
  return { folders, requests };
}

/**
 * The project's webhook collection, projected for the wire under the synthetic id
 * `webhooks:<projectId>` — never a real API id — or `undefined` when the project has none yet.
 */
function toWebhookCollectionWire(project: Project): ProjectWire['webhooks'] {
  const webhooks = project.webhooks;
  if (webhooks === undefined) {
    return undefined;
  }
  return {
    id: webhookCollectionId(project.id),
    projectId: project.id,
    target: webhooks.target,
    ...(webhooks.auth !== undefined ? { auth: toAuthConfigWire(webhooks.auth) } : {}),
    ...(webhooks.signing !== undefined ? { signing: webhooks.signing } : {}),
  };
}

/**
 * Every folder and request of the project's webhook collection, flattened for the wire exactly
 * like an API's tree, joining the same flat `folders`/`restRequests` lists under `webhooks.id`.
 */
function toWebhookTreeWires(
  collection: WebhookCollection,
  collectionId: string,
): { readonly folders: RestFolderWire[]; readonly requests: RestRequestWire[] } {
  const folders: RestFolderWire[] = [];
  const requests: RestRequestWire[] = [];
  const walk = (container: Pick<WebhookCollection, 'folders' | 'requests'>, parentId?: string): void => {
    for (const request of container.requests) {
      requests.push(toRestRequestWire(request, collectionId, parentId));
    }
    for (const folder of container.folders) {
      folders.push({
        id: folder.id,
        apiId: collectionId,
        ...(parentId !== undefined ? { parentId } : {}),
        name: folder.name,
        slug: folder.slug,
        order: folder.order,
        ...(folder.description !== undefined ? { description: folder.description } : {}),
        ...(folder.auth !== undefined ? { auth: toAuthConfigWire(folder.auth) } : {}),
        ...(folder.target !== undefined ? { target: folder.target } : {}),
        ...(folder.source !== undefined ? { source: { apiId: folder.source.apiId } } : {}),
        ...(folder.signing !== undefined ? { signing: folder.signing } : {}),
      });
      walk(folder, folder.id);
    }
  };
  walk(collection);
  return { folders, requests };
}

/** A gRPC API's own row; its folders and requests travel flat beside it like a REST API's. */
function toGrpcApiWire(api: GrpcApi): GrpcApiWire {
  return {
    kind: 'grpc',
    id: api.id,
    name: api.name,
    slug: api.slug,
    order: api.order,
    ...(api.description !== undefined ? { description: api.description } : {}),
    target: api.target,
    tls: api.tls,
    metadata: toKeyValueWires(api.metadata),
    ...(api.auth !== undefined ? { auth: toAuthConfigWire(api.auth) } : {}),
    ...(api.definition !== undefined
      ? {
          definition: {
            kind: api.definition.kind,
            source: api.definition.source,
            cache: api.definition.cache,
            roots: [...api.definition.roots],
            ...(api.definition.reflectionVersion !== undefined
              ? { reflectionVersion: api.definition.reflectionVersion }
              : {}),
          },
        }
      : {}),
  };
}

function toGrpcRequestWire(request: GrpcRequestDef, apiId: string, folderId: string | undefined): GrpcRequestWire {
  return {
    kind: 'grpc',
    id: request.id,
    apiId,
    ...(folderId !== undefined ? { folderId } : {}),
    name: request.name,
    slug: request.slug,
    order: request.order,
    ...(request.description !== undefined ? { description: request.description } : {}),
    service: request.service,
    method: request.method,
    methodKind: request.methodKind,
    metadata: toKeyValueWires(request.metadata),
    message: request.message,
    auth: toAuthConfigWire(request.auth),
    settings: { ...request.settings },
    ...scriptsField(request.scripts),
    assertions: toAssertionWires(request.assertions),
    ...(request.orphaned === true ? { orphaned: true } : {}),
  };
}

/** Every folder and gRPC request of every gRPC API, flattened; the folders join the REST ones. */
function toGrpcTreeWires(apis: readonly GrpcApi[]): {
  readonly folders: RestFolderWire[];
  readonly requests: GrpcRequestWire[];
} {
  const folders: RestFolderWire[] = [];
  const requests: GrpcRequestWire[] = [];
  const walk = (api: GrpcApi, container: Pick<GrpcApi, 'folders' | 'requests'>, parentId?: string): void => {
    for (const request of container.requests) {
      requests.push(toGrpcRequestWire(request, api.id, parentId));
    }
    for (const folder of container.folders) {
      folders.push({
        id: folder.id,
        apiId: api.id,
        ...(parentId !== undefined ? { parentId } : {}),
        name: folder.name,
        slug: folder.slug,
        order: folder.order,
        ...(folder.description !== undefined ? { description: folder.description } : {}),
        ...(folder.auth !== undefined ? { auth: toAuthConfigWire(folder.auth) } : {}),
      });
      walk(api, folder, folder.id);
    }
  };
  for (const api of apis) {
    walk(api, api);
  }
  return { folders, requests };
}

/** A WebSocket API's own row; its folders and requests travel flat beside it like a gRPC API's. */
function toWsApiWire(api: WsApi, info?: AsyncApiDefinitionInfo): WsApiWire {
  return {
    kind: 'websocket',
    id: api.id,
    name: api.name,
    slug: api.slug,
    order: api.order,
    ...(api.description !== undefined ? { description: api.description } : {}),
    url: api.url,
    headers: toKeyValueWires(api.headers),
    ...(api.auth !== undefined ? { auth: toAuthConfigWire(api.auth) } : {}),
    ...(api.definition !== undefined
      ? {
          definition: {
            kind: api.definition.kind,
            source: api.definition.source,
            cache: api.definition.cache,
            ...(api.definition.server !== undefined ? { server: api.definition.server } : {}),
            ...(info !== undefined ? { version: info.version, servers: [...info.servers] } : {}),
            ...(api.definition.auth !== undefined ? { auth: toAuthConfigWire(api.definition.auth) } : {}),
          },
        }
      : {}),
  };
}

function toWsMessageWire(message: WsRequestDef['messages'][number]): WsRequestWire['messages'][number] {
  return {
    id: message.id,
    name: message.name,
    slug: message.slug,
    format: message.format,
    content: message.content,
    ...(message.contract !== undefined
      ? { contract: { message: message.contract.message, generated: message.contract.generated } }
      : {}),
  };
}

function toWsRequestWire(request: WsRequestDef, apiId: string, folderId: string | undefined): WsRequestWire {
  return {
    kind: 'websocket',
    id: request.id,
    apiId,
    ...(folderId !== undefined ? { folderId } : {}),
    name: request.name,
    slug: request.slug,
    order: request.order,
    ...(request.description !== undefined ? { description: request.description } : {}),
    url: request.url,
    query: toKeyValueWires(request.query),
    headers: toKeyValueWires(request.headers),
    subprotocols: [...request.subprotocols],
    auth: toAuthConfigWire(request.auth),
    settings: { ...request.settings },
    messages: request.messages.map(toWsMessageWire),
    assertions: toAssertionWires(request.assertions),
    ...(request.contract !== undefined ? { contract: { channel: request.contract.channel } } : {}),
    ...(request.orphaned === true ? { orphaned: true } : {}),
  };
}

/** Every folder and WebSocket request of every WebSocket API, flattened; the folders join the rest. */
function toWsTreeWires(apis: readonly WsApi[]): {
  readonly folders: RestFolderWire[];
  readonly requests: WsRequestWire[];
} {
  const folders: RestFolderWire[] = [];
  const requests: WsRequestWire[] = [];
  const walk = (api: WsApi, container: Pick<WsApi, 'folders' | 'requests'>, parentId?: string): void => {
    for (const request of container.requests) {
      requests.push(toWsRequestWire(request, api.id, parentId));
    }
    for (const folder of container.folders) {
      folders.push({
        id: folder.id,
        apiId: api.id,
        ...(parentId !== undefined ? { parentId } : {}),
        name: folder.name,
        slug: folder.slug,
        order: folder.order,
        ...(folder.description !== undefined ? { description: folder.description } : {}),
        ...(folder.auth !== undefined ? { auth: toAuthConfigWire(folder.auth) } : {}),
      });
      walk(api, folder, folder.id);
    }
  };
  for (const api of apis) {
    walk(api, api);
  }
  return { folders, requests };
}

/** Converts the whole open project into the snapshot the renderer mirrors. */
export function toProjectWire(project: Project, context: ProjectWireContext): ProjectWire {
  const restTree = toRestTreeWires(restApisOf(project));
  const grpcTree = toGrpcTreeWires(grpcApisOf(project));
  const wsTree = toWsTreeWires(wsApisOf(project));
  const webhookTree =
    project.webhooks !== undefined ? toWebhookTreeWires(project.webhooks, webhookCollectionId(project.id)) : undefined;
  const webhooksWire = toWebhookCollectionWire(project);
  return {
    id: project.id,
    name: project.name,
    dir: context.dir,
    dirty: context.dirty,
    ...(context.lastSavedAt !== undefined ? { lastSavedAt: context.lastSavedAt } : {}),
    interfaces: soapInterfacesOf(project).map((iface) => toInterfaceWire(iface, context.runtime.get(iface.id))),
    requests: toRequestWires(project),
    apis: restApisOf(project).map(toApiWire),
    folders: [...restTree.folders, ...grpcTree.folders, ...wsTree.folders, ...(webhookTree?.folders ?? [])],
    restRequests: [...restTree.requests, ...(webhookTree?.requests ?? [])],
    ...(webhooksWire !== undefined ? { webhooks: webhooksWire } : {}),
    grpcApis: grpcApisOf(project).map(toGrpcApiWire),
    grpcRequests: grpcTree.requests,
    wsApis: wsApisOf(project).map((api) => toWsApiWire(api, context.asyncApiInfo?.get(api.id))),
    wsRequests: wsTree.requests,
    sequences: project.sequences.map(toSequenceWire),
    mocks: project.mocks.map(toMockWire),
    properties: { ...project.properties },
    disabledProperties: [...project.disabledProperties],
    environments: project.environments.map(toEnvironmentWire),
    ...(project.activeEnvironmentId !== undefined ? { activeEnvironmentId: project.activeEnvironmentId } : {}),
    problems: [...context.problems],
    settings: { ...project.settings },
    keystores: project.wss.keystores.map(toKeystoreWire),
    wssOutgoing: project.wss.outgoing.map(toWssOutgoingWire),
    wssIncoming: project.wss.incoming.map(toWssIncomingWire),
  };
}

/**
 * One incoming WS-Security configuration, projected for the renderer: registry ids, a secret
 * reference and the strictness knobs — never a certificate, a key or a password. A document
 * that is not a configuration at all becomes a defaults-only one, so the row stays visible and
 * removable rather than silently vanishing.
 */
function toWssIncomingWire(ref: WssRef): WssIncomingWire {
  const defaults = {
    requireSignature: false,
    requireTimestamp: false,
    timestampSkewSeconds: DEFAULT_WSS_TIMESTAMP_SKEW_SECONDS,
    verifyChain: true,
  };
  if (!wssIncomingFileSchema.safeParse(ref.document).success) {
    return { id: ref.id, name: ref.name, ...defaults };
  }
  const config = toWssIncomingConfig(ref);
  return {
    id: config.id,
    name: config.name,
    ...(config.decryptKeystoreRef !== undefined ? { decryptKeystoreRef: config.decryptKeystoreRef } : {}),
    ...(config.decryptAlias !== undefined ? { decryptAlias: config.decryptAlias } : {}),
    ...(config.decryptKeyPasswordRef !== undefined ? { decryptKeyPasswordRef: config.decryptKeyPasswordRef } : {}),
    ...(config.signatureKeystoreRef !== undefined ? { signatureKeystoreRef: config.signatureKeystoreRef } : {}),
    requireSignature: config.requireSignature,
    requireTimestamp: config.requireTimestamp,
    timestampSkewSeconds: config.timestampSkewSeconds,
    verifyChain: config.verifyChain,
  };
}

/** Where a request lives inside the model: its owning interface and operation. */
export interface RequestLocation {
  readonly iface: Interface;
  readonly operation: OperationDef;
  readonly request: SoapRequestDef;
}

/** Locates a request (and its owning interface/operation) by id, or `undefined` when unknown. */
export function findRequest(project: Project, requestId: string): RequestLocation | undefined {
  for (const iface of soapInterfacesOf(project)) {
    for (const operation of iface.operations) {
      const request = operation.requests.find((candidate) => candidate.id === requestId);
      if (request !== undefined) {
        return { iface, operation, request };
      }
    }
  }
  return undefined;
}
