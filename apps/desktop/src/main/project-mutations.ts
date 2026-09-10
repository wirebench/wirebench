/**
 * Pure, immutable transformations of the engine `Project` model — one per
 * {@link ProjectChange} variant. `ProjectService` owns the I/O (generate, save, watch); this
 * module owns "what the model looks like afterwards", so every rule about naming, slugs and
 * ordering is unit-testable without a disk or an Electron app.
 *
 * Every function validates the ids it is given and throws `ProjectError('not-found')` rather
 * than silently no-op'ing, so a stale renderer mirror surfaces as an error instead of a
 * mutation that appears to succeed.
 */

import { createRequest, defaultContentId, generateId, ProjectError, slugify, uniqueSlug } from '@wirebench/engine';
import type {
  Attachment,
  AttachmentSource,
  Endpoint,
  EndpointAuth,
  Interface,
  OperationDef,
  Project,
  ProjectSettings,
  RequestDef,
  RequestProperties,
} from '@wirebench/engine';
import type {
  AttachmentPatchWire,
  ProjectChange,
  ProjectSettingsPatchWire,
  RequestPatchWire,
  RequestPropertiesPatchWire,
} from '../shared/wire-types.js';
import {
  addEnvironment,
  deleteEnvironment,
  setActiveEnvironment,
  updateEnvironment,
} from './project-environment-mutations.js';
import type { RequestLocation } from './project-wire.js';
import { findRequest } from './project-wire.js';

/** The engine output `add-request` needs; supplied by the service, which owns the engine. */
export interface GeneratedEnvelope {
  readonly envelopeXml: string;
  readonly soapVersion: '1.1' | '1.2';
  readonly soapAction?: string;
}

/**
 * Reads (and, when asked, content-addresses into the project's attachment cache) the file an
 * `add-attachment` names. Kept as a dependency so the reducer stays free of `fs`: the service
 * owns the project directory, which is the only thing that can turn a path into a cache blob.
 */
export type AddAttachmentFile = (input: {
  readonly path: string;
  readonly copyToCache: boolean;
  /** The already-resolved media type, so the cache index records the same one the model does. */
  readonly contentType: string;
}) => Promise<{ readonly size: number; readonly source: AttachmentSource }>;

/** I/O the pure reducer cannot do itself. */
export interface MutationDeps {
  /** Builds a fresh sample envelope for one operation of an already-hydrated interface. */
  readonly generate: (interfaceId: string, bindingName: string, operationName: string) => Promise<GeneratedEnvelope>;
  /** Supplied by `ProjectService` whenever a project is open; absent only in tests that never attach. */
  readonly addAttachmentFile?: AddAttachmentFile;
}

/** The outcome of one change: the next model, plus any entity the change created. */
export interface MutationResult {
  readonly project: Project;
  readonly createdRequestId?: string;
  readonly createdEnvironmentId?: string;
  readonly createdAttachmentId?: string;
}

function notFound(what: string, id: string): never {
  throw new ProjectError('not-found', `No ${what} with id "${id}"`, { details: { id } });
}

function requireInterface(project: Project, interfaceId: string): Interface {
  return project.interfaces.find((iface) => iface.id === interfaceId) ?? notFound('interface', interfaceId);
}

function replaceInterface(project: Project, next: Interface): Project {
  return { ...project, interfaces: project.interfaces.map((iface) => (iface.id === next.id ? next : iface)) };
}

function replaceOperation(iface: Interface, next: OperationDef): Interface {
  return {
    ...iface,
    operations: iface.operations.map((operation) =>
      operation.name === next.name && operation.bindingName === next.bindingName ? next : operation,
    ),
  };
}

/** `Request N` for the lowest free N within one operation. */
function nextRequestName(operation: OperationDef): string {
  const highest = operation.requests.reduce((max, request) => {
    const match = /^Request (\d+)$/.exec(request.name);
    return match?.[1] === undefined ? max : Math.max(max, Number.parseInt(match[1], 10));
  }, 0);
  return `Request ${String(highest + 1)}`;
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
function withRequest(operation: OperationDef, request: RequestDef): OperationDef {
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
  const clone: RequestDef = {
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

  const optional = <K extends 'endpointId' | 'endpointUrl' | 'soapAction' | 'description'>(
    key: K,
  ): Partial<Pick<RequestDef, K>> => {
    const value = patch[key];
    if (value === undefined) {
      return request[key] === undefined ? {} : ({ [key]: request[key] } as Pick<RequestDef, K>);
    }
    return value === null ? {} : ({ [key]: value } as Pick<RequestDef, K>);
  };

  const next: RequestDef = {
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
    headers: patch.headers ?? request.headers,
    attachments: request.attachments,
    ...(request.auth !== undefined ? { auth: request.auth } : {}),
    ...(request.wsa !== undefined ? { wsa: request.wsa } : {}),
    ...(request.wssOutgoingRef !== undefined ? { wssOutgoingRef: request.wssOutgoingRef } : {}),
    ...(request.wssIncomingRef !== undefined ? { wssIncomingRef: request.wssIncomingRef } : {}),
    properties: request.properties,
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
 * Normalises a wire `EndpointAuth` (whose zod-optional fields type as `T | undefined`) into the
 * engine's `EndpointAuth`, which under `exactOptionalPropertyTypes` requires absent keys to be
 * truly absent rather than present-with-`undefined`.
 */
function toEngineAuth(auth: {
  type: EndpointAuth['type'];
  username?: string | undefined;
  passwordRef?: string | undefined;
  domain?: string | undefined;
  preemptive?: boolean | undefined;
}): EndpointAuth {
  return {
    type: auth.type,
    ...(auth.username !== undefined ? { username: auth.username } : {}),
    ...(auth.passwordRef !== undefined ? { passwordRef: auth.passwordRef } : {}),
    ...(auth.domain !== undefined ? { domain: auth.domain } : {}),
    ...(auth.preemptive !== undefined ? { preemptive: auth.preemptive } : {}),
  };
}

/** Sets (or clears, with `auth: null`) one request's own `auth`, leaving every other field alone. */
function updateRequestAuth(project: Project, requestId: string, auth: EndpointAuth | null): MutationResult {
  const location = findRequest(project, requestId) ?? notFound('request', requestId);
  const { iface, operation, request } = location;
  const next: RequestDef = {
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
  const next: RequestDef = { ...request, properties: mergeRequestProperties(request.properties, patch) };
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
function replaceRequest(project: Project, location: RequestLocation, next: RequestDef): Project {
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
  const location = findRequest(project, change.requestId) ?? notFound('request', change.requestId);
  if (deps.addAttachmentFile === undefined) {
    throw new ProjectError('attachment-unsupported', 'Adding an attachment needs an open project folder');
  }
  const contentType = change.contentType ?? contentTypeForPath(change.path);
  const { size, source } = await deps.addAttachmentFile({
    path: change.path,
    copyToCache: change.copyToCache,
    contentType,
  });
  const id = generateId();
  const attachment: Attachment = {
    id,
    name: basenameOf(change.path),
    contentType,
    size,
    // Nothing has told us which WSDL part (or MTOM/SwA role) this fills yet; the inspector
    // sets both once the user picks a Part, so the model starts out honest about not knowing.
    type: 'UNKNOWN',
    contentId: defaultContentId(id),
    cached: source.kind === 'cache',
    source,
  };
  const next: RequestDef = { ...location.request, attachments: [...location.request.attachments, attachment] };
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

/** Merges a settings patch into the project's settings; `resourceRoot: null` clears it. */
function updateProjectSettings(project: Project, patch: ProjectSettingsPatchWire): MutationResult {
  const settings: Record<string, unknown> = { ...project.settings };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      delete settings[key];
      continue;
    }
    settings[key] = value;
  }
  return { project: { ...project, settings: settings as unknown as ProjectSettings } };
}

/** Applies one {@link ProjectChange}, returning the next model. Never mutates its input. */
export async function applyChange(
  project: Project,
  change: ProjectChange,
  deps: MutationDeps,
): Promise<MutationResult> {
  switch (change.kind) {
    case 'rename-project':
      return { project: { ...project, name: change.name } };

    case 'add-request': {
      const generated = await deps.generate(change.interfaceId, change.bindingName, change.operationName);
      return addRequest(project, {
        interfaceId: change.interfaceId,
        bindingName: change.bindingName,
        operationName: change.operationName,
        generated,
      });
    }

    case 'clone-request':
      return cloneRequest(project, change.requestId);

    case 'remove-request':
      return removeRequest(project, change.requestId);

    case 'update-request':
      return updateRequest(project, change.requestId, change.patch);

    case 'remove-interface': {
      requireInterface(project, change.interfaceId);
      return {
        project: {
          ...project,
          interfaces: project.interfaces
            .filter((iface) => iface.id !== change.interfaceId)
            .map((iface, index) => ({ ...iface, order: index })),
        },
      };
    }

    case 'set-default-endpoint': {
      const iface = requireInterface(project, change.interfaceId);
      requireEndpoint(iface, change.endpointId);
      return { project: replaceInterface(project, { ...iface, defaultEndpointId: change.endpointId }) };
    }

    case 'add-endpoint': {
      const iface = requireInterface(project, change.interfaceId);
      const endpoint: Endpoint = { id: generateId(), name: change.name, url: change.url, authMode: 'complement' };
      const next: Interface = {
        ...iface,
        endpoints: [...iface.endpoints, endpoint],
        defaultEndpointId: iface.defaultEndpointId ?? endpoint.id,
      };
      return { project: replaceInterface(project, next) };
    }

    case 'update-endpoint': {
      const iface = requireInterface(project, change.interfaceId);
      requireEndpoint(iface, change.endpointId);
      const endpoints = iface.endpoints.map((endpoint) =>
        endpoint.id === change.endpointId
          ? { ...endpoint, name: change.patch.name ?? endpoint.name, url: change.patch.url ?? endpoint.url }
          : endpoint,
      );
      return { project: replaceInterface(project, { ...iface, endpoints }) };
    }

    case 'remove-endpoint': {
      const iface = requireInterface(project, change.interfaceId);
      requireEndpoint(iface, change.endpointId);
      const endpoints = iface.endpoints.filter((endpoint) => endpoint.id !== change.endpointId);
      // Removing the default endpoint promotes the first survivor; with none left the field
      // is dropped entirely rather than set to an explicit `undefined`.
      const nextDefault = iface.defaultEndpointId === change.endpointId ? endpoints[0]?.id : iface.defaultEndpointId;
      return { project: replaceInterface(project, rebuiltInterface(iface, endpoints, nextDefault)) };
    }

    case 'update-request-auth':
      return updateRequestAuth(project, change.requestId, change.auth === null ? null : toEngineAuth(change.auth));

    case 'update-interface-auth': {
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
    }

    case 'update-endpoint-auth': {
      const iface = requireInterface(project, change.interfaceId);
      requireEndpoint(iface, change.endpointId);
      const endpoints = iface.endpoints.map((endpoint): Endpoint =>
        endpoint.id === change.endpointId
          ? {
              id: endpoint.id,
              name: endpoint.name,
              url: endpoint.url,
              authMode: endpoint.authMode,
              ...(change.auth !== null ? { auth: toEngineAuth(change.auth) } : {}),
            }
          : endpoint,
      );
      return { project: replaceInterface(project, { ...iface, endpoints }) };
    }

    case 'add-environment': {
      const added = addEnvironment(project, change.name);
      return { project: added.project, createdEnvironmentId: added.environment.id };
    }

    case 'update-environment':
      return { project: updateEnvironment(project, change.environmentId, change.patch) };

    case 'remove-environment':
      return { project: deleteEnvironment(project, change.environmentId) };

    case 'set-active-environment':
      return { project: setActiveEnvironment(project, change.environmentId) };

    case 'set-project-property':
      return { project: { ...project, properties: { ...project.properties, [change.name]: change.value } } };

    case 'remove-project-property': {
      const properties = { ...project.properties };
      delete properties[change.name];
      return { project: { ...project, properties } };
    }

    case 'update-request-properties':
      return updateRequestProperties(project, change.requestId, change.patch);

    case 'update-project-settings':
      return updateProjectSettings(project, change.patch);

    case 'update-interface': {
      const iface = requireInterface(project, change.interfaceId);
      return {
        project: replaceInterface(project, {
          ...iface,
          ...(change.patch.cacheDefinition !== undefined ? { cacheDefinition: change.patch.cacheDefinition } : {}),
        }),
      };
    }

    case 'add-attachment':
      return addAttachment(project, change, deps);

    case 'update-attachment':
      return updateAttachment(project, change.requestId, change.attachmentId, change.patch);

    case 'remove-attachment':
      return removeAttachment(project, change.requestId, change.attachmentId);
  }
}

/** Derives a project's default name from its folder, matching what the Welcome screen suggests. */
export function projectNameFromDir(dir: string): string {
  const segments = dir.split(/[\\/]/).filter((segment) => segment.length > 0);
  return slugify(segments.at(-1) ?? 'Project');
}
