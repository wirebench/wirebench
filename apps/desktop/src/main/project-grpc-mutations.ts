/**
 * Applying the gRPC third of a {@link ProjectChange} to a project model.
 *
 * The REST arm's sibling (`project-rest-mutations.ts`), for the same reason that one is kept apart
 * from the SOAP mutations: a gRPC API shares nothing with a REST one but the `Project` it sits in
 * and the folder tree shape. Everything here is immutable and rebuilds only the path from the API
 * down to the node it touched. Slugs are derived here and made unique within their container,
 * because the file layout is main's business (ADR-0005).
 */

import { createGrpcApi, createGrpcFolder, createGrpcRequest, defaultTlsFor, uniqueSlug } from '@wirebench/engine';
import type { AuthConfig, GrpcApi, GrpcFolder, GrpcRequestDef, GrpcRequestSettings, Project } from '@wirebench/engine';
import { ProjectError } from '@wirebench/engine';
import type { GrpcApiPatchWire, GrpcRequestPatchWire, RestFolderPatchWire } from '../shared/wire-types.js';
import { toEngineAuthConfig, toEngineRows } from './project-rest-mutations.js';

/** What a mutation produced: the next model, and the entity it created when it created one. */
export interface GrpcMutationResult {
  readonly project: Project;
  readonly createdId?: string;
}

/** Anything that holds gRPC folders and requests: an API, or a folder inside one. */
type Container = Pick<GrpcApi, 'folders' | 'requests'>;

function notFound(what: string, id: string): never {
  throw new ProjectError('project-entity-not-found', `No ${what} with id ${id}`, { details: { what, id } });
}

/** The gRPC API with this id, or a clear error naming it. */
export function requireGrpcApi(project: Project, apiId: string): GrpcApi {
  return project.grpcApis.find((api) => api.id === apiId) ?? notFound('gRPC API', apiId);
}

function replaceApi(project: Project, next: GrpcApi): Project {
  return { ...project, grpcApis: project.grpcApis.map((api) => (api.id === next.id ? next : api)) };
}

function renumber<T extends { readonly order: number }>(items: readonly T[]): T[] {
  return items.map((item, index) => ({ ...item, order: index }));
}

/** Every slug already used by a folder or request in `container`, for {@link uniqueSlug}. */
function takenSlugs(container: Container, exceptId?: string): Set<string> {
  const taken = new Set<string>();
  for (const folder of container.folders) {
    if (folder.id !== exceptId) taken.add(folder.slug);
  }
  for (const request of container.requests) {
    if (request.id !== exceptId) taken.add(request.slug);
  }
  return taken;
}

/** Drops keys whose value ended up `undefined`, so a cleared optional is absent (see the REST arm). */
function cleanUndefined<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Every slug an API or interface already uses at the project's top level. */
function takenApiSlugs(project: Project, exceptId?: string): Set<string> {
  return new Set([
    ...project.apis.map((api) => api.slug),
    ...project.grpcApis.filter((api) => api.id !== exceptId).map((api) => api.slug),
    ...project.interfaces.map((iface) => iface.slug),
  ]);
}

function mapFolder(
  folders: readonly GrpcFolder[],
  folderId: string,
  transform: (folder: GrpcFolder) => GrpcFolder,
): GrpcFolder[] | undefined {
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

/** Rebuilds `api` with `transform` applied to the container `parentId` names, or the API itself. */
function inContainer(
  api: GrpcApi,
  parentId: string | undefined,
  transform: (container: Container) => Container,
): GrpcApi | undefined {
  if (parentId === undefined) {
    return { ...api, ...transform(api) };
  }
  const folders = mapFolder(api.folders, parentId, (folder) => ({ ...folder, ...transform(folder) }));
  return folders === undefined ? undefined : { ...api, folders };
}

function containerHolds(container: Container, nodeId: string): boolean {
  if (container.requests.some((request) => request.id === nodeId)) {
    return true;
  }
  return container.folders.some((folder) => folder.id === nodeId || containerHolds(folder, nodeId));
}

/** The gRPC API holding `nodeId` (a folder or a request), if any. */
export function grpcApiOwning(project: Project, nodeId: string): GrpcApi | undefined {
  return project.grpcApis.find((api) => containerHolds(api, nodeId));
}

/** The gRPC request with this id, wherever it is. */
export function findGrpcRequest(project: Project, requestId: string): GrpcRequestDef | undefined {
  const find = (container: Container): GrpcRequestDef | undefined =>
    container.requests.find((request) => request.id === requestId) ??
    container.folders.reduce<GrpcRequestDef | undefined>((found, folder) => found ?? find(folder), undefined);
  return project.grpcApis.reduce<GrpcRequestDef | undefined>((found, api) => found ?? find(api), undefined);
}

/** The gRPC folder with this id, wherever it is. */
export function findGrpcFolder(project: Project, folderId: string): GrpcFolder | undefined {
  const find = (folders: readonly GrpcFolder[]): GrpcFolder | undefined => {
    for (const folder of folders) {
      if (folder.id === folderId) return folder;
      const deeper = find(folder.folders);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  };
  return project.grpcApis.reduce<GrpcFolder | undefined>((found, api) => found ?? find(api.folders), undefined);
}

/** The request, the API it sits in, and the names of the folders down to it, outermost first. */
export function locateGrpcRequest(
  project: Project,
  requestId: string,
): { readonly api: GrpcApi; readonly request: GrpcRequestDef; readonly folders: readonly GrpcFolder[] } | undefined {
  const within = (
    container: Container,
    enclosing: readonly GrpcFolder[],
  ): { request: GrpcRequestDef; folders: readonly GrpcFolder[] } | undefined => {
    const own = container.requests.find((request) => request.id === requestId);
    if (own !== undefined) return { request: own, folders: enclosing };
    for (const folder of container.folders) {
      const deeper = within(folder, [...enclosing, folder]);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  };
  for (const api of project.grpcApis) {
    const found = within(api, []);
    if (found !== undefined) return { api, ...found };
  }
  return undefined;
}

/** The chain of credentials that apply to a request: its own, each folder outwards, then the API's. */
export function grpcAuthChainFor(project: Project, requestId: string): readonly (AuthConfig | undefined)[] | undefined {
  const located = locateGrpcRequest(project, requestId);
  if (located === undefined) return undefined;
  return [located.request.auth, ...[...located.folders].reverse().map((folder) => folder.auth), located.api.auth];
}

/** Adds a gRPC API, ordered after every interface and API the project already has. */
export function addGrpcApi(
  project: Project,
  input: { readonly name: string; readonly target: string; readonly tls?: boolean },
): GrpcMutationResult {
  const api = createGrpcApi(input.name, {
    slug: uniqueSlug(input.name, takenApiSlugs(project)),
    target: input.target,
    ...(input.tls !== undefined ? { tls: input.tls } : {}),
    order: project.interfaces.length + project.apis.length + project.grpcApis.length,
  });
  return { project: { ...project, grpcApis: [...project.grpcApis, api] }, createdId: api.id };
}

/** Applies a patch to a gRPC API. A `null` clears an optional field; an absent one leaves it alone. */
export function updateGrpcApi(project: Project, apiId: string, patch: GrpcApiPatchWire): GrpcMutationResult {
  const api = requireGrpcApi(project, apiId);
  const name = patch.name ?? api.name;
  const target = patch.target ?? api.target;
  const next = cleanUndefined<GrpcApi>({
    kind: 'grpc',
    id: api.id,
    name,
    slug:
      patch.name !== undefined && patch.name !== api.name
        ? uniqueSlug(patch.name, takenApiSlugs(project, apiId))
        : api.slug,
    order: api.order,
    ...(patch.description === null ? {} : { description: patch.description ?? api.description }),
    target,
    // A target whose scheme decides TLS overrides the flag; otherwise the flag is what the user set.
    tls:
      patch.tls ??
      (patch.target !== undefined && /^[a-z]+:\/\//i.test(patch.target) ? defaultTlsFor(patch.target) : api.tls),
    metadata: patch.metadata !== undefined ? toEngineRows(patch.metadata) : api.metadata,
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
  });
  return { project: replaceApi(project, next) };
}

/** Removes a gRPC API and everything in it; the saver deletes its folder and definition cache. */
export function removeGrpcApi(project: Project, apiId: string): GrpcMutationResult {
  requireGrpcApi(project, apiId);
  return { project: { ...project, grpcApis: renumber(project.grpcApis.filter((api) => api.id !== apiId)) } };
}

/** Adds a folder to a gRPC API's root or to another of its folders. */
export function addGrpcFolder(
  project: Project,
  input: { readonly apiId: string; readonly parentId?: string; readonly name: string },
): GrpcMutationResult {
  const api = requireGrpcApi(project, input.apiId);
  let createdId = '';
  const next = inContainer(api, input.parentId, (container) => {
    const folder = createGrpcFolder(input.name, {
      slug: uniqueSlug(input.name, takenSlugs(container)),
      order: container.folders.length,
    });
    createdId = folder.id;
    return { ...container, folders: [...container.folders, folder] };
  });
  if (next === undefined) notFound('folder', input.parentId ?? input.apiId);
  return { project: replaceApi(project, next), createdId };
}

/** Applies a patch to a gRPC folder, renaming its directory when the name changes. */
export function updateGrpcFolder(project: Project, folderId: string, patch: RestFolderPatchWire): GrpcMutationResult {
  const api = grpcApiOwning(project, folderId) ?? notFound('folder', folderId);
  const rename = (container: Container): Container => ({
    ...container,
    folders: container.folders.map((folder) => {
      if (folder.id !== folderId) {
        return { ...folder, ...rename(folder) };
      }
      const name = patch.name ?? folder.name;
      return cleanUndefined<GrpcFolder>({
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
    }),
  });
  return { project: replaceApi(project, { ...api, ...rename(api) }) };
}

function extractFolder(
  folders: readonly GrpcFolder[],
  folderId: string,
): { readonly folders: GrpcFolder[]; readonly removed: GrpcFolder | undefined } {
  let removed: GrpcFolder | undefined;
  const next: GrpcFolder[] = [];
  for (const folder of folders) {
    if (folder.id === folderId) {
      removed = folder;
      continue;
    }
    const deeper = extractFolder(folder.folders, folderId);
    if (deeper.removed !== undefined) {
      removed = deeper.removed;
      next.push({ ...folder, folders: renumber(deeper.folders) });
    } else {
      next.push(folder);
    }
  }
  return { folders: next, removed };
}

function extractRequest(
  api: GrpcApi,
  requestId: string,
): { readonly api: GrpcApi; readonly removed: GrpcRequestDef | undefined } {
  let removed: GrpcRequestDef | undefined;
  const strip = (container: Container): Container => {
    const own = container.requests.find((request) => request.id === requestId);
    if (own !== undefined) {
      removed = own;
      return { ...container, requests: renumber(container.requests.filter((request) => request.id !== requestId)) };
    }
    return { ...container, folders: container.folders.map((folder) => ({ ...folder, ...strip(folder) })) };
  };
  return { api: { ...api, ...strip(api) }, removed };
}

/** Removes a gRPC folder and everything inside it. */
export function removeGrpcFolder(project: Project, folderId: string): GrpcMutationResult {
  const api = grpcApiOwning(project, folderId) ?? notFound('folder', folderId);
  const { folders, removed } = extractFolder(api.folders, folderId);
  if (removed === undefined) notFound('folder', folderId);
  return { project: replaceApi(project, { ...api, folders: renumber(folders) }) };
}

/** `Request 1`, `Request 2`, … skipping names the container already uses. */
function nextRequestName(container: Container): string {
  const used = new Set(container.requests.map((request) => request.name));
  for (let n = 1; ; n += 1) {
    const candidate = `Request ${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Adds a gRPC request to an API's root or to a folder. */
export function addGrpcRequest(
  project: Project,
  input: {
    readonly apiId: string;
    readonly parentId?: string;
    readonly name?: string;
    readonly service?: string;
    readonly method?: string;
    readonly methodKind?: GrpcRequestDef['methodKind'];
    readonly message?: string;
  },
): GrpcMutationResult {
  const api = requireGrpcApi(project, input.apiId);
  let createdId = '';
  const next = inContainer(api, input.parentId, (container) => {
    const name =
      input.name ?? (input.method !== undefined && input.method !== '' ? input.method : nextRequestName(container));
    const request = createGrpcRequest(name, {
      slug: uniqueSlug(name, takenSlugs(container)),
      order: container.requests.length,
      ...(input.service !== undefined ? { service: input.service } : {}),
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.methodKind !== undefined ? { methodKind: input.methodKind } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
    });
    createdId = request.id;
    return { ...container, requests: [...container.requests, request] };
  });
  if (next === undefined) notFound('folder', input.parentId ?? input.apiId);
  return { project: replaceApi(project, next), createdId };
}

/** Settings from the wire, with the keys the sender left undefined dropped (they mean *inherit*). */
export function cleanGrpcSettings(settings: NonNullable<GrpcRequestPatchWire['settings']>): GrpcRequestSettings {
  return cleanUndefined<GrpcRequestSettings>(settings);
}

/** The saved request with a patch applied — what the editor is looking at, for this send or update. */
export function withGrpcPatch(request: GrpcRequestDef, patch: GrpcRequestPatchWire | undefined): GrpcRequestDef {
  if (patch === undefined) return request;
  return cleanUndefined<GrpcRequestDef>({
    ...request,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description === null
      ? { description: undefined }
      : patch.description !== undefined
        ? { description: patch.description }
        : {}),
    ...(patch.service !== undefined ? { service: patch.service } : {}),
    ...(patch.method !== undefined ? { method: patch.method } : {}),
    ...(patch.methodKind !== undefined ? { methodKind: patch.methodKind } : {}),
    ...(patch.metadata !== undefined ? { metadata: toEngineRows(patch.metadata) } : {}),
    ...(patch.message !== undefined ? { message: patch.message } : {}),
    ...(patch.auth !== undefined ? { auth: toEngineAuthConfig(patch.auth) } : {}),
    ...(patch.settings !== undefined ? { settings: cleanGrpcSettings(patch.settings) } : {}),
  });
}

/** Applies a patch to a gRPC request. A rename moves its files. */
export function updateGrpcRequest(
  project: Project,
  requestId: string,
  patch: GrpcRequestPatchWire,
): GrpcMutationResult {
  const api = grpcApiOwning(project, requestId) ?? notFound('request', requestId);
  const apply = (container: Container): Container => ({
    ...container,
    requests: container.requests.map((request) => {
      if (request.id !== requestId) return request;
      const next = withGrpcPatch(request, patch);
      return {
        ...next,
        slug:
          patch.name !== undefined && patch.name !== request.name
            ? uniqueSlug(patch.name, takenSlugs(container, request.id))
            : request.slug,
      };
    }),
    folders: container.folders.map((folder) => ({ ...folder, ...apply(folder) })),
  });
  return { project: replaceApi(project, { ...api, ...apply(api) }) };
}

/** Removes a gRPC request from wherever it is. */
export function removeGrpcRequest(project: Project, requestId: string): GrpcMutationResult {
  const api = grpcApiOwning(project, requestId) ?? notFound('request', requestId);
  const { api: next, removed } = extractRequest(api, requestId);
  if (removed === undefined) notFound('request', requestId);
  return { project: replaceApi(project, next) };
}

/** Duplicates a gRPC request beside the original, named `<name> copy`. */
export function cloneGrpcRequest(project: Project, requestId: string): GrpcMutationResult {
  const api = grpcApiOwning(project, requestId) ?? notFound('request', requestId);
  let createdId = '';
  const apply = (container: Container): Container => {
    const index = container.requests.findIndex((request) => request.id === requestId);
    if (index === -1) {
      return { ...container, folders: container.folders.map((folder) => ({ ...folder, ...apply(folder) })) };
    }
    const original = container.requests[index]!;
    const name = `${original.name} copy`;
    const copy = createGrpcRequest(name, {
      slug: uniqueSlug(name, takenSlugs(container)),
      service: original.service,
      method: original.method,
      methodKind: original.methodKind,
      metadata: original.metadata,
      message: original.message,
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

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

/** Moves a gRPC folder or request to a new parent at an index, inside its own API only. */
export function moveGrpcNode(
  project: Project,
  input: { readonly nodeId: string; readonly parentId?: string; readonly index: number },
): GrpcMutationResult {
  const api = grpcApiOwning(project, input.nodeId) ?? notFound('node', input.nodeId);
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
    const stripped: GrpcApi = { ...api, folders: renumber(folderMove.folders) };
    const next = inContainer(stripped, input.parentId, (container) => {
      const folders = [...container.folders];
      folders.splice(clamp(input.index, folders.length), 0, {
        ...moved,
        slug: uniqueSlug(moved.name, takenSlugs(container, moved.id)),
      });
      return { ...container, folders: renumber(folders) };
    });
    if (next === undefined) notFound('folder', input.parentId ?? api.id);
    return { project: replaceApi(project, next) };
  }
  const requestMove = extractRequest(api, input.nodeId);
  if (requestMove.removed === undefined) notFound('node', input.nodeId);
  const moved = requestMove.removed;
  const next = inContainer(requestMove.api, input.parentId, (container) => {
    const requests = [...container.requests];
    requests.splice(clamp(input.index, requests.length), 0, {
      ...moved,
      slug: uniqueSlug(moved.name, takenSlugs(container, moved.id)),
    });
    return { ...container, requests: renumber(requests) };
  });
  if (next === undefined) notFound('folder', input.parentId ?? api.id);
  return { project: replaceApi(project, next) };
}
