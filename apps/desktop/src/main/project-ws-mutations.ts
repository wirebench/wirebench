/**
 * Applying the WebSocket fourth of a {@link ProjectChange} to a project model.
 *
 * The fourth sibling to `project-rest-mutations.ts` and `project-grpc-mutations.ts`: a WebSocket
 * API shares nothing with the other three but the `Project` it sits in and the folder tree shape.
 * Everything here is immutable and rebuilds only the path from the API down to the node it
 * touched. Slugs are derived here and made unique within their container, because the file
 * layout is main's business (ADR-0005).
 *
 * A WebSocket request additionally carries saved messages, which gRPC and REST requests do not:
 * `add-ws-message` / `update-ws-message` / `remove-ws-message` address one by `{ requestId,
 * messageId }` and slugify + de-duplicate the message name the same way a request's own name is
 * turned into a slug (`uniqueSlug`).
 */

import { createWsApi, createWsFolder, createWsRequest, createWsSavedMessage, uniqueSlug } from '@wirebench/engine';
import type {
  AuthConfig,
  Project,
  WsApi,
  WsFolder,
  WsRequestDef,
  WsRequestSettings,
  WsSavedMessage,
} from '@wirebench/engine';
import { ProjectError } from '@wirebench/engine';
import type { WsApiPatchWire, WsRequestPatchWire, RestFolderPatchWire } from '../shared/wire-types.js';
import { toEngineAuthConfig, toEngineRows } from './project-rest-mutations.js';

/** What a mutation produced: the next model, and the entity it created when it created one. */
export interface WsMutationResult {
  readonly project: Project;
  readonly createdId?: string;
}

/** Anything that holds WebSocket folders and requests: an API, or a folder inside one. */
type Container = Pick<WsApi, 'folders' | 'requests'>;

function notFound(what: string, id: string): never {
  throw new ProjectError('project-entity-not-found', `No ${what} with id ${id}`, { details: { what, id } });
}

/** The WebSocket API with this id, or a clear error naming it. */
export function requireWsApi(project: Project, apiId: string): WsApi {
  return project.wsApis.find((api) => api.id === apiId) ?? notFound('WebSocket API', apiId);
}

function replaceApi(project: Project, next: WsApi): Project {
  return { ...project, wsApis: project.wsApis.map((api) => (api.id === next.id ? next : api)) };
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

/** Every slug already used by a saved message of `request`, for {@link uniqueSlug}. */
function takenMessageSlugs(request: WsRequestDef, exceptId?: string): Set<string> {
  return new Set(request.messages.filter((message) => message.id !== exceptId).map((message) => message.slug));
}

/** Drops keys whose value ended up `undefined`, so a cleared optional is absent (see the REST arm). */
function cleanUndefined<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Every slug an API or interface already uses at the project's top level. */
function takenApiSlugs(project: Project, exceptId?: string): Set<string> {
  return new Set([
    ...project.apis.map((api) => api.slug),
    ...project.grpcApis.map((api) => api.slug),
    ...project.wsApis.filter((api) => api.id !== exceptId).map((api) => api.slug),
    ...project.interfaces.map((iface) => iface.slug),
  ]);
}

function mapFolder(
  folders: readonly WsFolder[],
  folderId: string,
  transform: (folder: WsFolder) => WsFolder,
): WsFolder[] | undefined {
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
  api: WsApi,
  parentId: string | undefined,
  transform: (container: Container) => Container,
): WsApi | undefined {
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

/** The WebSocket API holding `nodeId` (a folder or a request), if any. */
export function wsApiOwning(project: Project, nodeId: string): WsApi | undefined {
  return project.wsApis.find((api) => containerHolds(api, nodeId));
}

/** The WebSocket request with this id, wherever it is. */
export function findWsRequest(project: Project, requestId: string): WsRequestDef | undefined {
  const find = (container: Container): WsRequestDef | undefined =>
    container.requests.find((request) => request.id === requestId) ??
    container.folders.reduce<WsRequestDef | undefined>((found, folder) => found ?? find(folder), undefined);
  return project.wsApis.reduce<WsRequestDef | undefined>((found, api) => found ?? find(api), undefined);
}

/** The WebSocket folder with this id, wherever it is. */
export function findWsFolder(project: Project, folderId: string): WsFolder | undefined {
  const find = (folders: readonly WsFolder[]): WsFolder | undefined => {
    for (const folder of folders) {
      if (folder.id === folderId) return folder;
      const deeper = find(folder.folders);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  };
  return project.wsApis.reduce<WsFolder | undefined>((found, api) => found ?? find(api.folders), undefined);
}

/** The request, the API it sits in, and the folders down to it, outermost first. */
export function locateWsRequest(
  project: Project,
  requestId: string,
): { readonly api: WsApi; readonly folders: readonly WsFolder[]; readonly request: WsRequestDef } | undefined {
  const within = (
    container: Container,
    enclosing: readonly WsFolder[],
  ): { request: WsRequestDef; folders: readonly WsFolder[] } | undefined => {
    const own = container.requests.find((request) => request.id === requestId);
    if (own !== undefined) return { request: own, folders: enclosing };
    for (const folder of container.folders) {
      const deeper = within(folder, [...enclosing, folder]);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  };
  for (const api of project.wsApis) {
    const found = within(api, []);
    if (found !== undefined) return { api, ...found };
  }
  return undefined;
}

/** The chain of credentials that apply to a request: its own, each folder outwards, then the API's. */
export function wsAuthChainFor(project: Project, requestId: string): AuthConfig[] | undefined {
  const located = locateWsRequest(project, requestId);
  if (located === undefined) return undefined;
  const chain: (AuthConfig | undefined)[] = [
    located.request.auth,
    ...[...located.folders].reverse().map((folder) => folder.auth),
    located.api.auth,
  ];
  return chain.filter((entry): entry is AuthConfig => entry !== undefined);
}

/** Adds a WebSocket API, ordered after every interface and API the project already has. */
export function addWsApi(project: Project, input: { readonly name: string; readonly url?: string }): WsMutationResult {
  const api = createWsApi(input.name, {
    slug: uniqueSlug(input.name, takenApiSlugs(project)),
    ...(input.url !== undefined ? { url: input.url } : {}),
    order: project.interfaces.length + project.apis.length + project.grpcApis.length + project.wsApis.length,
  });
  return { project: { ...project, wsApis: [...project.wsApis, api] }, createdId: api.id };
}

/** Applies a patch to a WebSocket API. A `null` clears an optional field; an absent one leaves it alone. */
export function updateWsApi(project: Project, apiId: string, patch: WsApiPatchWire): WsMutationResult {
  const api = requireWsApi(project, apiId);
  const name = patch.name ?? api.name;
  const next = cleanUndefined<WsApi>({
    kind: 'websocket',
    id: api.id,
    name,
    slug:
      patch.name !== undefined && patch.name !== api.name
        ? uniqueSlug(patch.name, takenApiSlugs(project, apiId))
        : api.slug,
    order: api.order,
    ...(patch.description === null ? {} : { description: patch.description ?? api.description }),
    url: patch.url ?? api.url,
    headers: patch.headers !== undefined ? toEngineRows(patch.headers) : api.headers,
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

/** Removes a WebSocket API and everything in it. */
export function removeWsApi(project: Project, apiId: string): WsMutationResult {
  requireWsApi(project, apiId);
  return { project: { ...project, wsApis: renumber(project.wsApis.filter((api) => api.id !== apiId)) } };
}

/** Adds a folder to a WebSocket API's root or to another of its folders. */
export function addWsFolder(
  project: Project,
  input: { readonly apiId: string; readonly parentId?: string; readonly name: string },
): WsMutationResult {
  const api = requireWsApi(project, input.apiId);
  let createdId = '';
  const next = inContainer(api, input.parentId, (container) => {
    const folder = createWsFolder(input.name, {
      slug: uniqueSlug(input.name, takenSlugs(container)),
      order: container.folders.length,
    });
    createdId = folder.id;
    return { ...container, folders: [...container.folders, folder] };
  });
  if (next === undefined) notFound('folder', input.parentId ?? input.apiId);
  return { project: replaceApi(project, next), createdId };
}

/** Applies a patch to a WebSocket folder. */
export function updateWsFolder(project: Project, folderId: string, patch: RestFolderPatchWire): WsMutationResult {
  const api = wsApiOwning(project, folderId) ?? notFound('folder', folderId);
  const rename = (container: Container): Container => ({
    ...container,
    folders: container.folders.map((folder) => {
      if (folder.id !== folderId) {
        return { ...folder, ...rename(folder) };
      }
      const name = patch.name ?? folder.name;
      return cleanUndefined<WsFolder>({
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
  folders: readonly WsFolder[],
  folderId: string,
): { readonly folders: WsFolder[]; readonly removed: WsFolder | undefined } {
  let removed: WsFolder | undefined;
  const next: WsFolder[] = [];
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
  api: WsApi,
  requestId: string,
): { readonly api: WsApi; readonly removed: WsRequestDef | undefined } {
  let removed: WsRequestDef | undefined;
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

/** Removes a WebSocket folder and everything inside it. */
export function removeWsFolder(project: Project, folderId: string): WsMutationResult {
  const api = wsApiOwning(project, folderId) ?? notFound('folder', folderId);
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

/** Adds a WebSocket request to an API's root or to a folder. */
export function addWsRequest(
  project: Project,
  input: { readonly apiId: string; readonly parentId?: string; readonly name?: string; readonly url?: string },
): WsMutationResult {
  const api = requireWsApi(project, input.apiId);
  let createdId = '';
  const next = inContainer(api, input.parentId, (container) => {
    const name = input.name ?? nextRequestName(container);
    const request = createWsRequest(name, {
      slug: uniqueSlug(name, takenSlugs(container)),
      order: container.requests.length,
      ...(input.url !== undefined ? { url: input.url } : {}),
    });
    createdId = request.id;
    return { ...container, requests: [...container.requests, request] };
  });
  if (next === undefined) notFound('folder', input.parentId ?? input.apiId);
  return { project: replaceApi(project, next), createdId };
}

/** Settings from the wire, with the keys the sender left undefined dropped (they mean *inherit*). */
export function cleanWsSettings(settings: NonNullable<WsRequestPatchWire['settings']>): WsRequestSettings {
  return cleanUndefined<WsRequestSettings>(settings);
}

/** The saved request with a patch applied — what the editor is looking at, for this send or update. */
export function withWsPatch(request: WsRequestDef, patch?: WsRequestPatchWire): WsRequestDef {
  if (patch === undefined) return request;
  return cleanUndefined<WsRequestDef>({
    ...request,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description === null
      ? { description: undefined }
      : patch.description !== undefined
        ? { description: patch.description }
        : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.query !== undefined ? { query: toEngineRows(patch.query) } : {}),
    ...(patch.headers !== undefined ? { headers: toEngineRows(patch.headers) } : {}),
    ...(patch.subprotocols !== undefined ? { subprotocols: [...patch.subprotocols] } : {}),
    ...(patch.auth !== undefined ? { auth: toEngineAuthConfig(patch.auth) } : {}),
    ...(patch.settings !== undefined ? { settings: cleanWsSettings(patch.settings) } : {}),
    // Reordering saved messages is done through this patch with a full `messages` list, which
    // REPLACES the request's list wholesale — the same rule tables and settings follow.
    ...(patch.messages !== undefined ? { messages: slugMessages(request, patch.messages) } : {}),
  });
}

/**
 * The patch's messages with main's slugs. A message the request already has keeps its slug (its
 * file stays where it is, even across a rename); a new one is slugged from its name with the
 * engine's `uniqueSlug`, which compares case-insensitively — `Ping` and `ping` would otherwise be
 * the same file on macOS and Windows. The renderer's own slug is ignored: it is only a hint.
 */
function slugMessages(request: WsRequestDef, incoming: NonNullable<WsRequestPatchWire['messages']>): WsSavedMessage[] {
  const existing = new Map(request.messages.map((message) => [message.id, message.slug]));
  const taken = new Set<string>();
  for (const message of incoming) {
    const kept = existing.get(message.id);
    if (kept !== undefined) taken.add(kept);
  }
  return incoming.map((message) => {
    const kept = existing.get(message.id);
    const slug = kept ?? uniqueSlug(message.name, taken);
    taken.add(slug);
    return { ...toEngineMessage(message), slug };
  });
}

function toEngineMessage(
  message: WsRequestPatchWire['messages'] extends readonly (infer M)[] | undefined ? M : never,
): WsSavedMessage {
  return { id: message.id, name: message.name, slug: message.slug, format: message.format, content: message.content };
}

/** Applies a patch to a WebSocket request. */
export function updateWsRequest(project: Project, requestId: string, patch: WsRequestPatchWire): WsMutationResult {
  const api = wsApiOwning(project, requestId) ?? notFound('request', requestId);
  const apply = (container: Container): Container => ({
    ...container,
    requests: container.requests.map((request) => {
      if (request.id !== requestId) return request;
      const next = withWsPatch(request, patch);
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

/** Removes a WebSocket request from wherever it is. */
export function removeWsRequest(project: Project, requestId: string): WsMutationResult {
  const api = wsApiOwning(project, requestId) ?? notFound('request', requestId);
  const { api: next, removed } = extractRequest(api, requestId);
  if (removed === undefined) notFound('request', requestId);
  return { project: replaceApi(project, next) };
}

/** Duplicates a WebSocket request beside the original, named `<name> copy`, with fresh ids throughout. */
export function cloneWsRequest(project: Project, requestId: string): WsMutationResult {
  const api = wsApiOwning(project, requestId) ?? notFound('request', requestId);
  let createdId = '';
  const apply = (container: Container): Container => {
    const index = container.requests.findIndex((request) => request.id === requestId);
    if (index === -1) {
      return { ...container, folders: container.folders.map((folder) => ({ ...folder, ...apply(folder) })) };
    }
    const original = container.requests[index]!;
    const name = `${original.name} copy`;
    const copy = createWsRequest(name, {
      slug: uniqueSlug(name, takenSlugs(container)),
      url: original.url,
      query: original.query,
      headers: original.headers,
      subprotocols: original.subprotocols,
      auth: original.auth,
      settings: original.settings,
      messages: original.messages.map((message) =>
        createWsSavedMessage(message.name, { slug: message.slug, format: message.format, content: message.content }),
      ),
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

/** Moves a WebSocket folder or request to a new parent at an index, inside its own API only. */
export function moveWsNode(
  project: Project,
  input: { readonly nodeId: string; readonly parentId?: string; readonly index: number },
): WsMutationResult {
  const api = wsApiOwning(project, input.nodeId) ?? notFound('node', input.nodeId);
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
    const stripped: WsApi = { ...api, folders: renumber(folderMove.folders) };
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

// ——— saved messages ————————————————————————————————————————————————————————————————————————

/** Applies `transform` to the request with `requestId`, wherever it sits in its owning API. */
function withRequest(api: WsApi, requestId: string, transform: (request: WsRequestDef) => WsRequestDef): WsApi {
  const apply = (container: Container): Container => ({
    ...container,
    requests: container.requests.map((request) => (request.id === requestId ? transform(request) : request)),
    folders: container.folders.map((folder) => ({ ...folder, ...apply(folder) })),
  });
  return { ...api, ...apply(api) };
}

/** Adds a saved message to a WebSocket request, de-duplicating its slug within that request. */
export function addWsMessage(
  project: Project,
  input: {
    readonly requestId: string;
    readonly name: string;
    readonly format?: 'text' | 'binary';
    readonly content?: string;
  },
): WsMutationResult {
  const api = wsApiOwning(project, input.requestId) ?? notFound('request', input.requestId);
  const request = findWsRequest(project, input.requestId) ?? notFound('request', input.requestId);
  const message = createWsSavedMessage(input.name, {
    slug: uniqueSlug(input.name, takenMessageSlugs(request)),
    ...(input.format !== undefined ? { format: input.format } : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
  });
  const next = withRequest(api, input.requestId, (current) => ({
    ...current,
    messages: [...current.messages, message],
  }));
  return { project: replaceApi(project, next), createdId: message.id };
}

/** Applies a patch to one saved message; a renamed message re-slugs, de-duplicated as on add. */
export function updateWsMessage(
  project: Project,
  input: {
    readonly requestId: string;
    readonly messageId: string;
    readonly patch: { readonly name?: string; readonly format?: 'text' | 'binary'; readonly content?: string };
  },
): WsMutationResult {
  const api = wsApiOwning(project, input.requestId) ?? notFound('request', input.requestId);
  const request = findWsRequest(project, input.requestId) ?? notFound('request', input.requestId);
  const message =
    request.messages.find((candidate) => candidate.id === input.messageId) ?? notFound('message', input.messageId);
  const name = input.patch.name ?? message.name;
  const nextMessage: WsSavedMessage = {
    id: message.id,
    name,
    slug:
      input.patch.name !== undefined && input.patch.name !== message.name
        ? uniqueSlug(name, takenMessageSlugs(request, message.id))
        : message.slug,
    format: input.patch.format ?? message.format,
    content: input.patch.content ?? message.content,
  };
  const next = withRequest(api, input.requestId, (current) => ({
    ...current,
    messages: current.messages.map((candidate) => (candidate.id === input.messageId ? nextMessage : candidate)),
  }));
  return { project: replaceApi(project, next) };
}

/** Removes one saved message from a WebSocket request. */
export function removeWsMessage(
  project: Project,
  input: { readonly requestId: string; readonly messageId: string },
): WsMutationResult {
  const api = wsApiOwning(project, input.requestId) ?? notFound('request', input.requestId);
  const request = findWsRequest(project, input.requestId) ?? notFound('request', input.requestId);
  if (!request.messages.some((message) => message.id === input.messageId)) {
    notFound('message', input.messageId);
  }
  const next = withRequest(api, input.requestId, (current) => ({
    ...current,
    messages: current.messages.filter((message) => message.id !== input.messageId),
  }));
  return { project: replaceApi(project, next) };
}
