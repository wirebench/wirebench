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
 * an API's, through `withRestTreeOwning` in `project-rest-mutations.ts`. The tree-walking helpers
 * here (`inRestTreeContainer`, `mapFolder`, `notFound`, `applyRestRequestPatch`, `nextName`) are
 * the same ones that file exports for its own REST mutations — a webhook item is a REST item that
 * happens to live in the collection instead of an API.
 */

import {
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  hookKey,
  uniqueSlug,
  webhookFolders,
  WEBHOOK_TARGET_PROPERTY,
} from '@wirebench/engine';
import type { Project, PropertyMap, RestRequestDef, WebhookCollection, WebhookFolder } from '@wirebench/engine';
import type { AuthConfigWire, RestRequestPatchWire } from '../shared/wire-types.js';
import {
  applyRestRequestPatch,
  cleanUndefined,
  inRestTreeContainer,
  mapFolder,
  nextName,
  notFound,
  takenSlugs,
  toEngineAuthConfig,
  type Container,
  type RestMutationResult,
} from './project-rest-mutations.js';

import { isWebhookCollectionId, webhookCollectionId } from './webhook-ids.js';

export { isWebhookCollectionId, webhookCollectionId };

/**
 * Creates the project's webhook collection if it does not have one yet, and seeds the
 * `webhookTarget` property empty when neither the project nor its workspace (`workspaceProperties`)
 * has one by that name: a project value, even an empty one, wins over the workspace's, so seeding
 * it over a workspace value would hide that value. A no-op once the collection exists — the
 * property is never overwritten, so a value the user set survives.
 */
export function ensureWebhooks(project: Project, workspaceProperties?: PropertyMap): RestMutationResult {
  if (project.webhooks !== undefined) {
    return { project };
  }
  const defined =
    project.properties[WEBHOOK_TARGET_PROPERTY] !== undefined ||
    workspaceProperties?.[WEBHOOK_TARGET_PROPERTY] !== undefined;
  const properties = defined ? project.properties : { ...project.properties, [WEBHOOK_TARGET_PROPERTY]: '' };
  return { project: { ...project, webhooks: createWebhookCollection(), properties } };
}

/** Applies a patch to the collection itself: its target, or its own default credentials. */
export function updateWebhooks(
  project: Project,
  patch: { readonly target?: string; readonly auth?: AuthConfigWire | null },
  workspaceProperties?: PropertyMap,
): RestMutationResult {
  const ensured = ensureWebhooks(project, workspaceProperties).project;
  const webhooks = ensured.webhooks!;
  const next = cleanUndefined<WebhookCollection>({
    target: patch.target ?? webhooks.target,
    auth: patch.auth === null ? undefined : patch.auth !== undefined ? toEngineAuthConfig(patch.auth) : webhooks.auth,
    folders: webhooks.folders,
    requests: webhooks.requests,
  });
  return { project: { ...ensured, webhooks: next } };
}

/** Adds a request to the collection's root or to one of its folders, ensuring it exists first. */
export function addWebhookRequest(
  project: Project,
  input: {
    readonly parentId?: string | undefined;
    readonly name?: string | undefined;
    readonly draft?: RestRequestPatchWire | undefined;
  },
  workspaceProperties?: PropertyMap,
): RestMutationResult {
  const ensured = ensureWebhooks(project, workspaceProperties).project;
  const webhooks = ensured.webhooks!;
  let createdId = '';
  const next = inRestTreeContainer(webhooks, input.parentId, (container: Container) => {
    const name = input.name ?? nextName('Webhook', new Set(container.requests.map((r) => r.name)), { firstBare: true });
    const request = createRestRequest(name, {
      slug: uniqueSlug(name, takenSlugs(container)),
      order: container.requests.length,
      method: 'POST',
    });
    const withDraft = input.draft !== undefined ? applyRestRequestPatch(request, container, input.draft) : request;
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
  workspaceProperties?: PropertyMap,
): RestMutationResult {
  const ensured = ensureWebhooks(project, workspaceProperties).project;
  const webhooks = ensured.webhooks!;
  let createdId = '';
  const next = inRestTreeContainer(webhooks, input.parentId, (container: Container) => {
    const name = input.name ?? nextName('Group', new Set(container.folders.map((f) => f.name)), { firstBare: true });
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
  const folders = mapFolder(webhooks.folders, folderId, (folder) => {
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
export function addWebhookGroup(
  project: Project,
  folder: WebhookFolder,
  workspaceProperties?: PropertyMap,
): RestMutationResult {
  const ensured = ensureWebhooks(project, workspaceProperties).project;
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

/**
 * The collection's folder linked to `apiId` — the one an OpenAPI import's group carries as
 * `source.apiId` — or `undefined` when the project has no collection or nothing of this API's is
 * linked. A group is placed at the root (`addWebhookGroup`) but may since have been moved into
 * another folder, so every folder is searched.
 */
export function linkedWebhookFolder(webhooks: WebhookCollection | undefined, apiId: string): WebhookFolder | undefined {
  return webhooks === undefined ? undefined : webhookFolders(webhooks).find((folder) => folder.source?.apiId === apiId);
}

/** Every hook key held anywhere in `folder`'s own tree: its own requests and every nested folder's. */
export function webhookKeysUnder(folder: WebhookFolder): Set<string> {
  const keys = new Set<string>();
  for (const container of [folder, ...webhookFolders(folder)]) {
    for (const request of container.requests) {
      if (request.hook !== undefined) {
        keys.add(hookKey(request.hook, request.method));
      }
    }
  }
  return keys;
}

/**
 * Adds already-mapped items to an existing group's root: unique slugs against the whole group,
 * increasing order — the same placement rule a fresh import's group gets from {@link addWebhookGroup}.
 */
export function appendWebhookItems(
  project: Project,
  folderId: string,
  items: readonly RestRequestDef[],
): RestMutationResult {
  const webhooks = project.webhooks;
  if (webhooks === undefined) {
    notFound('folder', folderId);
  }
  const folders = mapFolder(webhooks.folders, folderId, (folder) => {
    const taken = takenSlugs(folder);
    let order = folder.requests.length;
    const appended = items.map((item) => {
      const slug = uniqueSlug(item.slug, taken);
      taken.add(slug);
      const placed = { ...item, slug, order };
      order += 1;
      return placed;
    });
    return { ...folder, requests: [...folder.requests, ...appended] };
  });
  if (folders === undefined) {
    notFound('folder', folderId);
  }
  return { project: { ...project, webhooks: { ...webhooks, folders } } };
}
