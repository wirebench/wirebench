/**
 * Applying the webhook half of a {@link ProjectChange} to a project model: the project's single
 * webhook collection (`webhooks/`), created on first use and shared by every hook the renderer
 * adds or imports (spec `2026-09-28-wirebench-openapi-webhooks-import-design.md` §4).
 *
 * Kept apart from `project-rest-mutations.ts` because a collection has no `id`, `slug` or `kind`
 * of its own — one per project, addressed on the wire by the synthetic `webhooks:<projectId>` —
 * and from `project-mutations.ts` because it is REST-shaped, not SOAP. Once a request or folder
 * exists here, the six REST tree mutations (`update-rest-request`, `remove-rest-request`,
 * `clone-rest-request`, `update-folder`, `remove-folder`, `move-node`) edit it exactly as they do
 * an API's, through `withRestTreeOwning` in `project-rest-mutations.ts`.
 */

import {
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  uniqueSlug,
  WEBHOOKS_COLLECTION_PREFIX,
  WEBHOOK_TARGET_PROPERTY,
  ProjectError,
} from '@wirebench/engine';
import type { Project, RestRequestDef, RestRequestSettings, WebhookCollection, WebhookFolder } from '@wirebench/engine';
import type { AuthConfigWire, RestRequestPatchWire } from '../shared/wire-types.js';
import {
  cleanUndefined,
  takenSlugs,
  toEngineAuthConfig,
  toEngineBody,
  toEngineRows,
  type RestMutationResult,
} from './project-rest-mutations.js';

/** Anything that holds folders and requests, one level of the webhook collection's tree. */
type Tree = Pick<WebhookCollection, 'folders' | 'requests'>;

function notFound(what: string, id: string): never {
  throw new ProjectError('project-entity-not-found', `No ${what} with id ${id}`, { details: { what, id } });
}

/** The wire id of a project's webhook collection: synthetic, never a real API id. */
export function webhookCollectionId(projectId: string): string {
  return `${WEBHOOKS_COLLECTION_PREFIX}${projectId}`;
}

/** Whether `id` names a project's webhook collection rather than an API. */
export function isWebhookCollectionId(id: string): boolean {
  return id.startsWith(WEBHOOKS_COLLECTION_PREFIX);
}

/**
 * Creates the project's webhook collection if it does not have one yet, and seeds the
 * `webhookTarget` property empty when the project has none by that name. A no-op once the
 * collection exists — the property is never overwritten, so a value the user set survives.
 */
export function ensureWebhooks(project: Project): RestMutationResult {
  if (project.webhooks !== undefined) {
    return { project };
  }
  const properties =
    project.properties[WEBHOOK_TARGET_PROPERTY] !== undefined
      ? project.properties
      : { ...project.properties, [WEBHOOK_TARGET_PROPERTY]: '' };
  return { project: { ...project, webhooks: createWebhookCollection(), properties } };
}

/** Applies a patch to the collection itself: its target, or its own default credentials. */
export function updateWebhooks(
  project: Project,
  patch: { readonly target?: string; readonly auth?: AuthConfigWire | null },
): RestMutationResult {
  const ensured = ensureWebhooks(project).project;
  const webhooks = ensured.webhooks!;
  const next = cleanUndefined<WebhookCollection>({
    target: patch.target ?? webhooks.target,
    auth: patch.auth === null ? undefined : patch.auth !== undefined ? toEngineAuthConfig(patch.auth) : webhooks.auth,
    folders: webhooks.folders,
    requests: webhooks.requests,
  });
  return { project: { ...ensured, webhooks: next } };
}

/** Places a folder or request inside the collection at `parentId`, or its root when absent. */
function inWebhookContainer(
  collection: WebhookCollection,
  parentId: string | undefined,
  transform: (container: Tree) => Tree,
): WebhookCollection | undefined {
  if (parentId === undefined) {
    return { ...collection, ...transform(collection) };
  }
  const folders = mapWebhookFolder(collection.folders, parentId, (folder) => ({ ...folder, ...transform(folder) }));
  return folders === undefined ? undefined : { ...collection, folders };
}

/** Rebuilds a webhook folder list with `transform` applied to the folder `folderId`, wherever it is. */
function mapWebhookFolder(
  folders: readonly WebhookFolder[],
  folderId: string,
  transform: (folder: WebhookFolder) => WebhookFolder,
): WebhookFolder[] | undefined {
  let found = false;
  const next = folders.map((folder) => {
    if (folder.id === folderId) {
      found = true;
      return transform(folder);
    }
    const deeper = mapWebhookFolder(folder.folders, folderId, transform);
    if (deeper === undefined) {
      return folder;
    }
    found = true;
    return { ...folder, folders: deeper };
  });
  return found ? next : undefined;
}

/** `Webhook`, `Webhook 2`, … skipping names the container already uses. */
function nextWebhookName(container: Tree): string {
  const used = new Set(container.requests.map((request) => request.name));
  if (!used.has('Webhook')) {
    return 'Webhook';
  }
  for (let n = 2; ; n += 1) {
    const candidate = `Webhook ${String(n)}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/** `Group`, `Group 2`, … skipping names the container already uses. */
function nextWebhookGroupName(container: Tree): string {
  const used = new Set(container.folders.map((folder) => folder.name));
  if (!used.has('Group')) {
    return 'Group';
  }
  for (let n = 2; ; n += 1) {
    const candidate = `Group ${String(n)}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/** Applies a full request patch to a freshly-created request, the same logic `updateRestRequest` uses. */
function applyDraft(request: RestRequestDef, container: Tree, patch: RestRequestPatchWire): RestRequestDef {
  const name = patch.name ?? request.name;
  return cleanUndefined<RestRequestDef>({
    kind: 'rest',
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
    settings: patch.settings !== undefined ? cleanUndefined<RestRequestSettings>(patch.settings) : request.settings,
    assertions: request.assertions,
  });
}

/** Adds a request to the collection's root or to one of its folders, ensuring it exists first. */
export function addWebhookRequest(
  project: Project,
  input: {
    readonly parentId?: string | undefined;
    readonly name?: string | undefined;
    readonly draft?: RestRequestPatchWire | undefined;
  },
): RestMutationResult {
  const ensured = ensureWebhooks(project).project;
  const webhooks = ensured.webhooks!;
  let createdId = '';
  const next = inWebhookContainer(webhooks, input.parentId, (container) => {
    const name = input.name ?? nextWebhookName(container);
    const request = createRestRequest(name, {
      slug: uniqueSlug(name, takenSlugs(container)),
      order: container.requests.length,
      method: 'POST',
    });
    const withDraft = input.draft !== undefined ? applyDraft(request, container, input.draft) : request;
    createdId = withDraft.id;
    return { ...container, requests: [...container.requests, withDraft] };
  });
  if (next === undefined) {
    notFound('folder', input.parentId ?? webhookCollectionId(ensured.id));
  }
  return { project: { ...ensured, webhooks: next }, createdId };
}

/** Adds a plain (not imported) folder to the collection's root or to another folder. */
export function addWebhookFolder(
  project: Project,
  input: { readonly parentId?: string | undefined; readonly name?: string | undefined },
): RestMutationResult {
  const ensured = ensureWebhooks(project).project;
  const webhooks = ensured.webhooks!;
  let createdId = '';
  const next = inWebhookContainer(webhooks, input.parentId, (container) => {
    const name = input.name ?? nextWebhookGroupName(container);
    const folder = createWebhookFolder(name, {
      slug: uniqueSlug(name, takenSlugs(container)),
      order: container.folders.length,
    });
    createdId = folder.id;
    return { ...container, folders: [...container.folders, folder] };
  });
  if (next === undefined) {
    notFound('folder', input.parentId ?? webhookCollectionId(ensured.id));
  }
  return { project: { ...ensured, webhooks: next }, createdId };
}

/** Sets, or clears with `target: null`, one folder's own target override. */
export function setWebhookFolderTarget(project: Project, folderId: string, target: string | null): RestMutationResult {
  const webhooks = project.webhooks;
  if (webhooks === undefined) {
    notFound('folder', folderId);
  }
  const folders = mapWebhookFolder(webhooks.folders, folderId, (folder) => {
    const rest: Record<string, unknown> = { ...folder };
    if (target === null) {
      delete rest['target'];
    } else {
      rest['target'] = target;
    }
    return rest as unknown as WebhookFolder;
  });
  if (folders === undefined) {
    notFound('folder', folderId);
  }
  return { project: { ...project, webhooks: { ...webhooks, folders } } };
}

/**
 * Appends an already-built folder (an OpenAPI import's group, complete with its requests) to the
 * collection's root, ensuring the collection exists first and giving the group a unique slug and
 * the next root order — the same placement rule `addFolder` gives a REST one.
 */
export function addWebhookGroup(project: Project, folder: WebhookFolder): RestMutationResult {
  const ensured = ensureWebhooks(project).project;
  const webhooks = ensured.webhooks!;
  const placed: WebhookFolder = {
    ...folder,
    slug: uniqueSlug(folder.slug, takenSlugs(webhooks)),
    order: webhooks.folders.length,
  };
  return {
    project: { ...ensured, webhooks: { ...webhooks, folders: [...webhooks.folders, placed] } },
    createdId: folder.id,
  };
}
