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

import { createRequest, generateId, ProjectError, slugify, uniqueSlug } from '@wirebench/engine';
import type {
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
import { findRequest } from './project-wire.js';

/** The engine output `add-request` needs; supplied by the service, which owns the engine. */
export interface GeneratedEnvelope {
  readonly envelopeXml: string;
  readonly soapVersion: '1.1' | '1.2';
  readonly soapAction?: string;
}

/** I/O the pure reducer cannot do itself. */
export interface MutationDeps {
  /** Builds a fresh sample envelope for one operation of an already-hydrated interface. */
  readonly generate: (interfaceId: string, bindingName: string, operationName: string) => Promise<GeneratedEnvelope>;
}

/** The outcome of one change: the next model, plus any entity the change created. */
export interface MutationResult {
  readonly project: Project;
  readonly createdRequestId?: string;
  readonly createdEnvironmentId?: string;
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
  }
}

/** Derives a project's default name from its folder, matching what the Welcome screen suggests. */
export function projectNameFromDir(dir: string): string {
  const segments = dir.split(/[\\/]/).filter((segment) => segment.length > 0);
  return slugify(segments.at(-1) ?? 'Project');
}
