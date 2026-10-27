/**
 * WebSocket's share of an open project's host (spec §5.3): its caches and the methods that are
 * about WebSocket alone, built once per open project on the {@link ProjectHostCore} the host
 * passes in, and reached as `ProjectHost.kind('websocket')`.
 */

import {
  apiDefinitionDir,
  applyAsyncApiUpdate,
  asyncApiChannelMessages,
  createCachedApiFetch,
  nextApiOrder,
  parseAsyncApi,
  planAsyncApiUpdate,
  ProjectError,
  readApiDefinitionCache,
  uniqueSlug,
  writeApiDefinitionCache,
  wsApisOf,
} from '@wirebench/engine';
import type {
  AsyncApiApplyResult,
  AsyncApiDocument,
  AsyncApiUpdatePlan,
  ChannelMessages,
  DefinitionAuth,
  ParsedAsyncApi,
  ResolvedDocument,
  WsApi,
} from '@wirebench/engine';
import type { ProjectWire } from '@wirebench/wire/wire-types';
import { takenApiSlugs } from '../../project-api-mutations.js';
import { findWsRequest, locateWsRequest, wsApiOwning } from './mutations.js';
import type { AsyncApiDefinitionInfo } from '../../project-wire.js';
import type { ProjectHostCore } from '../../project-host-core.js';
import type { KindHostHooks } from '../kind-main.js';
import type { ProjectWireContext } from '../../project-wire.js';

export class WsHost implements KindHostHooks {
  constructor(private readonly core: ProjectHostCore) {}

  /** A contract memo belongs to the project's cache folder; a reopen reads it again. */
  close(): void {
    this.asyncApiContracts.clear();
    this.asyncApiInfo.clear();
  }

  /** The Definition card's version and servers of each AsyncAPI-imported API read so far. */
  wireOptions(): Partial<ProjectWireContext> {
    return { asyncApiInfo: this.asyncApiInfo };
  }

  /** Each AsyncAPI-imported API's parsed contract, read from its cache once per session and API. */
  private readonly asyncApiContracts = new Map<string, Promise<AsyncApiDocument | undefined>>();
  /** The version and WebSocket servers of each cached AsyncAPI document read so far, for the Definition card. */
  private readonly asyncApiInfo = new Map<string, AsyncApiDefinitionInfo>();

  /** What History names a WebSocket send by: the request, its API, and the folder path inside it. */
  wsMeta(
    requestId: string,
  ): { readonly requestName: string; readonly apiName: string; readonly folderPath: string } | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    const located = locateWsRequest(this.core.open.project, requestId);
    if (located === undefined) {
      return undefined;
    }
    return {
      requestName: located.request.name,
      apiName: located.api.name,
      folderPath: located.folders.map((folder) => folder.name).join(' / '),
    };
  }

  /**
   * Places a WebSocket API an importer mapped from a file that is not a contract (a `.http` file):
   * only the slug and the order are settled here, and it records no definition, so nothing offers to
   * update it from one. Saves immediately, as every import does.
   */
  async importWsApi(input: { readonly api: WsApi }): Promise<{ project: ProjectWire; apiId: string }> {
    const open = this.core.require();
    const project = open.project;
    if (input.api.definition !== undefined) {
      // A contract-backed API carries its cache and source; `importAsyncApi` is the way in for one.
      throw new ProjectError('invalid-argument', 'A WebSocket API with a definition is placed by importAsyncApi', {
        details: { id: input.api.id },
      });
    }
    const api: WsApi = {
      ...input.api,
      slug: uniqueSlug(input.api.name, takenApiSlugs(project)),
      order: nextApiOrder(project),
    };
    open.project = { ...project, containers: { ...project.containers, websocket: [...wsApisOf(project), api] } };
    open.dirty = true;
    await this.core.save({ reason: 'import' });
    return { project: this.core.snapshot() as ProjectWire, apiId: api.id };
  }

  /**
   * Places a WebSocket API imported from an AsyncAPI document, caching the documents it was made
   * of under `apis/<slug>/definition/` with the root as `asyncapi.yaml` — the same cache layout an
   * OpenAPI import writes, so Update Definition can read the old document back.
   *
   * The API arrives fully mapped (`importAsyncApi` in the engine); only the slug, the order and the
   * definition record are settled here. Credentials the document describes arrive empty and stay
   * so: the import never has a secret to write. Saves immediately, as every import does.
   */
  async importAsyncApi(input: {
    readonly api: WsApi;
    readonly documents: readonly ResolvedDocument[];
    /** Where the user pointed at, recorded on the API as its definition's source. */
    readonly source: string;
    /** The `asyncapi` string the document declared. */
    readonly declaredVersion: string;
    /** The server key the API was mapped against, kept so an update maps against the same one. */
    readonly server?: string;
    /** Write the definition cache. Defaults to the definition-caching preference. */
    readonly cache?: boolean;
    /** The credentials the document was fetched with, kept so Update Definition can fetch it again. */
    readonly auth?: DefinitionAuth;
  }): Promise<{ project: ProjectWire; apiId: string }> {
    const open = this.core.require();
    const slug = uniqueSlug(input.api.name, takenApiSlugs(open.project));
    // One definition-caching preference covers every import kind; it lives under `wsdl` for history.
    const cache = input.cache ?? this.core.prefs()?.wsdl.cacheDefinitions ?? true;

    if (cache) {
      await writeApiDefinitionCache(input.documents, apiDefinitionDir(open.dir, slug), {
        declaredVersion: input.declaredVersion,
        rootFile: 'asyncapi.yaml',
      });
    }

    const project = open.project;
    const api: WsApi = {
      ...input.api,
      slug,
      order: nextApiOrder(project),
      definition: {
        kind: 'asyncapi',
        source: input.source,
        cache,
        ...(input.server !== undefined ? { server: input.server } : {}),
        ...(input.auth !== undefined ? { auth: input.auth } : {}),
      },
    };
    open.project = { ...project, containers: { ...project.containers, websocket: [...wsApisOf(project), api] } };
    open.dirty = true;
    await this.core.save({ reason: 'import' });
    // Read the cache just written, so the Definition card has the version and servers at once.
    // The memo is dropped again: a live session reads the contract when it first needs it.
    await this.asyncApiContractFor(api.id).catch(() => undefined);
    this.asyncApiContracts.delete(api.id);
    return { project: this.core.snapshot() as ProjectWire, apiId: api.id };
  }

  /** The open project's AsyncAPI-imported WebSocket API with `apiId`, or a `not-found` error. */
  private requireAsyncApi(apiId: string): WsApi & { readonly definition: NonNullable<WsApi['definition']> } {
    const api = wsApisOf(this.core.require().project).find((candidate) => candidate.id === apiId);
    if (api?.definition?.kind !== 'asyncapi') {
      throw new ProjectError('not-found', `No AsyncAPI-imported API with id "${apiId}"`, { details: { id: apiId } });
    }
    return api as WsApi & { readonly definition: NonNullable<WsApi['definition']> };
  }

  /**
   * The contract an AsyncAPI-imported API was made from, parsed from its definition cache — never
   * the network — and kept for the session; `undefined` for an API with no cached definition. A
   * failed read is not remembered, so a fixed cache is read again on the next ask. An update drops it.
   */
  asyncApiContractFor(apiId: string): Promise<AsyncApiDocument | undefined> {
    const known = this.asyncApiContracts.get(apiId);
    if (known !== undefined) {
      return known;
    }
    const api = wsApisOf(this.core.require().project).find((candidate) => candidate.id === apiId);
    if (api?.definition?.kind !== 'asyncapi' || !api.definition.cache) {
      return Promise.resolve(undefined);
    }
    const dir = apiDefinitionDir(this.core.require().dir, api.slug);
    const loading = readApiDefinitionCache(dir).then(async (cached) => {
      const offline = createCachedApiFetch(cached.manifest, dir, (location) =>
        Promise.reject(
          new ProjectError('definition-cache-missing', `"${location}" is not in this API's definition cache`, {
            details: { location },
          }),
        ),
      );
      const parsed = await parseAsyncApi(
        { kind: 'url', url: cached.manifest.rootLocation },
        { fetchDocument: offline },
      );
      this.rememberAsyncApiInfo(apiId, parsed.document);
      return parsed.document;
    });
    loading.catch(() => {
      if (this.asyncApiContracts.get(apiId) === loading) {
        this.asyncApiContracts.delete(apiId);
      }
    });
    this.asyncApiContracts.set(apiId, loading);
    return loading;
  }

  /**
   * The messages of the channel a WebSocket request was imported from, for checking its live frames;
   * `undefined` (not a promise) when the request has no contract link, so a session without one
   * never starts a checker. The promise rejects when the cache cannot be read.
   */
  wsContractFor(requestId: string): Promise<ChannelMessages | undefined> | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    const request = findWsRequest(this.core.open.project, requestId);
    const api = wsApiOwning(this.core.open.project, requestId);
    if (request?.contract === undefined || api?.definition?.kind !== 'asyncapi') {
      return undefined;
    }
    const channel = request.contract.channel;
    return this.asyncApiContractFor(api.id).then((document) =>
      document === undefined ? undefined : asyncApiChannelMessages(document, channel),
    );
  }

  /**
   * Where an AsyncAPI-imported API's definition came from, as the user gave it, and the credentials
   * it was fetched with, for an update to re-read it the same way.
   */
  asyncApiSource(apiId: string): { readonly source: string; readonly auth?: DefinitionAuth } {
    const { source, auth } = this.requireAsyncApi(apiId).definition;
    return { source, ...(auth !== undefined ? { auth } : {}) };
  }

  /** What updating `apiId` to `next` would change, compared with the cached document. Changes nothing. */
  async planAsyncApiUpdate(apiId: string, next: AsyncApiDocument): Promise<AsyncApiUpdatePlan> {
    return planAsyncApiUpdate(await this.cachedAsyncApi(apiId), next);
  }

  /**
   * Applies `next` to `apiId`: nothing is deleted (a channel that went away orphans its request),
   * the definition cache is rewritten with the new documents, the memoised contract is dropped so
   * the next session is checked against the new one, and the project is saved.
   */
  async applyAsyncApiUpdate(
    apiId: string,
    next: ParsedAsyncApi,
  ): Promise<{
    readonly project: ProjectWire;
    readonly plan: AsyncApiUpdatePlan;
    readonly applied: Omit<AsyncApiApplyResult, 'api'>;
  }> {
    const open = this.core.require();
    const api = this.requireAsyncApi(apiId);
    const old = await this.cachedAsyncApi(apiId);
    const plan = planAsyncApiUpdate(old, next.document);
    const { api: updated, ...applied } = applyAsyncApiUpdate(api, old, next.document, {
      ...(api.definition.server !== undefined ? { server: api.definition.server } : {}),
    });
    if (api.definition.cache) {
      await writeApiDefinitionCache(next.documents, apiDefinitionDir(open.dir, api.slug), {
        declaredVersion: next.document.declaredVersion,
        rootFile: 'asyncapi.yaml',
      });
    }
    this.asyncApiContracts.delete(apiId);
    this.rememberAsyncApiInfo(apiId, next.document);
    open.project = {
      ...open.project,
      containers: {
        ...open.project.containers,
        websocket: wsApisOf(open.project).map((candidate) => (candidate.id === apiId ? updated : candidate)),
      },
    };
    open.dirty = true;
    await this.core.save({ reason: 'update-definition' });
    return { project: this.core.snapshot() as ProjectWire, plan, applied };
  }

  /** Keeps what the Definition card shows of a cached document: its version and WebSocket servers. */
  private rememberAsyncApiInfo(apiId: string, document: AsyncApiDocument): void {
    this.asyncApiInfo.set(apiId, {
      version: document.declaredVersion,
      servers: document.servers
        .filter((server) => ['ws', 'wss'].includes(server.protocol.toLowerCase()))
        .map((server) => server.key),
    });
  }

  /** The cached document an update compares against; an API with no cache cannot be updated. */
  private async cachedAsyncApi(apiId: string): Promise<AsyncApiDocument> {
    this.requireAsyncApi(apiId);
    const old = await this.asyncApiContractFor(apiId);
    if (old === undefined) {
      throw new ProjectError(
        'definition-cache-missing',
        'This API did not cache its definition, so there is nothing to compare an update against',
        {
          details: { apiId },
        },
      );
    }
    return old;
  }
}
