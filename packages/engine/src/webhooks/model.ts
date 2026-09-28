/**
 * A project's webhook collection: outbound requests that play a provider calling the user's own
 * receiver (spec `2026-09-28-wirebench-openapi-webhooks-import-design.md` §4). Items are ordinary
 * REST requests; the collection and its folders carry a *target* where an API carries a base URL.
 */
import type { AuthConfig, CreateOptions } from '../project/model.js';
import { generateId } from '../project/model.js';
import { slugify } from '../project/paths.js';
import type { RestFolder, RestRequestDef } from '../rest/model.js';

/** The link from an imported item back to the OpenAPI entry it came from. */
export type HookLink =
  | { readonly kind: 'webhook'; readonly name: string }
  | {
      readonly kind: 'callback';
      /** The parent operation's contract key, e.g. `post /subscriptions`. */
      readonly operation: string;
      readonly name: string;
      /** The callback's path-item key, verbatim, e.g. `{$request.body#/callbackUrl}`. */
      readonly expression: string;
    };

/** A folder of the webhook collection: a REST folder that may override the target. */
export interface WebhookFolder extends Omit<RestFolder, 'folders'> {
  /** Overrides the inherited target for everything inside; the nearest folder that sets one wins. */
  readonly target?: string;
  /** Set on a group imported from an API's definition: that API, so its update can find the group. */
  readonly source?: { readonly apiId: string };
  readonly folders: readonly WebhookFolder[];
}

/** One project's webhook collection. */
export interface WebhookCollection {
  /** Where items are sent; may contain `${…}` properties. */
  readonly target: string;
  /** What items (and folders) whose auth is `inherit` end up using. */
  readonly auth?: AuthConfig;
  readonly folders: readonly WebhookFolder[];
  readonly requests: readonly RestRequestDef[];
}

/** The target a new collection starts with. */
export const DEFAULT_WEBHOOK_TARGET = '${webhookTarget}';
/** The project property a new collection seeds, empty, when the project has none by that name. */
export const WEBHOOK_TARGET_PROPERTY = 'webhookTarget';
/** Prefix of the id the desktop gives a project's collection on the wire: `webhooks:<projectId>`. */
export const WEBHOOKS_COLLECTION_PREFIX = 'webhooks:';

export interface CreateWebhookCollectionInput {
  readonly target?: string;
  readonly auth?: AuthConfig;
  readonly folders?: readonly WebhookFolder[];
  readonly requests?: readonly RestRequestDef[];
}

/** Creates an empty collection aimed at {@link DEFAULT_WEBHOOK_TARGET}. */
export function createWebhookCollection(input: CreateWebhookCollectionInput = {}): WebhookCollection {
  return {
    target: input.target ?? DEFAULT_WEBHOOK_TARGET,
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    folders: input.folders ?? [],
    requests: input.requests ?? [],
  };
}

export interface CreateWebhookFolderInput extends CreateOptions {
  readonly slug?: string;
  readonly description?: string;
  readonly auth?: AuthConfig;
  readonly target?: string;
  readonly source?: { readonly apiId: string };
  readonly folders?: readonly WebhookFolder[];
  readonly requests?: readonly RestRequestDef[];
}

/** Creates a webhook folder. */
export function createWebhookFolder(name: string, input: CreateWebhookFolderInput = {}): WebhookFolder {
  return {
    id: input.id ?? (input.newId ?? generateId)(),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    ...(input.target !== undefined ? { target: input.target } : {}),
    ...(input.source !== undefined ? { source: { apiId: input.source.apiId } } : {}),
    folders: input.folders ?? [],
    requests: input.requests ?? [],
  };
}

type Tree = Pick<WebhookCollection, 'folders' | 'requests'>;

/** Every request of the collection, root first, then each folder depth-first. */
export function webhookRequests(tree: Tree): RestRequestDef[] {
  return [...tree.requests, ...tree.folders.flatMap((folder) => webhookRequests(folder))];
}

/** Every folder of the collection, depth-first. */
export function webhookFolders(tree: Tree): WebhookFolder[] {
  return tree.folders.flatMap((folder) => [folder, ...webhookFolders(folder)]);
}

/** The request with `id`, and the folders from the root down to it. */
export function webhookPath(
  tree: Tree,
  id: string,
): { readonly request: RestRequestDef; readonly chain: readonly WebhookFolder[] } | undefined {
  const request = tree.requests.find((candidate) => candidate.id === id);
  if (request !== undefined) return { request, chain: [] };
  for (const folder of tree.folders) {
    const found = webhookPath(folder, id);
    if (found !== undefined) return { request: found.request, chain: [folder, ...found.chain] };
  }
  return undefined;
}

/** The request with `id`, anywhere in the collection. */
export function findWebhookRequest(tree: Tree, id: string): RestRequestDef | undefined {
  return webhookPath(tree, id)?.request;
}

/** The target an item under `chain` (root → leaf folders) is sent to, before property expansion. */
export function effectiveTarget(
  collection: Pick<WebhookCollection, 'target'>,
  chain: readonly WebhookFolder[],
): string {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const target = chain[index]?.target;
    if (target !== undefined) return target;
  }
  return collection.target;
}

/** The key *Update definition* matches an imported item by: kind, name, method — never the URL. */
export function hookKey(link: HookLink, method: string): string {
  const verb = method.toLowerCase();
  return link.kind === 'webhook' ? `webhook ${link.name} ${verb}` : `callback ${link.operation} ${link.name} ${verb}`;
}
