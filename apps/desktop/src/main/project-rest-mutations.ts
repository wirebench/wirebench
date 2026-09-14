/**
 * Applying the REST half of a {@link ProjectChange} to a project model.
 *
 * Kept apart from `project-mutations.ts` — which is already long, and entirely about SOAP
 * interfaces, operations and envelopes — because the two share nothing but the `Project` they
 * return. Everything here is immutable: a change rebuilds the path from the API down to the node it
 * touched and leaves the rest of the tree by reference.
 *
 * Slugs are derived here rather than in the renderer, and made unique within their own container,
 * because the file layout is main's business (ADR-0005): two requests called `Get pet` in one folder
 * must not become one file.
 */

import { createApi, createFolder, createRestRequest, uniqueSlug } from '@wirebench/engine';
import type {
  AuthConfig,
  KeyValueEntry,
  Project,
  RestApi,
  RestBody,
  RestFolder,
  RestRequestDef,
  RestRequestSettings,
  RestServer,
} from '@wirebench/engine';
import { ProjectError } from '@wirebench/engine';
import type {
  ApiPatchWire,
  AuthConfigWire,
  KeyValueWire,
  RestBodyWire,
  RestFolderPatchWire,
  RestRequestPatchWire,
} from '../shared/wire-types.js';

/** What a mutation produced: the next model, and anything the caller has to do about it. */
export interface RestMutationResult {
  readonly project: Project;
  /** The entity the change created, so the renderer can select or open it. */
  readonly createdId?: string;
}

/** Anything that holds folders and requests: an API, or a folder inside one. */
type Container = Pick<RestApi, 'folders' | 'requests'>;

function notFound(what: string, id: string): never {
  throw new ProjectError('project-entity-not-found', `No ${what} with id ${id}`, { details: { what, id } });
}

/** The API with this id, or a clear error naming it. */
function requireApi(project: Project, apiId: string): RestApi {
  return project.apis.find((api) => api.id === apiId) ?? notFound('API', apiId);
}

function replaceApi(project: Project, next: RestApi): Project {
  return { ...project, apis: project.apis.map((api) => (api.id === next.id ? next : api)) };
}

/** Re-numbers a list so `order` is its index, which is what the explorer renders by. */
function renumber<T extends { readonly order: number }>(items: readonly T[]): T[] {
  return items.map((item, index) => ({ ...item, order: index }));
}

/** Every slug already used by a folder or request in `container`, for {@link uniqueSlug}. */
function takenSlugs(container: Container, exceptId?: string): Set<string> {
  const taken = new Set<string>();
  for (const folder of container.folders) {
    if (folder.id !== exceptId) {
      taken.add(folder.slug);
    }
  }
  for (const request of container.requests) {
    if (request.id !== exceptId) {
      taken.add(request.slug);
    }
  }
  return taken;
}

/**
 * Rebuilds `api` with `transform` applied to the container `parentId` names — the API itself when
 * `parentId` is undefined — or returns `undefined` when no such container exists.
 */
function inContainer(
  api: RestApi,
  parentId: string | undefined,
  transform: (container: Container) => Container,
): RestApi | undefined {
  if (parentId === undefined) {
    return { ...api, ...transform(api) };
  }
  const folders = mapFolder(api.folders, parentId, (folder) => ({ ...folder, ...transform(folder) }));
  return folders === undefined ? undefined : { ...api, folders };
}

/**
 * Rebuilds a folder list with `transform` applied to the folder `folderId` names, wherever it is in
 * the tree; `undefined` when it is not there at all, so a caller can tell "not found" from "found
 * and unchanged".
 */
function mapFolder(
  folders: readonly RestFolder[],
  folderId: string,
  transform: (folder: RestFolder) => RestFolder,
): RestFolder[] | undefined {
  let found = false;
  const next = folders.map((folder) => {
    if (folder.id === folderId) {
      found = true;
      return transform(folder);
    }
    const deeper = mapFolder(folder.folders, folderId, transform);
    if (deeper === undefined) {
      return folder;
    }
    found = true;
    return { ...folder, folders: deeper };
  });
  return found ? next : undefined;
}

/** Removes the folder with this id from a tree, returning the tree and the folder taken out. */
function extractFolder(
  folders: readonly RestFolder[],
  folderId: string,
): { readonly folders: RestFolder[]; readonly removed?: RestFolder } {
  let removed: RestFolder | undefined;
  const kept: RestFolder[] = [];
  for (const folder of folders) {
    if (folder.id === folderId) {
      removed = folder;
      continue;
    }
    const deeper = extractFolder(folder.folders, folderId);
    if (deeper.removed !== undefined) {
      removed = deeper.removed;
      kept.push({ ...folder, folders: renumber(deeper.folders) });
      continue;
    }
    kept.push(folder);
  }
  return { folders: kept, ...(removed !== undefined ? { removed } : {}) };
}

/** Removes the request with this id from an API, returning the API and the request taken out. */
function extractRequest(api: RestApi, requestId: string): { readonly api: RestApi; readonly removed?: RestRequestDef } {
  let removed: RestRequestDef | undefined;
  const strip = (container: Container): Container => {
    const requests: RestRequestDef[] = [];
    for (const request of container.requests) {
      if (request.id === requestId) {
        removed = request;
        continue;
      }
      requests.push(request);
    }
    return {
      requests: renumber(requests),
      folders: container.folders.map((folder) => ({ ...folder, ...strip(folder) })),
    };
  };
  const next = { ...api, ...strip(api) };
  return { api: next, ...(removed !== undefined ? { removed } : {}) };
}

/** The API that holds the request, folder or API with this id. */
function apiOwning(project: Project, nodeId: string): RestApi | undefined {
  return project.apis.find((api) => api.id === nodeId || containerHolds(api, nodeId));
}

function containerHolds(container: Container, nodeId: string): boolean {
  if (container.requests.some((request) => request.id === nodeId)) {
    return true;
  }
  return container.folders.some((folder) => folder.id === nodeId || containerHolds(folder, nodeId));
}

/** The request with this id, wherever it is in the project's APIs. */
export function findRestRequest(project: Project, requestId: string): RestRequestDef | undefined {
  const find = (container: Container): RestRequestDef | undefined =>
    container.requests.find((request) => request.id === requestId) ??
    container.folders.reduce<RestRequestDef | undefined>((found, folder) => found ?? find(folder), undefined);
  return project.apis.reduce<RestRequestDef | undefined>((found, api) => found ?? find(api), undefined);
}

/** The folder with this id, wherever it is. */
export function findRestFolder(project: Project, folderId: string): RestFolder | undefined {
  const find = (folders: readonly RestFolder[]): RestFolder | undefined => {
    for (const folder of folders) {
      if (folder.id === folderId) {
        return folder;
      }
      const deeper = find(folder.folders);
      if (deeper !== undefined) {
        return deeper;
      }
    }
    return undefined;
  };
  return project.apis.reduce<RestFolder | undefined>((found, api) => found ?? find(api.folders), undefined);
}

/**
 * The chain of credentials that apply to a request: its own, then each folder outwards, then its
 * API's. Handed to the engine's `resolveAuthChain`, which decides what `inherit` resolves to.
 */
export function authChainFor(project: Project, requestId: string): readonly (AuthConfig | undefined)[] | undefined {
  for (const api of project.apis) {
    const chain = chainWithin(api, requestId, []);
    if (chain !== undefined) {
      return [...chain, api.auth];
    }
  }
  return undefined;
}

/** The request's own auth plus each enclosing folder's, innermost first; `undefined` if not here. */
function chainWithin(
  container: Container,
  requestId: string,
  enclosing: readonly (AuthConfig | undefined)[],
): readonly (AuthConfig | undefined)[] | undefined {
  const own = container.requests.find((request) => request.id === requestId);
  if (own !== undefined) {
    return [own.auth, ...enclosing];
  }
  for (const folder of container.folders) {
    const deeper = chainWithin(folder, requestId, [folder.auth, ...enclosing]);
    if (deeper !== undefined) {
      return deeper;
    }
  }
  return undefined;
}

/** Turns a wire auth configuration into the engine's, dropping keys the sender left undefined. */
export function toEngineAuthConfig(auth: AuthConfigWire): AuthConfig {
  const entries = Object.entries(auth).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as unknown as AuthConfig;
}

/** One table row from the wire, with an absent description absent rather than undefined. */
export function toEngineRows(rows: readonly KeyValueWire[]): KeyValueEntry[] {
  return rows.map((row) => ({
    name: row.name,
    value: row.value,
    enabled: row.enabled,
    ...(row.description !== undefined ? { description: row.description } : {}),
  }));
}

/** Turns a wire body into the engine's, which differs only in that a raw body carries its text. */
export function toEngineBody(body: RestBodyWire): RestBody {
  switch (body.kind) {
    case 'raw':
      return {
        kind: 'raw',
        language: body.language,
        ...(body.contentType !== undefined ? { contentType: body.contentType } : {}),
        text: body.text,
      };
    case 'form':
      return { kind: 'form', fields: toEngineRows(body.fields) };
    case 'multipart':
      return {
        kind: 'multipart',
        parts: body.parts.map((part) =>
          part.kind === 'text'
            ? {
                kind: 'text',
                name: part.name,
                value: part.value,
                enabled: part.enabled,
                ...(part.contentType !== undefined ? { contentType: part.contentType } : {}),
              }
            : {
                kind: 'file',
                name: part.name,
                source: part.source,
                enabled: part.enabled,
                ...(part.fileName !== undefined ? { fileName: part.fileName } : {}),
                ...(part.contentType !== undefined ? { contentType: part.contentType } : {}),
              },
        ),
      };
    case 'binary':
      return { kind: 'binary', source: body.source, contentType: body.contentType };
    default:
      return { kind: 'none' };
  }
}

/** Adds an API to the project, ordered after every interface and API it already has. */
export function addApi(
  project: Project,
  input: { readonly name: string; readonly baseUrl: string },
): RestMutationResult {
  const taken = new Set([...project.apis.map((api) => api.slug), ...project.interfaces.map((iface) => iface.slug)]);
  const api = createApi(input.name, {
    slug: uniqueSlug(input.name, taken),
    baseUrl: input.baseUrl,
    order: project.interfaces.length + project.apis.length,
  });
  return { project: { ...project, apis: [...project.apis, api] }, createdId: api.id };
}

/** Applies a patch to an API. A `null` clears an optional field; an absent one leaves it alone. */
export function updateApi(project: Project, apiId: string, patch: ApiPatchWire): RestMutationResult {
  const api = requireApi(project, apiId);
  const taken = new Set([
    ...project.apis.filter((other) => other.id !== apiId).map((other) => other.slug),
    ...project.interfaces.map((iface) => iface.slug),
  ]);
  const name = patch.name ?? api.name;
  const next = {
    kind: 'rest' as const,
    id: api.id,
    name,
    // A rename moves the folder, exactly as it does for an interface or a request.
    slug: patch.name !== undefined && patch.name !== api.name ? uniqueSlug(patch.name, taken) : api.slug,
    order: api.order,
    ...(patch.description === null ? {} : { description: patch.description ?? api.description }),
    baseUrl: patch.baseUrl ?? api.baseUrl,
    servers:
      patch.servers !== undefined
        ? patch.servers.map((server) =>
            cleanUndefined<RestServer>({ url: server.url, description: server.description }),
          )
        : api.servers,
    ...(patch.auth === null
      ? {}
      : patch.auth !== undefined
        ? { auth: toEngineAuthConfig(patch.auth) }
        : api.auth !== undefined
          ? { auth: api.auth }
          : {}),
    ...(api.definition !== undefined ? { definition: api.definition } : {}),
    folders: api.folders,
    requests: api.requests,
  };
  return { project: replaceApi(project, cleanUndefined<RestApi>(next)) };
}

/**
 * Drops keys whose value ended up `undefined`, so an optional field a patch cleared is absent
 * rather than present-and-undefined — which `exactOptionalPropertyTypes` forbids, and which would
 * otherwise be written to disk as an explicit null.
 *
 * The same shape as the engine loader's `exact<T>`: the parameter type says "every field of T, or
 * undefined", and the return type is T, which is what removing the undefined ones makes it.
 */
function cleanUndefined<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Removes an API and everything in it; the saver deletes its folder and definition cache. */
export function removeApi(project: Project, apiId: string): RestMutationResult {
  requireApi(project, apiId);
  return { project: { ...project, apis: renumber(project.apis.filter((api) => api.id !== apiId)) } };
}

/** Adds a folder to an API's root or to another folder. */
export function addFolder(
  project: Project,
  input: { readonly apiId: string; readonly parentId?: string; readonly name: string },
): RestMutationResult {
  const api = requireApi(project, input.apiId);
  let createdId = '';
  const next = inContainer(api, input.parentId, (container) => {
    const folder = createFolder(input.name, {
      slug: uniqueSlug(input.name, takenSlugs(container)),
      order: container.folders.length,
    });
    createdId = folder.id;
    return { ...container, folders: [...container.folders, folder] };
  });
  if (next === undefined) {
    notFound('folder', input.parentId ?? input.apiId);
  }
  return { project: replaceApi(project, next), createdId };
}

/** Applies a patch to a folder, renaming its directory when the name changes. */
export function updateFolder(project: Project, folderId: string, patch: RestFolderPatchWire): RestMutationResult {
  const api = apiOwning(project, folderId);
  if (api === undefined) {
    notFound('folder', folderId);
  }
  // The parent decides slug uniqueness, so the rename happens where the folder lives.
  const rename = (container: Container): Container => ({
    ...container,
    folders: container.folders.map((folder) => {
      if (folder.id !== folderId) {
        return { ...folder, ...rename(folder) };
      }
      const name = patch.name ?? folder.name;
      const next = cleanUndefined<RestFolder>({
        id: folder.id,
        name,
        slug:
          patch.name !== undefined && patch.name !== folder.name
            ? uniqueSlug(patch.name, takenSlugs(container, folder.id))
            : folder.slug,
        order: folder.order,
        ...(patch.description === null ? {} : { description: patch.description ?? folder.description }),
        ...(patch.auth === null
          ? {}
          : patch.auth !== undefined
            ? { auth: toEngineAuthConfig(patch.auth) }
            : folder.auth !== undefined
              ? { auth: folder.auth }
              : {}),
        folders: folder.folders,
        requests: folder.requests,
      });
      return next;
    }),
  });
  return { project: replaceApi(project, { ...api, ...rename(api) }) };
}

/** Removes a folder and everything inside it. */
export function removeFolder(project: Project, folderId: string): RestMutationResult {
  const api = apiOwning(project, folderId);
  if (api === undefined) {
    notFound('folder', folderId);
  }
  const { folders, removed } = extractFolder(api.folders, folderId);
  if (removed === undefined) {
    notFound('folder', folderId);
  }
  return { project: replaceApi(project, { ...api, folders: renumber(folders) }) };
}

/** Adds a request to an API's root or to a folder, named `Request N` unless told otherwise. */
export function addRestRequest(
  project: Project,
  input: { readonly apiId: string; readonly parentId?: string; readonly name?: string },
): RestMutationResult {
  const api = requireApi(project, input.apiId);
  let createdId = '';
  const next = inContainer(api, input.parentId, (container) => {
    const name = input.name ?? nextRequestName(container);
    const request = createRestRequest(name, {
      slug: uniqueSlug(name, takenSlugs(container)),
      order: container.requests.length,
    });
    createdId = request.id;
    return { ...container, requests: [...container.requests, request] };
  });
  if (next === undefined) {
    notFound('folder', input.parentId ?? input.apiId);
  }
  return { project: replaceApi(project, next), createdId };
}

/** `Request 1`, `Request 2`, … skipping names the container already uses. */
function nextRequestName(container: Container): string {
  const used = new Set(container.requests.map((request) => request.name));
  for (let n = 1; ; n += 1) {
    const candidate = `Request ${String(n)}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/** Applies a patch to a REST request. Every field is optional; a rename moves its files. */
export function updateRestRequest(
  project: Project,
  requestId: string,
  patch: RestRequestPatchWire,
): RestMutationResult {
  const api = apiOwning(project, requestId);
  if (api === undefined) {
    notFound('request', requestId);
  }
  const apply = (container: Container): Container => ({
    ...container,
    requests: container.requests.map((request) => {
      if (request.id !== requestId) {
        return request;
      }
      const name = patch.name ?? request.name;
      const next = cleanUndefined<RestRequestDef>({
        kind: 'rest' as const,
        id: request.id,
        name,
        slug:
          patch.name !== undefined && patch.name !== request.name
            ? uniqueSlug(patch.name, takenSlugs(container, request.id))
            : request.slug,
        order: request.order,
        ...(patch.description === null ? {} : { description: patch.description ?? request.description }),
        method: patch.method ?? request.method,
        url: patch.url ?? request.url,
        pathParams: patch.pathParams !== undefined ? toEngineRows(patch.pathParams) : request.pathParams,
        query: patch.query !== undefined ? toEngineRows(patch.query) : request.query,
        headers: patch.headers !== undefined ? toEngineRows(patch.headers) : request.headers,
        body: patch.body !== undefined ? toEngineBody(patch.body) : request.body,
        auth: patch.auth !== undefined ? toEngineAuthConfig(patch.auth) : request.auth,
        // Settings are replaced wholesale, not merged: an absent field means *inherit*, so a
        // merge could never turn an override back off.
        settings: patch.settings !== undefined ? cleanUndefined<RestRequestSettings>(patch.settings) : request.settings,
        ...(request.orphaned === true ? { orphaned: true } : {}),
      });
      return next;
    }),
    folders: container.folders.map((folder) => ({ ...folder, ...apply(folder) })),
  });
  return { project: replaceApi(project, { ...api, ...apply(api) }) };
}

/** Removes a REST request from wherever it is. */
export function removeRestRequest(project: Project, requestId: string): RestMutationResult {
  const api = apiOwning(project, requestId);
  if (api === undefined) {
    notFound('request', requestId);
  }
  const { api: next, removed } = extractRequest(api, requestId);
  if (removed === undefined) {
    notFound('request', requestId);
  }
  return { project: replaceApi(project, next) };
}

/** Duplicates a REST request beside the original, named `<name> copy`. */
export function cloneRestRequest(project: Project, requestId: string): RestMutationResult {
  const api = apiOwning(project, requestId);
  if (api === undefined) {
    notFound('request', requestId);
  }
  let createdId = '';
  const apply = (container: Container): Container => {
    const index = container.requests.findIndex((request) => request.id === requestId);
    if (index === -1) {
      return { ...container, folders: container.folders.map((folder) => ({ ...folder, ...apply(folder) })) };
    }
    const original = container.requests[index]!;
    const name = `${original.name} copy`;
    const copy = createRestRequest(name, {
      slug: uniqueSlug(name, takenSlugs(container)),
      method: original.method,
      url: original.url,
      pathParams: original.pathParams,
      query: original.query,
      headers: original.headers,
      body: original.body,
      auth: original.auth,
      settings: original.settings,
      ...(original.description !== undefined ? { description: original.description } : {}),
    });
    createdId = copy.id;
    const requests = [...container.requests];
    requests.splice(index + 1, 0, copy);
    return { ...container, requests: renumber(requests) };
  };
  return { project: replaceApi(project, { ...api, ...apply(api) }), createdId };
}

/**
 * Moves a folder or request to a new parent at a given index.
 *
 * Both ends must be in the same API: moving between APIs would mean moving a definition-bound
 * request away from its definition, which is a copy rather than a move. A folder cannot be moved
 * into itself or its own descendant — that would detach the subtree from the tree.
 */
export function moveNode(
  project: Project,
  input: { readonly nodeId: string; readonly parentId?: string; readonly apiId?: string; readonly index: number },
): RestMutationResult {
  const api = apiOwning(project, input.nodeId);
  if (api === undefined) {
    notFound('node', input.nodeId);
  }
  if (input.apiId !== undefined && input.apiId !== api.id) {
    throw new ProjectError('project-move-across-apis', 'A request or folder cannot move to another API', {
      details: { nodeId: input.nodeId, from: api.id, to: input.apiId },
    });
  }
  if (input.parentId !== undefined && input.parentId === input.nodeId) {
    throw new ProjectError('project-move-into-self', 'A folder cannot be moved into itself', {
      details: { nodeId: input.nodeId },
    });
  }

  const folderMove = extractFolder(api.folders, input.nodeId);
  if (folderMove.removed !== undefined) {
    const moved = folderMove.removed;
    if (input.parentId !== undefined && containerHolds(moved, input.parentId)) {
      throw new ProjectError('project-move-into-self', 'A folder cannot be moved inside itself', {
        details: { nodeId: input.nodeId, parentId: input.parentId },
      });
    }
    const stripped: RestApi = { ...api, folders: renumber(folderMove.folders) };
    const next = inContainer(stripped, input.parentId, (container) => {
      const folders = [...container.folders];
      folders.splice(clamp(input.index, folders.length), 0, {
        ...moved,
        slug: uniqueSlug(moved.name, takenSlugs(container, moved.id)),
      });
      return { ...container, folders: renumber(folders) };
    });
    if (next === undefined) {
      notFound('folder', input.parentId ?? api.id);
    }
    return { project: replaceApi(project, next) };
  }

  const requestMove = extractRequest(api, input.nodeId);
  if (requestMove.removed === undefined) {
    notFound('node', input.nodeId);
  }
  const moved = requestMove.removed;
  const next = inContainer(requestMove.api, input.parentId, (container) => {
    const requests = [...container.requests];
    requests.splice(clamp(input.index, requests.length), 0, {
      ...moved,
      slug: uniqueSlug(moved.name, takenSlugs(container, moved.id)),
    });
    return { ...container, requests: renumber(requests) };
  });
  if (next === undefined) {
    notFound('folder', input.parentId ?? api.id);
  }
  return { project: replaceApi(project, next) };
}

/** Keeps an index inside a list, so a stale drag target appends rather than throwing. */
function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}
