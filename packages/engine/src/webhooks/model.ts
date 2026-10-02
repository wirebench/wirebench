/**
 * A project's webhook collection: outbound requests that play a provider calling the user's own
 * receiver (spec `2026-09-28-wirebench-openapi-webhooks-import-design.md` §4). Items are ordinary
 * REST requests; the collection and its folders carry a *target* where an API carries a base URL.
 */
import { WirebenchError } from '../errors.js';
import type { AuthConfig, CreateOptions } from '../project/model.js';
import { generateId } from '../project/model.js';
import { slugify } from '../project/paths.js';
import { SIGNING_PSEUDO_REF_PREFIX } from '../secrets/env-names.js';
import type { RestFolder, RestRequestDef } from '../rest/model.js';
import type { SignatureScheme } from '../http/webhook-signature.js';

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

/**
 * How the webhook collection, a folder or an item signs what it sends (spec §5.1). Absent means
 * inherit: the item, then the nearest folder, then the collection; nothing set anywhere is `none`.
 */
export type WebhookSigning =
  | { readonly mode: 'none' }
  | {
      readonly mode: 'sign';
      readonly scheme: SignatureScheme;
      /** Opaque reference into the OS-keychain-backed secret store. Never a secret value. */
      readonly secretRef?: string;
      /** The name CI supplies this secret under: `WIREBENCH_SECRET_<name>`. Not a secret; committed. */
      readonly secretEnv?: string;
    };

/** The signing an item sends with, and where it was set. */
export interface EffectiveSigning {
  readonly signing: WebhookSigning;
  readonly from: 'item' | 'folder' | 'collection' | 'default';
  /** The item's or the folder's name; absent for the collection and the default. */
  readonly fromName?: string;
}

/** A folder of the webhook collection: a REST folder that may override the target. */
export interface WebhookFolder extends Omit<RestFolder, 'folders'> {
  /** Overrides the inherited target for everything inside; the nearest folder that sets one wins. */
  readonly target?: string;
  /** Overrides the inherited signing for everything inside. */
  readonly signing?: WebhookSigning;
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
  /** Overrides the inherited signing for everything inside. */
  readonly signing?: WebhookSigning;
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
  readonly signing?: WebhookSigning;
  readonly folders?: readonly WebhookFolder[];
  readonly requests?: readonly RestRequestDef[];
}

/** Creates an empty collection aimed at {@link DEFAULT_WEBHOOK_TARGET}. */
export function createWebhookCollection(input: CreateWebhookCollectionInput = {}): WebhookCollection {
  return {
    target: input.target ?? DEFAULT_WEBHOOK_TARGET,
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    ...(input.signing !== undefined ? { signing: input.signing } : {}),
    folders: input.folders ?? [],
    requests: input.requests ?? [],
  };
}

export interface CreateWebhookFolderInput extends CreateOptions {
  readonly slug?: string;
  readonly description?: string;
  readonly auth?: AuthConfig;
  readonly target?: string;
  readonly signing?: WebhookSigning;
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
    ...(input.signing !== undefined ? { signing: input.signing } : {}),
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

const NO_SIGNING: EffectiveSigning = { signing: { mode: 'none' }, from: 'default' };

/**
 * The signing `request`, under `chain` (root → leaf folders), is sent with: its own, else the
 * nearest folder's, else the collection's, else none. Takes the request itself so a caller holding
 * an edited copy (the desktop's draft) resolves what will actually be sent.
 */
export function signingAlong(
  collection: Pick<WebhookCollection, 'signing'>,
  chain: readonly WebhookFolder[],
  request: RestRequestDef,
): EffectiveSigning {
  if (request.signing !== undefined) return { signing: request.signing, from: 'item', fromName: request.name };
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const folder = chain[index]!;
    if (folder.signing !== undefined) return { signing: folder.signing, from: 'folder', fromName: folder.name };
  }
  return collection.signing !== undefined ? { signing: collection.signing, from: 'collection' } : NO_SIGNING;
}

/** The signing request `requestId` is sent with (spec §5.1); none for an id the collection lacks. */
export function effectiveSigning(collection: WebhookCollection, requestId: string): EffectiveSigning {
  const path = webhookPath(collection, requestId);
  return path === undefined ? NO_SIGNING : signingAlong(collection, path.chain, path.request);
}

/** `the item “Paid”`, `the folder “Orders”`, `the Webhooks collection`. */
export function signingSourceLabel(effective: EffectiveSigning): string {
  switch (effective.from) {
    case 'item':
      return `the item “${effective.fromName ?? ''}”`;
    case 'folder':
      return `the folder “${effective.fromName ?? ''}”`;
    default:
      return 'the Webhooks collection';
  }
}

/**
 * The ref a run's `GetSecret` is asked for. With only a CI name, a pseudo-ref whose declared name
 * is that CI name, so `WIREBENCH_SECRET_<secretEnv>` is read first (`envVariablesFor`).
 */
export function signingSecretRef(signing: Extract<WebhookSigning, { mode: 'sign' }>): string | undefined {
  if (signing.secretRef !== undefined && signing.secretRef !== '') return signing.secretRef;
  return signing.secretEnv !== undefined ? `${SIGNING_PSEUDO_REF_PREFIX}${signing.secretEnv}` : undefined;
}

const ABSOLUTE_HTTP = /^https?:\/\//i;

/**
 * Refuses a webhook item's target that cannot be sent to, once it is expanded: an empty one (unless
 * the item's own URL is absolute) and one that is not `http(s)`. A target still holding a reference
 * nothing resolved is left to the unresolved list, which already refuses the send and names it.
 *
 * @throws WirebenchError `webhook-target-missing` | `webhook-target-invalid`
 */
export function assertWebhookTarget(baseUrl: string, url: string, unresolved: boolean): void {
  if (baseUrl.trim() === '') {
    if (!ABSOLUTE_HTTP.test(url)) {
      throw new WirebenchError('webhook-target-missing', 'Set the Webhooks target');
    }
    return;
  }
  if (!ABSOLUTE_HTTP.test(baseUrl) && !(unresolved && baseUrl.includes('${'))) {
    throw new WirebenchError('webhook-target-invalid', 'The Webhooks target must start with http:// or https://');
  }
}

/** The refusal when signing is set but its secret is not: a send never goes out unsigned (§5.2). */
export function signingSecretMissing(effective: EffectiveSigning, ref?: string): WirebenchError {
  return new WirebenchError(
    'webhook-signing-secret',
    `Signing is set on ${signingSourceLabel(effective)} but its secret is not set`,
    {
      details: {
        from: effective.from,
        ...(effective.fromName !== undefined ? { fromName: effective.fromName } : {}),
        // The CLI names the variable to set from this (`explainMissingSecret`).
        ...(ref !== undefined ? { ref } : {}),
      },
    },
  );
}

/** The key *Update definition* matches an imported item by: kind, name, method — never the URL. */
export function hookKey(link: HookLink, method: string): string {
  const verb = method.toLowerCase();
  return link.kind === 'webhook' ? `webhook ${link.name} ${verb}` : `callback ${link.operation} ${link.name} ${verb}`;
}
