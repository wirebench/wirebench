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

import {
  createApi,
  createFolder,
  createRestRequest,
  grpcApisOf,
  nextApiOrder,
  ProjectError,
  restApisOf,
  signatureSchemeSchema,
  takenContainerSlugs,
  toSignatureScheme,
  uniqueSlug,
  wsApisOf,
} from '@wirebench/engine';
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
  WebhookCollection,
  WebhookFolder,
  WebhookSigning,
} from '@wirebench/engine';
import type {
  ApiPatchWire,
  AuthConfigWire,
  KeyValueWire,
  RestBodyWire,
  RestFolderPatchWire,
  RestRequestPatchWire,
  WebhookSigningWire,
} from '../shared/wire-types.js';

/** What a mutation produced: the next model, and anything the caller has to do about it. */
export interface RestMutationResult {
  readonly project: Project;
  /** The entity the change created, so the renderer can select or open it. */
  readonly createdId?: string;
}

/** Anything that holds folders and requests: an API, or a folder inside one. */
export type Container = Pick<RestApi, 'folders' | 'requests'>;

/**
 * An API, or the project's single webhook collection — the two containers a request or folder
 * can live directly in. A collection has no `id`, `slug` or `kind` of its own (there is one per
 * project, addressed on the wire by the synthetic `webhooks:<projectId>`), so it is told apart
 * from an API by the absence of `kind` rather than by comparing ids.
 */
export type RestTreeOwner = RestApi | WebhookCollection;

function isWebhookOwner(owner: RestTreeOwner): owner is WebhookCollection {
  return !('kind' in owner);
}

function replaceRestTreeOwner(project: Project, owner: RestTreeOwner, next: RestTreeOwner): Project {
  return isWebhookOwner(owner)
    ? { ...project, webhooks: next as WebhookCollection }
    : replaceApi(project, next as RestApi);
}

/** The API, or the project's webhook collection, that holds the request/folder with this id. */
function restTreeOwnerOf(project: Project, nodeId: string): RestTreeOwner | undefined {
  return (
    restApiOwning(project, nodeId) ??
    (project.webhooks !== undefined && containerHolds(project.webhooks, nodeId) ? project.webhooks : undefined)
  );
}

/**
 * Runs `edit` against whichever REST tree holds `nodeId` — an API, or the project's webhook
 * collection, which a folder or request belongs to exactly the same way an API's does — and
 * writes the result back to the right place. `what` names the entity for the not-found error
 * when neither has it.
 */
export function withRestTreeOwning(
  project: Project,
  nodeId: string,
  what: string,
  edit: (owner: RestTreeOwner) => RestTreeOwner,
): Project {
  const owner = restTreeOwnerOf(project, nodeId);
  if (owner === undefined) {
    notFound(what, nodeId);
  }
  return replaceRestTreeOwner(project, owner, edit(owner));
}

/**
 * Places a folder or request inside whichever REST tree owns it — an API, or the project's
 * webhook collection — at `parentId` (a folder in that same tree, or its root when absent).
 * `undefined` when `parentId` names no folder there at all.
 */
export function inRestTreeContainer<O extends RestTreeOwner>(
  owner: O,
  parentId: string | undefined,
  transform: (container: Container) => Container,
): O | undefined {
  if (parentId === undefined) {
    return { ...owner, ...transform(owner) };
  }
  const folders = mapFolder(owner.folders, parentId, (folder) => ({ ...folder, ...transform(folder) }));
  return folders === undefined ? undefined : { ...owner, folders };
}

export function notFound(what: string, id: string): never {
  throw new ProjectError('project-entity-not-found', `No ${what} with id ${id}`, { details: { what, id } });
}

/** The API with this id, or a clear error naming it. */
function requireApi(project: Project, apiId: string): RestApi {
  return restApisOf(project).find((api) => api.id === apiId) ?? notFound('API', apiId);
}

function replaceApi(project: Project, next: RestApi): Project {
  return {
    ...project,
    containers: { ...project.containers, rest: restApisOf(project).map((api) => (api.id === next.id ? next : api)) },
  };
}

/** Re-numbers a list so `order` is its index, which is what the explorer renders by. */
export function renumber<T extends { readonly order: number }>(items: readonly T[]): T[] {
  return items.map((item, index) => ({ ...item, order: index }));
}

/** Every slug already used by a folder or request in `container`, for {@link uniqueSlug}. */
export function takenSlugs(container: Container, exceptId?: string): Set<string> {
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
export function mapFolder(
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

/**
 * Removes the request with this id from a REST tree — an API, or the webhook collection —
 * returning the tree and the request taken out.
 */
function extractRequestFrom<O extends RestTreeOwner>(
  owner: O,
  requestId: string,
): { readonly owner: O; readonly removed?: RestRequestDef } {
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
  const next = { ...owner, ...strip(owner) };
  return { owner: next, ...(removed !== undefined ? { removed } : {}) };
}

/** The API that holds the request, folder or API with this id. */
export function restApiOwning(project: Project, nodeId: string): RestApi | undefined {
  return restApisOf(project).find((api) => api.id === nodeId || containerHolds(api, nodeId));
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
  return restApisOf(project).reduce<RestRequestDef | undefined>((found, api) => found ?? find(api), undefined);
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
  return restApisOf(project).reduce<RestFolder | undefined>((found, api) => found ?? find(api.folders), undefined);
}

/**
 * The chain of credentials that apply to a request: its own, then each folder outwards, then its
 * API's. Handed to the engine's `resolveAuthChain`, which decides what `inherit` resolves to.
 */
export function authChainFor(project: Project, requestId: string): readonly (AuthConfig | undefined)[] | undefined {
  for (const api of restApisOf(project)) {
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

/** What the project file schema accepts as a CI secret name (`WIREBENCH_SECRET_<name>`). */
const SECRET_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * A wire signing as the engine's (webhook-signatures §5.1). The scheme is re-parsed with the
 * engine's schema, which applies the tolerance default and the header-name rule the files enforce,
 * and the CI name is held to the file schema's pattern: main never saves what the loader would
 * then refuse, which would leave the project unloadable.
 *
 * @throws ProjectError `webhook-signing-invalid`
 */
export function toEngineSigning(wire: WebhookSigningWire): WebhookSigning {
  if (wire.mode === 'none') {
    return { mode: 'none' };
  }
  const parsed = signatureSchemeSchema.safeParse(wire.scheme);
  if (!parsed.success) {
    throw new ProjectError('webhook-signing-invalid', 'The signing scheme is not valid', {
      details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
    });
  }
  const secretEnv = wire.secretEnv !== undefined && wire.secretEnv !== '' ? wire.secretEnv : undefined;
  if (secretEnv !== undefined && !SECRET_ENV_NAME.test(secretEnv)) {
    throw new ProjectError(
      'webhook-signing-invalid',
      'The CI secret name must be upper case letters, digits and underscores, starting with a letter',
      { details: { secretEnv } },
    );
  }
  return {
    mode: 'sign',
    scheme: toSignatureScheme(parsed.data),
    ...(wire.secretRef !== undefined && wire.secretRef !== '' ? { secretRef: wire.secretRef } : {}),
    ...(secretEnv !== undefined ? { secretEnv } : {}),
  };
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

/**
 * Every slug in use at the project's top level: the APIs of every kind (they share `apis/`), the
 * interfaces and the placeholders (spec R3, §6). Hand it to `uniqueSlug` when naming an API.
 *
 * With `exceptApiId`, that API's own slug is left out so a rename may keep it — unless another API,
 * an interface or a placeholder holds the same slug too: the slug is dropped by leaving the API out,
 * never by deleting it from the set, so it is never freed while someone else still has it.
 */
export function takenApiSlugs(project: Project, exceptApiId?: string): Set<string> {
  const others: Project =
    exceptApiId === undefined
      ? project
      : {
          ...project,
          containers: {
            ...project.containers,
            rest: restApisOf(project).filter((api) => api.id !== exceptApiId),
            grpc: grpcApisOf(project).filter((api) => api.id !== exceptApiId),
            websocket: wsApisOf(project).filter((api) => api.id !== exceptApiId),
          },
        };
  return new Set([...takenContainerSlugs(others, 'apis'), ...takenContainerSlugs(others, 'interfaces')]);
}

/** Adds an API to the project, ordered after every interface and API it already has. */
export function addApi(
  project: Project,
  input: { readonly name: string; readonly baseUrl: string },
): RestMutationResult {
  const api = createApi(input.name, {
    slug: uniqueSlug(input.name, takenApiSlugs(project)),
    baseUrl: input.baseUrl,
    order: nextApiOrder(project),
  });
  return {
    project: { ...project, containers: { ...project.containers, rest: [...restApisOf(project), api] } },
    createdId: api.id,
  };
}

/** Applies a patch to an API. A `null` clears an optional field; an absent one leaves it alone. */
export function updateApi(project: Project, apiId: string, patch: ApiPatchWire): RestMutationResult {
  const api = requireApi(project, apiId);
  const taken = takenApiSlugs(project, apiId);
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
export function cleanUndefined<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Removes an API and everything in it; the saver deletes its folder and definition cache. */
export function removeApi(project: Project, apiId: string): RestMutationResult {
  requireApi(project, apiId);
  // The others keep their orders: APIs of every kind share one order, so renumbering one kind would
  // give an API an order another kind holds. A gap is harmless; `nextApiOrder` goes past the highest.
  return {
    project: {
      ...project,
      containers: { ...project.containers, rest: restApisOf(project).filter((api) => api.id !== apiId) },
      ...(project.webhooks !== undefined ? { webhooks: unlinkWebhookSource(project.webhooks, apiId) } : {}),
    },
  };
}

/**
 * Clears `source` on every webhook folder imported from `apiId`: the group and its requests stay
 * (nothing an import created is ever deleted by removing the API it came from), but it is no
 * longer offered as something *Update definition* can refresh.
 */
function unlinkWebhookSource(collection: WebhookCollection, apiId: string): WebhookCollection {
  const strip = (folders: readonly WebhookFolder[]): WebhookFolder[] =>
    folders.map((folder) => {
      const withoutSource: Record<string, unknown> = { ...folder };
      if (folder.source?.apiId === apiId) {
        delete withoutSource['source'];
      }
      return { ...withoutSource, folders: strip(folder.folders) } as unknown as WebhookFolder;
    });
  return { ...collection, folders: strip(collection.folders) };
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

/**
 * The `target`/`source`/`signing` a webhook folder carries beyond a plain `RestFolder`, passed through
 * untouched by a patch that only ever names REST fields.
 */
function webhookFolderExtras(folder: RestFolder): Pick<WebhookFolder, 'target' | 'source' | 'signing'> {
  const asWebhookFolder = folder as WebhookFolder;
  return {
    ...(asWebhookFolder.target !== undefined ? { target: asWebhookFolder.target } : {}),
    ...(asWebhookFolder.source !== undefined ? { source: asWebhookFolder.source } : {}),
    ...(asWebhookFolder.signing !== undefined ? { signing: asWebhookFolder.signing } : {}),
  };
}

/** Applies a patch to a folder, renaming its directory when the name changes. */
export function updateFolder(project: Project, folderId: string, patch: RestFolderPatchWire): RestMutationResult {
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
      return { ...next, ...webhookFolderExtras(folder) };
    }),
  });
  return { project: withRestTreeOwning(project, folderId, 'folder', (owner) => ({ ...owner, ...rename(owner) })) };
}

/** Removes a folder and everything inside it. */
export function removeFolder(project: Project, folderId: string): RestMutationResult {
  let removedAny: RestFolder | undefined;
  const nextProject = withRestTreeOwning(project, folderId, 'folder', (owner) => {
    const { folders, removed } = extractFolder(owner.folders, folderId);
    removedAny = removed;
    return { ...owner, folders: renumber(folders) };
  });
  if (removedAny === undefined) {
    notFound('folder', folderId);
  }
  return { project: nextProject };
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

/**
 * `${base} 1`, `${base} 2`, … skipping names already in `used` — or, with `firstBare`, the bare
 * `base` itself first and `${base} 2`, `${base} 3`, … after. Shared by REST's `Request N` and the
 * webhook collection's `Webhook`/`Webhook N` and `Group`/`Group N` naming.
 */
export function nextName(base: string, used: ReadonlySet<string>, options?: { readonly firstBare?: boolean }): string {
  const firstBare = options?.firstBare === true;
  if (firstBare && !used.has(base)) {
    return base;
  }
  for (let n = firstBare ? 2 : 1; ; n += 1) {
    const candidate = `${base} ${String(n)}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/** `Request 1`, `Request 2`, … skipping names the container already uses. */
function nextRequestName(container: Container): string {
  return nextName('Request', new Set(container.requests.map((request) => request.name)));
}

/**
 * Applies a REST request patch to `request`, re-deriving its slug against `container` only when
 * the name actually changes. Shared by `updateRestRequest` and `addWebhookRequest`'s `draft`,
 * which patches a freshly-created request the exact same way.
 */
export function applyRestRequestPatch(
  request: RestRequestDef,
  container: Container,
  patch: RestRequestPatchWire,
): RestRequestDef {
  const name = patch.name ?? request.name;
  return cleanUndefined<RestRequestDef>({
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
    // Settings are replaced wholesale, not merged: an absent field means *inherit*, so a merge
    // could never turn an override back off.
    settings: patch.settings !== undefined ? cleanUndefined<RestRequestSettings>(patch.settings) : request.settings,
    assertions: request.assertions,
    ...(request.scripts !== undefined ? { scripts: request.scripts } : {}),
    ...(request.orphaned === true ? { orphaned: true } : {}),
    // The contract link is main's record of what the import generated; a patch cannot set it.
    ...(request.contract !== undefined ? { contract: request.contract } : {}),
    // Same for a webhook collection item's link back to the OpenAPI entry it came from.
    ...(request.hook !== undefined ? { hook: request.hook } : {}),
    // Recorded responses are not part of a patch: only `remove-rest-example` changes them.
    ...(request.examples !== undefined ? { examples: request.examples } : {}),
    // Webhook items only (`updateRestRequest` refuses it elsewhere); `null` returns to inherit.
    ...(patch.signing === null
      ? {}
      : patch.signing !== undefined
        ? { signing: toEngineSigning(patch.signing) }
        : request.signing !== undefined
          ? { signing: request.signing }
          : {}),
  });
}

/** Applies a patch to a REST request. Every field is optional; a rename moves its files. */
export function updateRestRequest(
  project: Project,
  requestId: string,
  patch: RestRequestPatchWire,
): RestMutationResult {
  if (patch.signing !== undefined) {
    const owner = restTreeOwnerOf(project, requestId);
    if (owner !== undefined && !isWebhookOwner(owner)) {
      throw new ProjectError('webhook-signing-not-webhook', 'Only a webhook item can sign what it sends', {
        details: { requestId },
      });
    }
  }
  const apply = (container: Container): Container => ({
    ...container,
    requests: container.requests.map((request) =>
      request.id !== requestId ? request : applyRestRequestPatch(request, container, patch),
    ),
    folders: container.folders.map((folder) => ({ ...folder, ...apply(folder) })),
  });
  return {
    project: withRestTreeOwning(project, requestId, 'request', (owner) => ({ ...owner, ...apply(owner) })),
  };
}

/** Removes a REST request from wherever it is. */
export function removeRestRequest(project: Project, requestId: string): RestMutationResult {
  let removedAny: RestRequestDef | undefined;
  const nextProject = withRestTreeOwning(project, requestId, 'request', (owner) => {
    const { owner: next, removed } = extractRequestFrom(owner, requestId);
    removedAny = removed;
    return next;
  });
  if (removedAny === undefined) {
    notFound('request', requestId);
  }
  return { project: nextProject };
}

/**
 * Removes one recorded response from a REST request; the last one going drops the field, as a
 * request that never had any. Its body file is the save's to remove, as a managed file.
 */
export function removeRestExample(project: Project, requestId: string, exampleId: string): RestMutationResult {
  let removed = false;
  const apply = (container: Container): Container => ({
    ...container,
    requests: container.requests.map((candidate) => {
      if (candidate.id !== requestId) return candidate;
      const { examples = [], ...rest } = candidate;
      const kept = examples.filter((example) => example.id !== exampleId);
      removed = kept.length < examples.length;
      return kept.length > 0 ? { ...rest, examples: kept } : rest;
    }),
    folders: container.folders.map((folder) => ({ ...folder, ...apply(folder) })),
  });
  const next = withRestTreeOwning(project, requestId, 'request', (owner) => ({ ...owner, ...apply(owner) }));
  if (!removed) {
    notFound('example', exampleId);
  }
  return { project: next };
}

/** Duplicates a REST request beside the original, named `<name> copy`. */
export function cloneRestRequest(project: Project, requestId: string): RestMutationResult {
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
      ...(original.contract !== undefined ? { contract: original.contract } : {}),
      ...(original.description !== undefined ? { description: original.description } : {}),
      // Deliberately no `hook`: two items sharing one hook key would confuse *Update definition*
      // about which one an OpenAPI re-import should refresh, so a clone starts unlinked.
    });
    // The checks and scripts travel with the copy; its script files are written under its own slug.
    const withAssertions: RestRequestDef = {
      ...copy,
      assertions: original.assertions,
      ...(original.scripts !== undefined ? { scripts: original.scripts } : {}),
      // A clone signs like its original; only `hook` is deliberately dropped.
      ...(original.signing !== undefined ? { signing: original.signing } : {}),
      // Its recorded responses too: their body files are written under the copy's own slug.
      ...(original.examples !== undefined ? { examples: original.examples } : {}),
    };
    createdId = withAssertions.id;
    const requests = [...container.requests];
    requests.splice(index + 1, 0, withAssertions);
    return { ...container, requests: renumber(requests) };
  };
  const nextProject = withRestTreeOwning(project, requestId, 'request', (owner) => ({ ...owner, ...apply(owner) }));
  return { project: nextProject, createdId };
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
  const owner = restTreeOwnerOf(project, input.nodeId);
  if (owner === undefined) {
    notFound('node', input.nodeId);
  }
  if (!isWebhookOwner(owner) && input.apiId !== undefined && input.apiId !== owner.id) {
    throw new ProjectError('project-move-across-apis', 'A request or folder cannot move to another API', {
      details: { nodeId: input.nodeId, from: owner.id, to: input.apiId },
    });
  }
  if (input.parentId !== undefined && input.parentId === input.nodeId) {
    throw new ProjectError('project-move-into-self', 'A folder cannot be moved into itself', {
      details: { nodeId: input.nodeId },
    });
  }
  // A webhook item's tree and an API's are different worlds: it moves within the collection only.
  const parentId = input.parentId;
  if (parentId !== undefined) {
    const nodeInWebhooks = isWebhookOwner(owner);
    const parentInWebhooks = project.webhooks !== undefined && containerHolds(project.webhooks, parentId);
    const parentInApi = restApisOf(project).some((api) => api.id === parentId || containerHolds(api, parentId));
    if ((nodeInWebhooks && parentInApi) || (!nodeInWebhooks && parentInWebhooks)) {
      throw new ProjectError('project-move-across-apis', 'A webhook moves only within Webhooks', {
        details: { nodeId: input.nodeId, parentId },
      });
    }
  }

  const folderMove = extractFolder(owner.folders, input.nodeId);
  if (folderMove.removed !== undefined) {
    const moved = folderMove.removed;
    if (input.parentId !== undefined && containerHolds(moved, input.parentId)) {
      throw new ProjectError('project-move-into-self', 'A folder cannot be moved inside itself', {
        details: { nodeId: input.nodeId, parentId: input.parentId },
      });
    }
    const stripped = { ...owner, folders: renumber(folderMove.folders) } as RestTreeOwner;
    const next = inRestTreeContainer(stripped, input.parentId, (container) => {
      const folders = [...container.folders];
      folders.splice(clamp(input.index, folders.length), 0, {
        ...moved,
        slug: uniqueSlug(moved.name, takenSlugs(container, moved.id)),
      });
      return { ...container, folders: renumber(folders) };
    });
    if (next === undefined) {
      notFound('folder', input.parentId as string);
    }
    return { project: replaceRestTreeOwner(project, owner, next) };
  }

  const requestMove = extractRequestFrom(owner, input.nodeId);
  if (requestMove.removed === undefined) {
    notFound('node', input.nodeId);
  }
  const moved = requestMove.removed;
  const next = inRestTreeContainer(requestMove.owner, input.parentId, (container) => {
    const requests = [...container.requests];
    requests.splice(clamp(input.index, requests.length), 0, {
      ...moved,
      slug: uniqueSlug(moved.name, takenSlugs(container, moved.id)),
    });
    return { ...container, requests: renumber(requests) };
  });
  if (next === undefined) {
    notFound('folder', input.parentId as string);
  }
  return { project: replaceRestTreeOwner(project, owner, next) };
}

/** Keeps an index inside a list, so a stale drag target appends rather than throwing. */
function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}
