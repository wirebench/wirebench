/**
 * Applying the SOAP half of a `ProjectChange` to a project model: interfaces, their endpoints,
 * requests, WS-Addressing, auth, attachments and the WS-Security configurations. SOAP's `mutations`
 * table (spec §5.2) is at the end.
 *
 * Every function validates the ids it is given and throws `ProjectError('not-found')` rather than
 * silently no-op'ing, so a stale renderer mirror surfaces as an error instead of a mutation that
 * appears to succeed.
 */

import {
  createRequest,
  defaultContentId,
  generateId,
  normalizeWsa,
  ProjectError,
  soapInterfacesOf,
  uniqueSlug,
} from '@wirebench/engine';
import type {
  Attachment,
  AttachmentSource,
  Endpoint,
  Interface,
  OperationDef,
  Project,
  SoapRequestDef,
  RequestProperties,
  SoapOwnerAuth,
  WsaConfig,
  WsaConfigPatch,
} from '@wirebench/engine';
import type {
  AttachmentPatchWire,
  RequestPatchWire,
  RequestPropertiesPatchWire,
  WsaConfigWire,
} from '../../../shared/kinds/soap/wire.js';
import type { AuthConfigWire } from '../../../shared/wire-base.js';
import { toEngineAuthConfig } from '../../project-api-mutations.js';
import type { MutationDeps, MutationResult } from '../../project-mutations.js';
import type { RequestLocation } from '../../project-wire.js';
import { findRequest } from '../../project-wire.js';
import type { KindMutations } from '../kind-main.js';
import {
  addWssIncoming,
  addWssOutgoing,
  removeWssIncoming,
  removeWssOutgoing,
  updateWssIncoming,
  updateWssOutgoing,
} from './wss-mutations.js';

/** The engine output `add-request` needs; supplied by the service, which owns the engine. */
export interface GeneratedEnvelope {
  readonly envelopeXml: string;
  readonly soapVersion: '1.1' | '1.2';
  readonly soapAction?: string;
}

function notFound(what: string, id: string): never {
  throw new ProjectError('not-found', `No ${what} with id "${id}"`, { details: { id } });
}

function requireInterface(project: Project, interfaceId: string): Interface {
  return soapInterfacesOf(project).find((iface) => iface.id === interfaceId) ?? notFound('interface', interfaceId);
}

function replaceInterface(project: Project, next: Interface): Project {
  return {
    ...project,
    containers: {
      ...project.containers,
      soap: soapInterfacesOf(project).map((iface) => (iface.id === next.id ? next : iface)),
    },
  };
}

function replaceOperation(iface: Interface, next: OperationDef): Interface {
  return {
    ...iface,
    operations: iface.operations.map((operation) =>
      operation.name === next.name && operation.bindingName === next.bindingName ? next : operation,
    ),
  };
}

/**
 * A new request's name within one operation: the operation's ("Add"), then "Add 2", "Add 3"… for the first
 * free number. "Request N" told requests apart nowhere outside the tree (#726).
 */
function nextRequestName(operation: OperationDef): string {
  const taken = new Set(operation.requests.map((request) => request.name));
  // Follow the first generated name, so a second "Add (SOAP 1.2)" request is "Add (SOAP 1.2) 2" (#726).
  const first = operation.requests[0]?.name;
  const base = first?.startsWith(operation.name) === true ? first : operation.name;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${String(n)}`)) n += 1;
  return `${base} ${String(n)}`;
}

/** Finds the operation, or appends a freshly-slugged empty one when the interface lacks it. */
function ensureOperation(
  iface: Interface,
  bindingName: string,
  operationName: string,
): { iface: Interface; operation: OperationDef } {
  const existing = iface.operations.find((op) => op.bindingName === bindingName && op.name === operationName);
  if (existing !== undefined) {
    return { iface, operation: existing };
  }
  const operation: OperationDef = {
    name: operationName,
    bindingName,
    slug: uniqueSlug(operationName, new Set(iface.operations.map((op) => op.slug))),
    order: iface.operations.length,
    requests: [],
  };
  return { iface: { ...iface, operations: [...iface.operations, operation] }, operation };
}

/** Appends `request` to `operation`, keeping `order` contiguous. */
function withRequest(operation: OperationDef, request: SoapRequestDef): OperationDef {
  return { ...operation, requests: [...operation.requests, request] };
}

/** Adds a generated request to an operation. Exported so `addInterface` can reuse it. */
export function addRequest(
  project: Project,
  input: {
    interfaceId: string;
    bindingName: string;
    operationName: string;
    generated: GeneratedEnvelope;
    name?: string;
  },
): MutationResult {
  const found = requireInterface(project, input.interfaceId);
  const { iface, operation } = ensureOperation(found, input.bindingName, input.operationName);
  const name = input.name ?? nextRequestName(operation);
  const request = createRequest(name, {
    id: generateId(),
    envelopeXml: input.generated.envelopeXml,
    soapVersion: input.generated.soapVersion,
    slug: uniqueSlug(name, new Set(operation.requests.map((r) => r.slug))),
    order: operation.requests.length,
    ...(input.generated.soapAction !== undefined ? { soapAction: input.generated.soapAction } : {}),
    ...(iface.defaultEndpointId !== undefined ? { endpointId: iface.defaultEndpointId } : {}),
  });
  return {
    project: replaceInterface(project, replaceOperation(iface, withRequest(operation, request))),
    createdRequestId: request.id,
  };
}

function cloneRequest(project: Project, requestId: string): MutationResult {
  const location = findRequest(project, requestId) ?? notFound('request', requestId);
  const { iface, operation, request } = location;
  const name = `${request.name} (copy)`;
  const clone: SoapRequestDef = {
    ...request,
    id: generateId(),
    name,
    slug: uniqueSlug(name, new Set(operation.requests.map((r) => r.slug))),
    order: operation.requests.length,
  };
  return {
    project: replaceInterface(project, replaceOperation(iface, withRequest(operation, clone))),
    createdRequestId: clone.id,
  };
}

function removeRequest(project: Project, requestId: string): MutationResult {
  const location = findRequest(project, requestId) ?? notFound('request', requestId);
  const { iface, operation } = location;
  const remaining = operation.requests
    .filter((request) => request.id !== requestId)
    .map((request, index) => ({ ...request, order: index }));
  return { project: replaceInterface(project, replaceOperation(iface, { ...operation, requests: remaining })) };
}

/**
 * Applies a renderer patch to one request. A `null` in the patch clears an optional field
 * (`exactOptionalPropertyTypes` means "absent" and "explicitly undefined" are different
 * things, so the wire uses `null` for "unset this"). A rename re-derives the slug, keeping
 * it unique within the operation folder.
 */
function updateRequest(project: Project, requestId: string, patch: RequestPatchWire): MutationResult {
  const location = findRequest(project, requestId) ?? notFound('request', requestId);
  const { iface, operation, request } = location;

  const takenSlugs = new Set(operation.requests.filter((r) => r.id !== requestId).map((r) => r.slug));
  const name = patch.name ?? request.name;
  const slug = patch.name === undefined || patch.name === request.name ? request.slug : uniqueSlug(name, takenSlugs);

  const optional = <
    K extends 'endpointId' | 'endpointUrl' | 'soapAction' | 'description' | 'wssOutgoingRef' | 'wssIncomingRef',
  >(
    key: K,
  ): Partial<Pick<SoapRequestDef, K>> => {
    const value = patch[key];
    if (value === undefined) {
      return request[key] === undefined ? {} : ({ [key]: request[key] } as Pick<SoapRequestDef, K>);
    }
    return value === null ? {} : ({ [key]: value } as Pick<SoapRequestDef, K>);
  };

  const next: SoapRequestDef = {
    kind: request.kind,
    id: request.id,
    name,
    slug,
    order: request.order,
    ...optional('description'),
    ...optional('endpointId'),
    ...optional('endpointUrl'),
    soapVersion: request.soapVersion,
    ...optional('soapAction'),
    headers:
      patch.headers?.map((header) => ({
        name: header.name,
        value: header.value,
        ...(header.enabled === false ? { enabled: false } : {}),
        ...(header.description !== undefined && header.description.length > 0
          ? { description: header.description }
          : {}),
      })) ?? request.headers,
    attachments: request.attachments,
    ...(request.auth !== undefined ? { auth: request.auth } : {}),
    ...(request.wsa !== undefined ? { wsa: request.wsa } : {}),
    ...optional('wssOutgoingRef'),
    ...optional('wssIncomingRef'),
    properties: request.properties,
    assertions: request.assertions,
    ...(request.scripts !== undefined ? { scripts: request.scripts } : {}),
    envelopeXml: patch.envelopeXml ?? request.envelopeXml,
  };

  const requests = operation.requests.map((candidate) => (candidate.id === requestId ? next : candidate));
  return { project: replaceInterface(project, replaceOperation(iface, { ...operation, requests })) };
}

/**
 * Rebuilds an interface field by field, so `defaultEndpointId` can be *absent* rather than
 * explicitly `undefined` — which `exactOptionalPropertyTypes` treats as a different thing,
 * and which a spread cannot express.
 */
function rebuiltInterface(
  iface: Interface,
  endpoints: readonly Endpoint[],
  defaultEndpointId: string | undefined,
): Interface {
  return {
    kind: iface.kind,
    id: iface.id,
    name: iface.name,
    slug: iface.slug,
    order: iface.order,
    definitionUrl: iface.definitionUrl,
    cacheDefinition: iface.cacheDefinition,
    ...(iface.targetNamespace !== undefined ? { targetNamespace: iface.targetNamespace } : {}),
    endpoints,
    ...(defaultEndpointId !== undefined ? { defaultEndpointId } : {}),
    wsa: iface.wsa,
    ...(iface.auth !== undefined ? { auth: iface.auth } : {}),
    operations: iface.operations,
  };
}

function requireEndpoint(iface: Interface, endpointId: string): Endpoint {
  return iface.endpoints.find((endpoint) => endpoint.id === endpointId) ?? notFound('endpoint', endpointId);
}

/**
 * Converts a SOAP auth mutation's wire payload to the engine's {@link SoapOwnerAuth}.
 *
 * The same normaliser REST uses ({@link toEngineAuthConfig}) rather than a SOAP copy: the two
 * owners hold the same scheme shapes, and two converters would drift on exactly the field a new
 * scheme adds. The one SOAP difference is `inherit`, which `soapOwnerAuthWireSchema` refuses at
 * the IPC boundary; a stale renderer or hand-built call that gets past it still fails loudly here
 * rather than landing on some other scheme — a SOAP owner has nothing above it to inherit from.
 */
function toEngineAuth(auth: AuthConfigWire): SoapOwnerAuth {
  if (auth.type === 'inherit') {
    throw new ProjectError(
      'auth-inherit-unsupported',
      'A SOAP interface, endpoint or request auth cannot be "inherit"',
    );
  }
  return toEngineAuthConfig(auth) as SoapOwnerAuth;
}

/**
 * Normalises a wire `WsaConfigWire` (zod optionals type as `T | undefined`) into the engine's
 * `WsaConfig`, filling every unset field with the v1 defaults.
 */
function toEngineWsa(wsa: WsaConfigWire): WsaConfig {
  const patch = Object.entries(wsa).reduce<WsaConfigPatch>(
    (accumulated, [key, value]) => (value === undefined ? accumulated : { ...accumulated, [key]: value }),
    {},
  );
  return normalizeWsa(patch);
}

/**
 * Sets (or clears, with `wsa: null`) one request's own WS-Addressing overrides. Clearing puts
 * the request back on "inherit from the interface", which is a different state from an
 * explicitly disabled configuration.
 */
function updateRequestWsa(project: Project, requestId: string, wsa: WsaConfig | null): MutationResult {
  const location = findRequest(project, requestId) ?? notFound('request', requestId);
  const next: SoapRequestDef = { ...location.request };
  const withWsa: SoapRequestDef = wsa === null ? omitWsa(next) : { ...next, wsa };
  return { project: replaceRequest(project, location, withWsa) };
}

/** A copy of `request` with `wsa` genuinely absent, which a spread cannot express. */
function omitWsa(request: SoapRequestDef): SoapRequestDef {
  const rest: Record<string, unknown> = { ...request };
  delete rest['wsa'];
  return rest as unknown as SoapRequestDef;
}

/** Sets (or clears, with `auth: null`) one request's own `auth`, leaving every other field alone. */
function updateRequestAuth(project: Project, requestId: string, auth: SoapOwnerAuth | null): MutationResult {
  const location = findRequest(project, requestId) ?? notFound('request', requestId);
  const { iface, operation, request } = location;
  const next: SoapRequestDef = {
    kind: request.kind,
    id: request.id,
    name: request.name,
    slug: request.slug,
    order: request.order,
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.endpointId !== undefined ? { endpointId: request.endpointId } : {}),
    ...(request.endpointUrl !== undefined ? { endpointUrl: request.endpointUrl } : {}),
    soapVersion: request.soapVersion,
    ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
    headers: request.headers,
    attachments: request.attachments,
    ...(auth !== null ? { auth } : {}),
    ...(request.wsa !== undefined ? { wsa: request.wsa } : {}),
    ...(request.wssOutgoingRef !== undefined ? { wssOutgoingRef: request.wssOutgoingRef } : {}),
    ...(request.wssIncomingRef !== undefined ? { wssIncomingRef: request.wssIncomingRef } : {}),
    properties: request.properties,
    assertions: request.assertions,
    ...(request.scripts !== undefined ? { scripts: request.scripts } : {}),
    envelopeXml: request.envelopeXml,
  };
  const requests = operation.requests.map((candidate) => (candidate.id === requestId ? next : candidate));
  return { project: replaceInterface(project, replaceOperation(iface, { ...operation, requests })) };
}

/**
 * Merges a {@link RequestPropertiesPatchWire} into a request's properties. A `null` clears an
 * optional property back to "inherit" (no value); `undefined` leaves it alone. Only the keys
 * the patch actually names are touched, so two panels editing different rows never fight.
 */
function mergeRequestProperties(current: RequestProperties, patch: RequestPropertiesPatchWire): RequestProperties {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      delete next[key];
      continue;
    }
    next[key] = value;
  }
  return next as unknown as RequestProperties;
}

function updateRequestProperties(
  project: Project,
  requestId: string,
  patch: RequestPropertiesPatchWire,
): MutationResult {
  const { iface, operation, request } = findRequest(project, requestId) ?? notFound('request', requestId);
  const next: SoapRequestDef = { ...request, properties: mergeRequestProperties(request.properties, patch) };
  const requests = operation.requests.map((candidate) => (candidate.id === requestId ? next : candidate));
  return { project: replaceInterface(project, replaceOperation(iface, { ...operation, requests })) };
}

/**
 * Media type for an attachment picked off disk, by extension. Deliberately a short table
 * rather than a `mime-db` dependency: the value is editable in the attachments table, so the
 * only job here is to guess right for the handful of formats a SOAP attachment usually is,
 * and to fall back to `application/octet-stream` — which is always a legal answer — otherwise.
 */
export function contentTypeForPath(path: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  switch (match?.[1]?.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'pdf':
      return 'application/pdf';
    case 'xml':
      return 'application/xml';
    case 'txt':
      return 'text/plain';
    case 'json':
      return 'application/json';
    case 'zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

/** The last `/`- or `\`-separated segment of `path`; the path itself when it has none. */
function basenameOf(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

/** Replaces one request inside its operation, leaving every other request untouched. */
function replaceRequest(project: Project, location: RequestLocation, next: SoapRequestDef): Project {
  const requests = location.operation.requests.map((candidate) => (candidate.id === next.id ? next : candidate));
  return replaceInterface(project, replaceOperation(location.iface, { ...location.operation, requests }));
}

/**
 * Appends one attachment to a request. The bytes are handled by {@link AddAttachmentFile}:
 * either copied into `attachments/<sha256>` (`copyToCache`, the safe default for a project
 * that will be shared) or referenced where they lie.
 */
async function addAttachment(
  project: Project,
  change: { requestId: string; path: string; copyToCache: boolean; contentType?: string | undefined },
  deps: MutationDeps,
): Promise<MutationResult> {
  // Fail before any I/O when the request is unknown; `appendAttachment` checks again after.
  if (findRequest(project, change.requestId) === undefined) {
    notFound('request', change.requestId);
  }
  if (deps.addAttachmentFile === undefined) {
    throw new ProjectError('attachment-unsupported', 'Adding an attachment needs an open project folder');
  }
  const contentType = change.contentType ?? contentTypeForPath(change.path);
  const { size, source } = await deps.addAttachmentFile({
    path: change.path,
    copyToCache: change.copyToCache,
    contentType,
  });
  return appendAttachment(project, change.requestId, {
    name: basenameOf(change.path),
    contentType,
    size,
    source,
  });
}

/**
 * Appends one already-materialised attachment to a request: the caller has resolved the bytes
 * (into the cache or to a path) and knows their size, so this is the pure half of an add.
 *
 * Shared by `add-attachment` and by `ProjectHost.addAttachmentBytes` (the drag-and-drop
 * path, where the bytes arrive over IPC and never had a path at all), so both produce exactly
 * the same model entry — same id scheme, same default Content-ID, same `UNKNOWN` type.
 */
export function appendAttachment(
  project: Project,
  requestId: string,
  input: {
    readonly name: string;
    readonly contentType: string;
    readonly size: number;
    readonly source: AttachmentSource;
  },
): MutationResult {
  const location = findRequest(project, requestId) ?? notFound('request', requestId);
  const id = generateId();
  const attachment: Attachment = {
    id,
    name: input.name,
    contentType: input.contentType,
    size: input.size,
    // Nothing has told us which WSDL part (or MTOM/SwA role) this fills yet; the inspector
    // sets both once the user picks a Part, so the model starts out honest about not knowing.
    type: 'UNKNOWN',
    contentId: defaultContentId(id),
    cached: input.source.kind === 'cache',
    source: input.source,
  };
  const next: SoapRequestDef = { ...location.request, attachments: [...location.request.attachments, attachment] };
  return { project: replaceRequest(project, location, next), createdAttachmentId: id };
}

/** Applies a renderer patch to one attachment; `part: null` clears the WSDL part binding. */
function updateAttachment(
  project: Project,
  requestId: string,
  attachmentId: string,
  patch: AttachmentPatchWire,
): MutationResult {
  const location = findRequest(project, requestId) ?? notFound('request', requestId);
  const current = location.request.attachments.find((candidate) => candidate.id === attachmentId);
  if (current === undefined) {
    notFound('attachment', attachmentId);
  }
  const part = patch.part === undefined ? current.part : (patch.part ?? undefined);
  const patched: Attachment = {
    id: current.id,
    name: patch.name ?? current.name,
    contentType: patch.contentType ?? current.contentType,
    size: current.size,
    ...(part !== undefined ? { part } : {}),
    type: patch.type ?? current.type,
    contentId: patch.contentId ?? current.contentId,
    cached: current.cached,
    source: current.source,
  };
  const attachments = location.request.attachments.map((candidate) =>
    candidate.id === attachmentId ? patched : candidate,
  );
  return { project: replaceRequest(project, location, { ...location.request, attachments }) };
}

/**
 * Drops one attachment from a request. The cached blob is deliberately left behind: a project
 * whose last reference to it was removed in an unsaved edit must survive an undo, so reclaiming
 * the space stays an explicit `pruneAttachments` the UI offers separately.
 */
function removeAttachment(project: Project, requestId: string, attachmentId: string): MutationResult {
  const location = findRequest(project, requestId) ?? notFound('request', requestId);
  const attachments = location.request.attachments.filter((candidate) => candidate.id !== attachmentId);
  if (attachments.length === location.request.attachments.length) {
    notFound('attachment', attachmentId);
  }
  return { project: replaceRequest(project, location, { ...location.request, attachments }) };
}

/** The change kinds SOAP owns. */
export const soapMutations: KindMutations = {
  'add-request': async (project, change, deps) => {
    const generated = await deps.generate(change.interfaceId, change.bindingName, change.operationName);
    return addRequest(project, {
      interfaceId: change.interfaceId,
      bindingName: change.bindingName,
      operationName: change.operationName,
      generated,
    });
  },
  'clone-request': (project, change) => cloneRequest(project, change.requestId),
  'remove-request': (project, change) => removeRequest(project, change.requestId),
  'update-request': (project, change) => updateRequest(project, change.requestId, change.patch),
  'remove-interface': (project, change) => {
    requireInterface(project, change.interfaceId);
    return {
      project: {
        ...project,
        containers: {
          ...project.containers,
          soap: soapInterfacesOf(project)
            .filter((iface) => iface.id !== change.interfaceId)
            .map((iface, index) => ({ ...iface, order: index })),
        },
      },
    };
  },
  'set-default-endpoint': (project, change) => {
    const iface = requireInterface(project, change.interfaceId);
    requireEndpoint(iface, change.endpointId);
    return { project: replaceInterface(project, { ...iface, defaultEndpointId: change.endpointId }) };
  },
  'add-endpoint': (project, change) => {
    const iface = requireInterface(project, change.interfaceId);
    const endpoint: Endpoint = { id: generateId(), name: change.name, url: change.url, authMode: 'complement' };
    const next: Interface = {
      ...iface,
      endpoints: [...iface.endpoints, endpoint],
      defaultEndpointId: iface.defaultEndpointId ?? endpoint.id,
    };
    return { project: replaceInterface(project, next) };
  },
  'update-endpoint': (project, change) => {
    const iface = requireInterface(project, change.interfaceId);
    requireEndpoint(iface, change.endpointId);
    const endpoints = iface.endpoints.map((endpoint): Endpoint => {
      if (endpoint.id !== change.endpointId) return endpoint;
      // `trustInvalid` is rebuilt rather than spread: turning it off must remove the key, not
      // persist an explicit `false`, so a project file only ever names endpoints that have it.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
      const { trustInvalid: _dropped, ...rest } = endpoint;
      const trusts = change.patch.trustInvalid ?? endpoint.trustInvalid;
      return {
        ...rest,
        name: change.patch.name ?? endpoint.name,
        url: change.patch.url ?? endpoint.url,
        authMode: change.patch.authMode ?? endpoint.authMode,
        ...(trusts === true ? { trustInvalid: true } : {}),
      };
    });
    return { project: replaceInterface(project, { ...iface, endpoints }) };
  },
  'remove-endpoint': (project, change) => {
    const iface = requireInterface(project, change.interfaceId);
    requireEndpoint(iface, change.endpointId);
    const endpoints = iface.endpoints.filter((endpoint) => endpoint.id !== change.endpointId);
    // Removing the default endpoint promotes the first survivor; with none left the field
    // is dropped entirely rather than set to an explicit `undefined`.
    const nextDefault = iface.defaultEndpointId === change.endpointId ? endpoints[0]?.id : iface.defaultEndpointId;
    return { project: replaceInterface(project, rebuiltInterface(iface, endpoints, nextDefault)) };
  },
  'update-request-wsa': (project, change) =>
    updateRequestWsa(project, change.requestId, change.wsa === null ? null : toEngineWsa(change.wsa)),
  'update-interface-wsa': (project, change) => {
    const iface = requireInterface(project, change.interfaceId);
    return { project: replaceInterface(project, { ...iface, wsa: toEngineWsa(change.wsa) }) };
  },
  'update-request-auth': (project, change) =>
    updateRequestAuth(project, change.requestId, change.auth === null ? null : toEngineAuth(change.auth)),
  'update-interface-auth': (project, change) => {
    const iface = requireInterface(project, change.interfaceId);
    const next: Interface = {
      kind: iface.kind,
      id: iface.id,
      name: iface.name,
      slug: iface.slug,
      order: iface.order,
      definitionUrl: iface.definitionUrl,
      cacheDefinition: iface.cacheDefinition,
      ...(iface.targetNamespace !== undefined ? { targetNamespace: iface.targetNamespace } : {}),
      endpoints: iface.endpoints,
      ...(iface.defaultEndpointId !== undefined ? { defaultEndpointId: iface.defaultEndpointId } : {}),
      wsa: iface.wsa,
      ...(change.auth !== null ? { auth: toEngineAuth(change.auth) } : {}),
      operations: iface.operations,
    };
    return { project: replaceInterface(project, next) };
  },
  'update-endpoint-auth': (project, change) => {
    const iface = requireInterface(project, change.interfaceId);
    requireEndpoint(iface, change.endpointId);
    const endpoints = iface.endpoints.map((endpoint): Endpoint =>
      endpoint.id === change.endpointId
        ? {
            id: endpoint.id,
            name: endpoint.name,
            url: endpoint.url,
            authMode: endpoint.authMode,
            ...(endpoint.trustInvalid === true ? { trustInvalid: true } : {}),
            ...(change.auth !== null ? { auth: toEngineAuth(change.auth) } : {}),
          }
        : endpoint,
    );
    return { project: replaceInterface(project, { ...iface, endpoints }) };
  },
  'update-request-properties': (project, change) => updateRequestProperties(project, change.requestId, change.patch),
  'update-interface': (project, change) => {
    const iface = requireInterface(project, change.interfaceId);
    return {
      project: replaceInterface(project, {
        ...iface,
        ...(change.patch.cacheDefinition !== undefined ? { cacheDefinition: change.patch.cacheDefinition } : {}),
      }),
    };
  },
  'add-attachment': (project, change, deps) => addAttachment(project, change, deps),
  'update-attachment': (project, change) =>
    updateAttachment(project, change.requestId, change.attachmentId, change.patch),
  'remove-attachment': (project, change) => removeAttachment(project, change.requestId, change.attachmentId),
  'add-wss-outgoing': (project, change) => {
    const added = addWssOutgoing(project, { ...(change.name !== undefined ? { name: change.name } : {}) });
    return { project: added.project, createdWssOutgoingId: added.configId };
  },
  'update-wss-outgoing': (project, change) => ({ project: updateWssOutgoing(project, change.configId, change.patch) }),
  'remove-wss-outgoing': (project, change) => ({ project: removeWssOutgoing(project, change.configId) }),
  'add-wss-incoming': (project, change) => {
    const added = addWssIncoming(project, { ...(change.name !== undefined ? { name: change.name } : {}) });
    return { project: added.project, createdWssIncomingId: added.configId };
  },
  'update-wss-incoming': (project, change) => ({ project: updateWssIncoming(project, change.configId, change.patch) }),
  'remove-wss-incoming': (project, change) => ({ project: removeWssIncoming(project, change.configId) }),
};
