/**
 * REST's share of an open project's host (spec §5.3): its caches and the methods that are
 * about REST alone, built once per open project on the {@link ProjectHostCore} the host
 * passes in, and reached as `ProjectHost.kind('rest')`.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  apiDefinitionDir,
  applyRestUpdate,
  applyWebhookUpdate,
  createCachedApiFetch,
  findWebhookRequest,
  hookKey,
  lintOpenApi,
  matchOperation,
  nextApiOrder,
  nodeFs,
  parseOpenApi,
  planRestUpdate,
  ProjectError,
  readApiDefinitionCache,
  readProjectLintRulesets,
  restApisOf,
  toWireSchema,
  uniqueSlug,
  webhookFolders,
  webhookItemsOf,
  webhookPath,
  webhooksFromDocument,
  webhooksOf,
  withWebhooks,
  writeApiDefinitionCache,
  writeFileAtomic,
} from '@wirebench/engine';
import type {
  AuthConfig,
  DefinitionAuth,
  JsonSchema,
  LintReport,
  OpenApiDocument,
  ParsedOpenApi,
  Project,
  ResolvedDocument,
  RestApi,
  RestApplyResult,
  RestFolder,
  RestRequestDef,
  RestUpdatePlan,
  WebhookApplyResult,
  WebhookFolder,
  WebhookItemRef,
} from '@wirebench/engine';
import type { ProjectChange, ProjectWire } from '../../../shared/wire-types.js';
import { findRestFolder, findRestRequest, mapFolder, restApiOwning } from './mutations.js';
import { takenApiSlugs } from '../../project-api-mutations.js';
import { isWebhookCollectionId } from '../../webhook-ids.js';
import { addWebhookGroup, appendWebhookItems, linkedWebhookFolder, webhookKeysUnder } from './webhooks/mutations.js';
import type { RestContractTarget } from '../../rest-contract.js';
import type { ProjectHostCore } from '../../project-host-core.js';
import type { ApiDefinitionDocuments, KindApiDefinitions, KindHostHooks } from '../kind-main.js';
import { errorMessage } from '../../project-host-core.js';

/**
 * The operation a REST request calls with `sent`'s method and URL, and its declaration in `document`.
 * The import link names the operation only while the request still calls it: a request whose method
 * or URL was edited since (or a clone pointed elsewhere) is matched afresh.
 */
function operationCalled(
  document: OpenApiDocument,
  link: { readonly method: string; readonly path: string } | undefined,
  sent: { readonly method: string; readonly url: string },
  baseUrls: readonly string[],
):
  | {
      readonly operation: { readonly method: string; readonly path: string };
      readonly declared: OpenApiDocument['operations'][number] | undefined;
    }
  | undefined {
  const linked =
    link !== undefined &&
    link.method.toLowerCase() === sent.method.toLowerCase() &&
    matchOperation([link], sent.method, sent.url, baseUrls) !== undefined;
  const operation = linked
    ? { method: link.method, path: link.path }
    : matchOperation(document.operations, sent.method, sent.url, baseUrls);
  if (operation === undefined) {
    return undefined;
  }
  const declared = document.operations.find(
    (candidate) =>
      candidate.method.toLowerCase() === operation.method.toLowerCase() && candidate.path === operation.path,
  );
  return { operation, declared };
}

/** The request with this id inside `container`, and the names of the folders enclosing it. */
function restPathWithin(
  container: { readonly folders: readonly RestFolder[]; readonly requests: readonly RestRequestDef[] },
  requestId: string,
  enclosing: readonly string[],
): { readonly request: RestRequestDef; readonly folders: readonly string[] } | undefined {
  const own = container.requests.find((request) => request.id === requestId);
  if (own !== undefined) {
    return { request: own, folders: enclosing };
  }
  for (const folder of container.folders) {
    const deeper = restPathWithin(folder, requestId, [...enclosing, folder.name]);
    if (deeper !== undefined) {
      return deeper;
    }
  }
  return undefined;
}

export class RestHost implements KindHostHooks {
  constructor(private readonly core: ProjectHostCore) {}

  readonly apiDefinitions: KindApiDefinitions = this;

  /** A parsed definition belongs to the project's cache folder; a reopen reads it again. */
  close(): void {
    this.openApiDocuments.clear();
  }

  /** The parsed definition belongs to the API's cache folder, which the removal takes with it. */
  afterChange(change: ProjectChange): void {
    if (change.kind === 'remove-api') {
      this.openApiDocuments.delete(change.apiId);
    }
  }

  /**
   * Each OpenAPI-imported API's parsed document, read from its definition cache once per session
   * and API, for checking responses against it. Dropped on close and when the API is imported.
   */
  private readonly openApiDocuments = new Map<string, Promise<OpenApiDocument>>();

  /**
   * The credentials configured on one API, folder or REST request — its own, not its chain's.
   *
   * What the Auth inspector edits and what the OAuth2 channels read: a token is obtained for the
   * entity that configures it, not for whatever request happened to ask.
   */
  restAuthOf(ownerId: string): AuthConfig | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    const project = this.core.open.project;
    const api = restApisOf(project).find((candidate) => candidate.id === ownerId);
    if (api !== undefined) {
      return api.auth;
    }
    const folder = findRestFolder(project, ownerId);
    if (folder !== undefined) {
      return folder.auth;
    }
    const webhooks = webhooksOf(project);
    if (webhooks !== undefined) {
      // The collection, one of its folders or one of its items, which configure credentials the
      // same way an API, a folder and a request do.
      if (isWebhookCollectionId(ownerId)) {
        return webhooks.auth;
      }
      const webhookFolder = webhookFolders(webhooks).find((candidate) => candidate.id === ownerId);
      if (webhookFolder !== undefined) {
        return webhookFolder.auth;
      }
    }
    return this.restOrWebhookRequest(ownerId)?.auth;
  }

  /** The REST request with this id, in an API or in the project's webhook collection. */
  private restOrWebhookRequest(requestId: string): RestRequestDef | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    const { project } = this.core.open;
    const webhooks = webhooksOf(project);
    return (
      findRestRequest(project, requestId) ??
      (webhooks === undefined ? undefined : findWebhookRequest(webhooks, requestId))
    );
  }

  /**
   * What History names a REST send by: the request, its API, and the folder path inside it.
   *
   * The REST counterpart of {@link requestMeta}, and shaped to the same three slots, so a history
   * row needs no per-protocol branching: the API's name takes the interface's place and the folder
   * path the operation's.
   */
  restMeta(requestId: string):
    | {
        readonly requestName: string;
        readonly apiName: string;
        readonly folderPath: string;
        /** History tags; only a sequence run sets them, through its own view of the project. */
        readonly tags?: readonly string[];
      }
    | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    for (const api of restApisOf(this.core.open.project)) {
      const found = restPathWithin(api, requestId, []);
      if (found !== undefined) {
        return { requestName: found.request.name, apiName: api.name, folderPath: found.folders.join(' / ') };
      }
    }
    const webhooks = webhooksOf(this.core.open.project);
    const webhook = webhooks === undefined ? undefined : webhookPath(webhooks, requestId);
    if (webhook !== undefined) {
      return {
        requestName: webhook.request.name,
        apiName: 'Webhooks',
        folderPath: webhook.chain.map((folder) => folder.name).join(' / '),
      };
    }
    return undefined;
  }

  /**
   * Places an imported API in the project, caching the documents it was made of.
   *
   * The API arrives fully mapped (`importOpenApi` in the engine) and is placed here, because only
   * the project knows which slugs are taken and where the cache goes. The cache is written under
   * the API's own folder *after* the slug is settled, so unlike a WSDL import there is no
   * provisional folder to rename — and a cancelled import has therefore written nothing at all.
   *
   * Saves immediately, as a WSDL import does: an import is never lost to a crash.
   */
  async addApi(input: {
    readonly api: RestApi;
    readonly documents: readonly ResolvedDocument[];
    /** Where the user pointed at, recorded on the API as its definition's source. */
    readonly source: string;
    /** The `openapi` string the document declared. */
    readonly declaredVersion: string;
    /** Write the definition cache. Defaults to the WSDL caching preference, as an import does. */
    readonly cache?: boolean;
    /** The credentials the document was fetched with, kept so Update Definition can fetch it again. */
    readonly auth?: DefinitionAuth;
    /**
     * The document's webhooks and callbacks, already mapped into one group (`importOpenApi`'s own
     * `webhooks`). Placed in the collection in the same change as the API — one undo step, one save —
     * so an import never leaves the API without its group, or the group without its API.
     */
    readonly webhooks?: WebhookFolder;
  }): Promise<{ project: ProjectWire; apiId: string }> {
    const open = this.core.require();
    const slug = uniqueSlug(input.api.name, takenApiSlugs(open.project));
    const cache = input.cache ?? this.core.prefs()?.wsdl.cacheDefinitions ?? true;

    if (cache) {
      await writeApiDefinitionCache(input.documents, apiDefinitionDir(open.dir, slug), {
        declaredVersion: input.declaredVersion,
      });
    }

    const api: RestApi = {
      ...input.api,
      slug,
      order: nextApiOrder(open.project),
      definition: {
        source: input.source,
        cache,
        version: input.declaredVersion,
        ...(input.auth !== undefined ? { auth: input.auth } : {}),
      },
    };
    let project: Project = {
      ...open.project,
      containers: { ...open.project.containers, rest: [...restApisOf(open.project), api] },
    };
    if (input.webhooks !== undefined) {
      project = addWebhookGroup(project, input.webhooks, this.core.workspaceContext?.()?.workspace.properties).project;
    }
    open.project = project;
    open.dirty = true;
    this.openApiDocuments.delete(api.id);
    await this.core.save({ reason: 'import' });
    return { project: this.core.snapshot() as ProjectWire, apiId: api.id };
  }

  /**
   * The OpenAPI document a REST API was imported from, parsed from its definition cache — never the
   * network — and kept for the session. A failed read is not remembered, so a fixed cache is read
   * again on the next ask.
   *
   * @throws ProjectError `not-found` when `apiId` is not a REST API of this project.
   */
  openApiDocumentFor(apiId: string): Promise<OpenApiDocument> {
    const known = this.openApiDocuments.get(apiId);
    if (known !== undefined) {
      return known;
    }
    const api = this.requireApi(apiId);
    const dir = apiDefinitionDir(this.core.require().dir, api.slug);
    const loading = readApiDefinitionCache(dir).then(async (cached) => {
      const offline = createCachedApiFetch(cached.manifest, dir, (location) =>
        Promise.reject(
          new ProjectError('definition-cache-missing', `"${location}" is not in this API's definition cache`, {
            details: { location },
          }),
        ),
      );
      const parsed = await parseOpenApi({ kind: 'url', url: cached.manifest.rootLocation }, { fetchDocument: offline });
      return parsed.document;
    });
    loading.catch(() => {
      if (this.openApiDocuments.get(apiId) === loading) {
        this.openApiDocuments.delete(apiId);
      }
    });
    this.openApiDocuments.set(apiId, loading);
    return loading;
  }

  /**
   * What a REST request's response is checked against: the operation it calls — its import link when
   * `sent`'s method is the link's and its URL fits the link's path, or else the one operation `sent`'s
   * method and URL match — and that operation's declared
   * responses. `undefined` (not a promise) when the request's API has no cached definition, so such
   * a send never touches the checker; the promise rejects when the cache cannot be read.
   */
  restContractFor(
    requestId: string,
    sent: { readonly method: string; readonly url: string },
  ): Promise<RestContractTarget> | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    const request = findRestRequest(this.core.open.project, requestId);
    const api = restApiOwning(this.core.open.project, requestId);
    if (request === undefined || api?.definition?.cache !== true) {
      return undefined;
    }
    // `sent.url` is the expanded URL and may carry a secret: it stays in memory for the match and is
    // never logged or stored.
    const baseUrls = [api.baseUrl, ...api.servers.map((server) => server.url)];
    return this.openApiDocumentFor(api.id).then((document) => {
      const called = operationCalled(document, request.contract, sent, baseUrls);
      if (called === undefined) {
        return {};
      }
      const { operation, declared } = called;
      return declared?.responses === undefined ? { operation } : { operation, responses: declared.responses };
    });
  }

  /**
   * The schema of the JSON body a REST request's operation declares, for the body editor's form: the
   * operation found as `restContractFor` finds it — from `sent`, the method and URL the editor holds
   * now (saved or not), else the saved ones — and its first JSON media type (`application/json` or
   * `*+json`). The schema is an acyclic copy (`toWireSchema`), because a cyclic graph cannot cross
   * IPC. `undefined` when there is no cached definition, no matching operation, or no JSON body.
   */
  async restBodySchema(
    requestId: string,
    sent?: { readonly method: string; readonly url: string },
  ): Promise<{ mediaType: string; schema: JsonSchema } | undefined> {
    if (this.core.open === undefined) {
      return undefined;
    }
    const request = findRestRequest(this.core.open.project, requestId);
    const api = restApiOwning(this.core.open.project, requestId);
    if (request === undefined || api?.definition?.cache !== true) {
      return undefined;
    }
    const baseUrls = [api.baseUrl, ...api.servers.map((server) => server.url)];
    const document = await this.openApiDocumentFor(api.id);
    const called = operationCalled(document, request.contract, sent ?? request, baseUrls);
    const content = called?.declared?.requestBody?.content ?? {};
    for (const [mediaType, media] of Object.entries(content)) {
      const bare = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
      if ((bare === 'application/json' || bare.endsWith('+json')) && media.schema !== undefined) {
        return { mediaType, schema: toWireSchema(media.schema) };
      }
    }
    return undefined;
  }

  /**
   * Where a REST API's definition came from, as the user gave it, and the credentials it was fetched
   * with, for an update to re-read it the same way.
   */
  restSource(apiId: string): { readonly source: string; readonly auth?: DefinitionAuth } {
    const { source, auth } = this.requireCachedRestApi(apiId).definition;
    return { source, ...(auth !== undefined ? { auth } : {}) };
  }

  /** What updating `apiId` to `next` would change, compared with the cached document. Changes nothing. */
  async planRestUpdate(
    apiId: string,
    next: OpenApiDocument,
  ): Promise<{
    readonly plan: RestUpdatePlan;
    readonly cached: readonly ResolvedDocument[];
    /** Whether the project currently has a webhook group linked to this API. */
    readonly linked: boolean;
  }> {
    const old = await this.readRestCache(apiId);
    const linked = linkedWebhookFolder(webhooksOf(this.core.require().project), apiId) !== undefined;
    return { plan: planRestUpdate(old.document, next), cached: old.documents, linked };
  }

  /**
   * The cached definition of a REST API, read once from disk: its documents (for a fingerprint) and
   * the document parsed from exactly those bytes, so what is compared is what was fingerprinted.
   */
  private async readRestCache(
    apiId: string,
  ): Promise<{ readonly document: OpenApiDocument; readonly documents: readonly ResolvedDocument[] }> {
    const api = this.requireCachedRestApi(apiId);
    const cached = await readApiDefinitionCache(apiDefinitionDir(this.core.require().dir, api.slug));
    const inMemory = cacheFetch(cached.documents);
    const parsed = await parseOpenApi({ kind: 'url', url: cached.manifest.rootLocation }, { fetchDocument: inMemory });
    return { document: parsed.document, documents: cached.documents };
  }

  /**
   * Lints the API's cached definition (#342) with the built-in rule sets and the project's `lint/`
   * folder. Every reference is read from the cache, never the network, so a remote one is followed
   * as safely as a local one.
   */
  async lintApi(apiId: string): Promise<LintReport> {
    const api = this.requireCachedRestApi(apiId);
    const { dir } = this.core.require();
    const cached = await readApiDefinitionCache(apiDefinitionDir(dir, api.slug));
    const fetchDocument = cacheFetch(cached.documents);
    const root = await fetchDocument(cached.manifest.rootLocation);
    return lintOpenApi(
      { text: root.text, location: root.location },
      { fetchDocument, allowRemoteRefs: true, rulesets: await readProjectLintRulesets(dir) },
    );
  }

  /**
   * Applies `next` to `apiId`: nothing is deleted (an operation that went away orphans its request)
   * and generated fields the user left alone follow the new document. The project is saved first;
   * if the save fails the in-memory project is put back as it was and the definition cache is never
   * touched. Only a successful save rewrites the cache and drops the parsed-document memo, so the
   * next response check reads the new definition.
   */
  async applyRestUpdate(
    apiId: string,
    next: ParsedOpenApi,
    options: {
      /** Becomes the API's recorded definition source. */
      readonly source?: string;
      /**
       * The credentials `source` was read with. Only looked at with a `source`: the stored ones are then
       * replaced, and absent clears them, so a credential never follows the API to a source it was not
       * given for. Without a `source` the stored credentials stay as they are.
       */
      readonly auth?: DefinitionAuth;
      /**
       * Sees the cached documents the update compares against before anything changes; throwing
       * refuses the update (the IPC layer's fingerprint guard).
       */
      readonly check?: (cached: readonly ResolvedDocument[]) => void | Promise<void>;
    } = {},
  ): Promise<{
    readonly project: ProjectWire;
    readonly plan: RestUpdatePlan;
    /** Whether the project has a webhook group linked to this API. */
    readonly linked: boolean;
    readonly applied: Omit<RestApplyResult, 'api'> & {
      /** What the same update did to the webhook group linked to this API, applied alongside it. */
      readonly webhooks: {
        readonly added: number;
        readonly orphaned: number;
        readonly restored: number;
        readonly rewritten: number;
      };
    };
    /** Set when the update was saved but the definition cache could not be rewritten afterwards. */
    readonly warning?: string;
  }> {
    const { source, auth, check } = options;
    const cache = await this.readRestCache(apiId);
    await check?.(cache.documents);
    // Read after every wait: an edit made meanwhile is the base the update applies to.
    const open = this.core.require();
    const api = this.requireCachedRestApi(apiId);
    const old = cache.document;
    const plan = planRestUpdate(old, next.document);
    const { api: mapped, ...restApplied } = applyRestUpdate(api, old, next.document);
    // `requireCachedRestApi` proved the definition is there; the engine only ever rewrites its
    // `version`, which this sets itself.
    const { auth: storedAuth, ...recorded } = api.definition;
    const nextAuth = source !== undefined ? auth : storedAuth;
    const updated: RestApi = {
      ...mapped,
      definition: {
        ...recorded,
        version: next.document.declaredVersion,
        ...(source !== undefined ? { source } : {}),
        ...(nextAuth !== undefined ? { auth: nextAuth } : {}),
      },
    };

    // The linked webhook group, if any, is updated in the same change: one undo step, one save.
    const linked = linkedWebhookFolder(webhooksOf(open.project), apiId);
    let webhookResult: WebhookApplyResult | undefined;
    let webhooks = webhooksOf(open.project);
    if (linked !== undefined && webhooks !== undefined) {
      webhookResult = applyWebhookUpdate(linked, old, next.document);
      const folders = mapFolder(webhooks.folders, linked.id, () => webhookResult!.folder);
      if (folders !== undefined) {
        webhooks = { ...webhooks, folders: folders as unknown as WebhookFolder[] };
      }
    }
    const applied = {
      ...restApplied,
      webhooks: {
        added: webhookResult?.added ?? 0,
        orphaned: webhookResult?.orphaned ?? 0,
        restored: webhookResult?.restored ?? 0,
        rewritten: webhookResult?.rewritten ?? 0,
      },
    };

    const priorProject = open.project;
    const priorDirty = open.dirty;
    const withApi: Project = {
      ...open.project,
      containers: {
        ...open.project.containers,
        rest: restApisOf(open.project).map((candidate) => (candidate.id === apiId ? updated : candidate)),
      },
    };
    open.project = webhooks !== webhooksOf(open.project) ? withWebhooks(withApi, webhooks) : withApi;
    open.dirty = true;
    try {
      await this.core.save({ reason: 'update-definition' });
    } catch (error) {
      // Nothing else was touched yet: undoing the model leaves everything as it was.
      open.project = priorProject;
      open.dirty = priorDirty;
      throw error;
    }

    let warning: string | undefined;
    const file = `apis/${updated.slug}/definition`;
    try {
      await writeApiDefinitionCache(next.documents, apiDefinitionDir(open.dir, updated.slug), {
        declaredVersion: next.document.declaredVersion,
      });
      // A retry that worked clears the last failure's problem rather than leaving it to mislead.
      open.problems = open.problems.filter(
        (problem) => !(problem.code === 'definition-cache-write-failed' && problem.file === file),
      );
    } catch (error) {
      // Reported, not thrown: the project is already saved, so telling the caller the update failed
      // would be untrue. The stale cache only means the next update re-runs this one idempotently.
      warning =
        'The update was saved, but the stored copy of the definition could not be refreshed, so the next preview may be wrong: ' +
        errorMessage(error);
      // One entry per API, replaced: repeated failures must not grow the list without bound.
      open.problems = [
        ...open.problems.filter(
          (problem) => !(problem.code === 'definition-cache-write-failed' && problem.file === file),
        ),
        { code: 'definition-cache-write-failed', message: warning, file },
      ];
    } finally {
      // Dropped even if the write failed: a half-written cache must be read afresh, not remembered.
      this.openApiDocuments.delete(apiId);
    }
    return {
      project: this.core.snapshot() as ProjectWire,
      plan,
      linked: linked !== undefined,
      applied,
      ...(warning !== undefined ? { warning } : {}),
    };
  }

  /**
   * An API's webhooks and callbacks, from its cached definition, and which of their keys the group
   * linked to it already holds — what the *Import webhooks…* picker offers and pre-ticks.
   *
   * @throws ProjectError `webhook-definition-missing` when the API has no readable cached definition
   */
  async webhookItems(
    apiId: string,
  ): Promise<{ readonly items: readonly WebhookItemRef[]; readonly imported: readonly string[] }> {
    const document = await this.cachedRestDocumentForWebhooks(apiId);
    const linked = linkedWebhookFolder(webhooksOf(this.core.require().project), apiId);
    return { items: webhookItemsOf(document), imported: linked !== undefined ? [...webhookKeysUnder(linked)] : [] };
  }

  /**
   * Places the chosen webhooks and callbacks (by {@link WebhookItemRef.key}) into the group linked to
   * `apiId`, creating one if there is none yet. Only keys not already in the group are added, with a
   * unique slug and the next order, as a fresh import's group gets — so calling this again for what
   * was left unticked the first time never duplicates an item. Saves immediately, as an import does.
   *
   * @throws ProjectError `webhook-definition-missing` when the API has no readable cached definition
   */
  async importWebhooks(
    apiId: string,
    keys: readonly string[],
  ): Promise<{ readonly folderId: string; readonly added: number }> {
    const document = await this.cachedRestDocumentForWebhooks(apiId);
    const open = this.core.require();
    const linked = linkedWebhookFolder(webhooksOf(open.project), apiId);
    const mapped = webhooksFromDocument(document, { apiId, only: new Set(keys) });

    let project: Project;
    let folderId: string;
    let added: number;
    if (linked === undefined) {
      if (mapped === undefined) {
        throw new ProjectError(
          'project-entity-not-found',
          'None of the given keys are webhooks or callbacks of this API',
          { details: { apiId } },
        );
      }
      const result = addWebhookGroup(open.project, mapped.folder, this.core.workspaceContext?.()?.workspace.properties);
      project = result.project;
      folderId = result.createdId ?? mapped.folder.id;
      added = mapped.items;
    } else {
      const already = webhookKeysUnder(linked);
      const toAdd = (mapped?.folder.requests ?? []).filter(
        (request) => request.hook !== undefined && !already.has(hookKey(request.hook, request.method)),
      );
      const result = appendWebhookItems(open.project, linked.id, toAdd);
      project = result.project;
      folderId = linked.id;
      added = toAdd.length;
    }

    open.project = project;
    open.dirty = true;
    await this.core.save({ reason: 'import' });
    return { folderId, added };
  }

  /**
   * A REST API's cached definition, read the way {@link planRestUpdate} reads the old document, for
   * the webhook endpoints: any reason it cannot be read becomes `webhook-definition-missing`, since
   * without it there are no webhooks or callbacks to offer.
   */
  private async cachedRestDocumentForWebhooks(apiId: string): Promise<OpenApiDocument> {
    try {
      return (await this.readRestCache(apiId)).document;
    } catch (error) {
      throw new ProjectError(
        'webhook-definition-missing',
        'This API has no cached definition to read webhooks from. Import it again instead.',
        { details: { apiId, cause: errorMessage(error) } },
      );
    }
  }

  /** A REST API that cached its definition, or `definition-not-cached`: without it there is nothing to compare. */
  private requireCachedRestApi(apiId: string): RestApi & { readonly definition: NonNullable<RestApi['definition']> } {
    const api = this.requireApi(apiId);
    if (api.definition?.cache !== true) {
      throw new ProjectError(
        'definition-not-cached',
        'This API did not cache its definition, so there is nothing to compare an update against. Import it again instead.',
        { details: { apiId } },
      );
    }
    return api as RestApi & { readonly definition: NonNullable<RestApi['definition']> };
  }

  /** The open project's API with `apiId`, or a `not-found` error. */
  private requireApi(apiId: string): RestApi {
    const api = restApisOf(this.core.require().project).find((candidate) => candidate.id === apiId);
    if (api === undefined) {
      throw new ProjectError('not-found', `No API with id "${apiId}"`, { details: { id: apiId } });
    }
    return api;
  }
  /** Whether `apiId` is one of the open project's REST APIs. */
  ownsApi(apiId: string): boolean {
    return restApisOf(this.core.require().project).some((api) => api.id === apiId);
  }

  /**
   * The documents cached for `apiId`, read from its own folder.
   *
   * Nothing is re-fetched to answer this: an API whose definition was not cached has no documents
   * to show, and says so with `definition-cache-missing` rather than reaching the network behind
   * the user's back.
   */
  async apiDefinitionDocuments(apiId: string): Promise<ApiDefinitionDocuments> {
    const api = this.requireApi(apiId);
    const cached = await readApiDefinitionCache(apiDefinitionDir(this.core.require().dir, api.slug));
    return {
      documents: cached.manifest.documents.map((document) => ({ location: document.location, size: document.bytes })),
      rootLocation: cached.manifest.rootLocation,
      fetchedAt: cached.manifest.fetchedAt,
      ...(cached.manifest.declaredVersion !== undefined ? { declaredVersion: cached.manifest.declaredVersion } : {}),
    };
  }

  /**
   * One cached document's text, matched by the location the manifest records.
   *
   * The renderer names a location, never a path: a document the manifest does not list is an
   * `unknown-document` error, so this can never be turned into a read of an arbitrary file.
   */
  async apiDefinitionText(apiId: string, location: string): Promise<string> {
    const api = this.requireApi(apiId);
    const cached = await readApiDefinitionCache(apiDefinitionDir(this.core.require().dir, api.slug));
    const document = cached.documents.find((candidate) => candidate.location === location);
    if (document === undefined) {
      throw new ProjectError('not-found', `No document "${location}" in this API's definition`, {
        details: { apiId, location },
      });
    }
    return document.text;
  }

  /** Writes every cached document of `apiId` into `dir`, byte for byte, returning the file names. */
  async exportApiDefinitionTo(apiId: string, dir: string): Promise<string[]> {
    const api = this.requireApi(apiId);
    const cacheDir = apiDefinitionDir(this.core.require().dir, api.slug);
    const cached = await readApiDefinitionCache(cacheDir);
    await mkdir(dir, { recursive: true });
    const written: string[] = [];
    for (const entry of cached.manifest.documents) {
      const document = cached.documents.find((candidate) => candidate.location === entry.location);
      if (document === undefined) {
        continue;
      }
      // Atomic: a name appearing in the directory must mean the bytes are all there. Exporting
      // non-atomically let a reader that waited for the *listing* — as `openapi-import.spec.ts`
      // does — open a file that existed but was still empty.
      await writeFileAtomic(nodeFs, join(dir, entry.file), Buffer.from(document.bytes));
      written.push(entry.file);
    }
    return written;
  }
}

/** Reads only what the definition cache holds, by requested or final location; anything else is refused. */
function cacheFetch(documents: readonly ResolvedDocument[]) {
  const byLocation = new Map<string, ResolvedDocument>();
  for (const document of documents) {
    byLocation.set(document.requestedLocation, document);
    byLocation.set(document.location, document);
  }
  return (location: string): Promise<{ location: string; bytes: Uint8Array; text: string }> => {
    const document = byLocation.get(location);
    if (document === undefined) {
      return Promise.reject(
        new ProjectError('definition-cache-missing', `"${location}" is not in this API's definition cache`, {
          details: { location },
        }),
      );
    }
    return Promise.resolve({ location: document.location, bytes: document.bytes, text: document.text });
  };
}
