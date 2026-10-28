/**
 * gRPC's share of an open project's host (spec §5.3): its caches and the methods that are
 * about gRPC alone, built once per open project on the {@link ProjectHostCore} the host
 * passes in, and reached as `ProjectHost.kind('grpc')`.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  apiDefinitionDir,
  describeMessageAt,
  describeServices,
  DESCRIPTORS_FILE,
  descriptorSetBytes,
  expand,
  grpcApisOf,
  loadProtoSet,
  nextApiOrder,
  nodeFs,
  ProjectError,
  protoPathSegments,
  PROTOS_DIR,
  protoSetFromDescriptorSet,
  readGrpcDefinitionCache,
  reconcileGrpcApi,
  reflectProtoSet,
  sampleMessageText,
  uniqueSlug,
  writeDescriptorDefinitionCache,
  writeFileAtomic,
  writeProtoDefinitionCache,
} from '@wirebench/engine';
import type {
  AuthConfig,
  GrpcApi,
  GrpcReconcileResult,
  GrpcReflectionVersion,
  GrpcServiceDescriptor,
  MessageDescriptor,
  ProtoImportSummary,
  ProtoSet,
  ProtoSources,
  TlsOptions,
} from '@wirebench/engine';
import type { ProjectChange, ProjectWire } from '@wirebench/wire/wire-types';
import { takenApiSlugs } from '../../project-api-mutations.js';
import { findGrpcFolder, findGrpcRequest, grpcApiOwning, locateGrpcRequest } from './mutations.js';
import type { ProjectHostCore } from '../../project-host-core.js';
import type { ApiDefinitionDocuments, KindApiDefinitions, KindHostHooks } from '../kind-main.js';

/**
 * What a gRPC API's definition arrived as, which decides the cache it is written to: the `.proto`
 * text of an import, or the descriptor set a server described itself with.
 */
export type GrpcDefinitionInput =
  | { readonly kind: 'proto'; readonly sources: ProtoSources }
  | {
      readonly kind: 'reflection';
      readonly descriptors: Uint8Array;
      readonly version: 'v1' | 'v1alpha';
      readonly trustInvalid?: boolean;
    };

/** How long a discovery waits for a server to describe itself. */
const GRPC_REFLECTION_TIMEOUT_MS = 30_000;

export class GrpcHost implements KindHostHooks {
  constructor(private readonly core: ProjectHostCore) {}

  readonly apiDefinitions: KindApiDefinitions = this;

  /** A removed API's parsed `.proto` set goes with it. */
  afterChange(change: ProjectChange): void {
    if (change.kind === 'remove-grpc-api') {
      this.protoSets.delete(change.apiId);
    }
  }

  /**
   * Loaded `.proto` sets, keyed by gRPC API id. A set is parsed once per API from its cache and
   * kept for the session — every send and every method-picker refresh reads from it — and dropped
   * when the API is removed or re-imported.
   */
  private readonly protoSets = new Map<string, Promise<ProtoSet>>();

  /** The credentials configured on one gRPC API, folder or request — its own, not its chain's. */
  grpcAuthOf(ownerId: string): AuthConfig | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    const project = this.core.open.project;
    const api = grpcApisOf(project).find((candidate) => candidate.id === ownerId);
    if (api !== undefined) {
      return api.auth;
    }
    return findGrpcFolder(project, ownerId)?.auth ?? findGrpcRequest(project, ownerId)?.auth;
  }

  /** What History names a gRPC send by: the request, its API, and the folder path inside it. */
  grpcMeta(requestId: string):
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
    const located = locateGrpcRequest(this.core.open.project, requestId);
    if (located === undefined) {
      return undefined;
    }
    return {
      requestName: located.request.name,
      apiName: located.api.name,
      folderPath: located.folders.map((folder) => folder.name).join(' / '),
    };
  }

  /** The gRPC API that is, or that holds, `entityId`. */
  private grpcApiOf(entityId: string): GrpcApi | undefined {
    const project = this.core.require().project;
    return grpcApisOf(project).find((api) => api.id === entityId) ?? grpcApiOwning(project, entityId);
  }

  /**
   * The loaded `.proto` set of the gRPC API that is, or holds, `entityId`, parsed from the API's
   * definition cache and kept for the session.
   *
   * @throws ProjectError `not-found` for an id no gRPC API owns, `definition-cache-missing` for an
   * API whose files were never cached — a send then has no schema to encode against, and says so
   * rather than guessing
   */
  grpcProtoSetFor(entityId: string): Promise<ProtoSet> {
    const api = this.grpcApiOf(entityId);
    if (api === undefined) {
      throw new ProjectError('not-found', `No gRPC API owns "${entityId}"`, { details: { id: entityId } });
    }
    const cached = this.protoSets.get(api.id);
    if (cached !== undefined) {
      return cached;
    }
    const dir = this.core.require().dir;
    const loading = readGrpcDefinitionCache(apiDefinitionDir(dir, api.slug)).then((cache) =>
      cache.kind === 'proto'
        ? loadProtoSet(cache.sources, { roots: cache.manifest.roots })
        : protoSetFromDescriptorSet(cache.descriptors, { roots: cache.manifest.roots }),
    );
    // A failed load is not remembered: the user may fix the cache (a re-import) and try again.
    loading.catch(() => {
      this.protoSets.delete(api.id);
    });
    this.protoSets.set(api.id, loading);
    return loading;
  }

  /** The services and files of a gRPC API's cached definition, for the method picker and the card. */
  async grpcDefinition(apiId: string): Promise<{
    readonly services: readonly GrpcServiceDescriptor[];
    readonly files: readonly { readonly path: string; readonly size: number }[];
    readonly source: string;
    readonly fetchedAt: string;
    readonly roots: readonly string[];
    readonly kind: 'proto' | 'reflection';
    readonly reflectionVersion?: 'v1' | 'v1alpha';
  }> {
    const api = this.requireGrpcApi(apiId);
    const cache = await readGrpcDefinitionCache(apiDefinitionDir(this.core.require().dir, api.slug));
    const set = await this.grpcProtoSetFor(apiId);
    // A discovered definition is one binary file; an imported one is the `.proto` files themselves.
    const files =
      cache.kind === 'proto'
        ? cache.manifest.files.map((file) => ({ path: file.path, size: file.bytes }))
        : [{ path: cache.manifest.file.path, size: cache.manifest.file.bytes }];
    return {
      services: describeServices(set),
      files,
      source: cache.manifest.source,
      fetchedAt: cache.manifest.fetchedAt,
      roots: cache.manifest.roots,
      kind: cache.kind === 'proto' ? 'proto' : 'reflection',
      ...(cache.kind === 'descriptors' && cache.manifest.reflectionVersion !== undefined
        ? { reflectionVersion: cache.manifest.reflectionVersion }
        : {}),
    };
  }

  /** A sample message for one type of a gRPC API's definition, as pretty JSON text. */
  async grpcSample(apiId: string, type: string): Promise<string> {
    return sampleMessageText(await this.grpcProtoSetFor(apiId), type);
  }

  /**
   * The fields of the message reached by walking `path` — a chain of JSON object keys — down from
   * `type`, for the message editor's completion provider.
   *
   * A path that names nothing answers no fields rather than failing: the provider asks about a
   * document the user is in the middle of typing, where a key that resolves to nothing is the
   * normal case. An unknown `type` still fails, since that is the caller's own mistake.
   */
  async grpcFields(apiId: string, type: string, path: readonly string[]): Promise<MessageDescriptor | undefined> {
    return describeMessageAt(await this.grpcProtoSetFor(apiId), type, path);
  }

  /** The open project's gRPC API with `apiId`, or a `not-found` error. */
  private requireGrpcApi(apiId: string): GrpcApi {
    const api = grpcApisOf(this.core.require().project).find((candidate) => candidate.id === apiId);
    if (api === undefined) {
      throw new ProjectError('not-found', `No gRPC API with id "${apiId}"`, { details: { id: apiId } });
    }
    return api;
  }

  /**
   * Writes a gRPC API's definition cache, in whichever of the two forms it arrived in, and tells the
   * watcher the files are this host's own work — an import would otherwise end with a "changed on
   * disk — reload" banner over its own write.
   */
  private async writeGrpcDefinition(
    definitionDir: string,
    source: string,
    roots: readonly string[],
    definition: GrpcDefinitionInput,
  ): Promise<void> {
    if (definition.kind === 'proto') {
      const manifest = await writeProtoDefinitionCache(definition.sources, definitionDir, { source, roots });
      this.core.expectOnDisk([
        join(definitionDir, 'manifest.yaml'),
        ...manifest.files.map((file) => join(definitionDir, PROTOS_DIR, ...protoPathSegments(file.path))),
      ]);
      return;
    }
    await writeDescriptorDefinitionCache(definition.descriptors, definitionDir, {
      source,
      roots,
      reflectionVersion: definition.version,
    });
    this.core.expectOnDisk([join(definitionDir, 'manifest.yaml'), join(definitionDir, DESCRIPTORS_FILE)]);
  }

  /**
   * Places an imported or discovered gRPC API in the project, caching what it was made of under its
   * own folder once the slug is settled — as {@link addApi} does for an OpenAPI import.
   * Saves immediately: an import is never lost to a crash.
   */
  async addGrpcApi(
    input: {
      readonly api: GrpcApi;
      readonly roots: readonly string[];
      /** Where the user pointed at, recorded on the API as its definition's source. */
      readonly source: string;
      readonly cache?: boolean;
      /** The version the user asked for, remembered so a refresh asks the same way. */
      readonly requestedVersion?: GrpcReflectionVersion;
    } & GrpcDefinitionInput,
  ): Promise<{ project: ProjectWire; apiId: string }> {
    const open = this.core.require();
    const slug = uniqueSlug(input.api.name, takenApiSlugs(open.project));
    const cache = input.cache ?? this.core.prefs()?.wsdl.cacheDefinitions ?? true;
    if (cache) {
      await this.writeGrpcDefinition(apiDefinitionDir(open.dir, slug), input.source, input.roots, input);
    }
    const api: GrpcApi = {
      ...input.api,
      slug,
      order: nextApiOrder(open.project),
      definition: {
        kind: input.kind === 'proto' ? 'proto' : 'reflection',
        source: input.source,
        cache,
        roots: [...input.roots],
        ...(input.kind === 'reflection'
          ? {
              reflectionVersion: input.requestedVersion ?? 'auto',
              ...(input.trustInvalid ? { trustInvalid: true } : {}),
            }
          : {}),
      },
    };
    open.project = {
      ...open.project,
      containers: { ...open.project.containers, grpc: [...grpcApisOf(open.project), api] },
    };
    open.dirty = true;
    this.protoSets.delete(api.id);
    // The schema was just resolved for the import; keep it rather than re-reading the cache on the
    // first send.
    this.protoSets.set(
      api.id,
      Promise.resolve(
        input.kind === 'proto'
          ? loadProtoSet(input.sources, { roots: input.roots })
          : protoSetFromDescriptorSet(input.descriptors, { roots: input.roots }),
      ),
    );
    await this.core.save({ reason: 'import' });
    return { project: this.core.snapshot() as ProjectWire, apiId: api.id };
  }

  /**
   * Asks a reflection-sourced API's server to describe itself again, rewrites its cache and brings
   * the request tree in line with what came back.
   *
   * Nothing is deleted: {@link reconcileGrpcApi} keeps a request whose method is gone and badges it
   * orphaned instead, and adds one for a method the server has gained.
   *
   * @throws ProjectError `not-found` for an id no gRPC API owns, `definition-not-discovered` for an
   * API that was imported from files rather than discovered
   */
  async refreshGrpcDefinition(
    apiId: string,
    options: { readonly version?: GrpcReflectionVersion; readonly signal?: AbortSignal } = {},
  ): Promise<{
    readonly project: ProjectWire;
    readonly summary: ProtoImportSummary & { readonly name: string; readonly target: string };
    readonly reconciled: GrpcReconcileResult;
    readonly version: 'v1' | 'v1alpha';
  }> {
    const open = this.core.require();
    const api = this.requireGrpcApi(apiId);
    const definition = api.definition;
    if (definition === undefined || definition.kind !== 'reflection') {
      throw new ProjectError(
        'definition-not-discovered',
        `"${api.name}" was imported from .proto files; there is no server to ask`,
        { details: { apiId } },
      );
    }
    const version = options.version ?? definition.reflectionVersion ?? 'auto';
    const trustInvalid = definition.trustInvalid === true;
    const tlsOptions = await this.grpcDiscoveryTls(trustInvalid);
    const expanded = expand(api.target, this.core.scopesFor()).text.trim();
    const discovered = await reflectProtoSet({
      // An API whose target is still blank is asked at the address it was discovered from.
      target: expanded === '' ? definition.source : expanded,
      tls: api.tls,
      metadata: [],
      timeoutMs: GRPC_REFLECTION_TIMEOUT_MS,
      version,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(tlsOptions !== undefined ? { tlsOptions } : {}),
      ...(this.core.hooks.egress !== undefined ? { egress: this.core.hooks.egress } : {}),
    });
    const reconciled = reconcileGrpcApi(api, discovered.set);
    const next: GrpcApi = {
      ...reconciled.api,
      definition: {
        ...definition,
        roots: [...discovered.roots],
        reflectionVersion: version,
      },
    };
    if (definition.cache) {
      await this.writeGrpcDefinition(apiDefinitionDir(open.dir, api.slug), definition.source, discovered.roots, {
        kind: 'reflection',
        descriptors: descriptorSetBytes(discovered.files),
        version: discovered.version,
      });
    }
    open.project = {
      ...open.project,
      containers: {
        ...open.project.containers,
        grpc: grpcApisOf(open.project).map((candidate) => (candidate.id === api.id ? next : candidate)),
      },
    };
    open.dirty = true;
    this.protoSets.set(api.id, Promise.resolve(discovered.set));
    await this.core.save({ reason: 'import' });
    const services = describeServices(discovered.set);
    return {
      project: this.core.snapshot() as ProjectWire,
      summary: {
        name: next.name,
        target: next.target,
        files: discovered.files.size,
        services: services.length,
        methods: services.reduce((total, service) => total + service.methods.length, 0),
        deprecated: services.reduce(
          (total, service) => total + service.methods.filter((method) => method.deprecated === true).length,
          0,
        ),
      },
      reconciled: { ...reconciled, api: next },
      version: discovered.version,
    };
  }

  /** The TLS material a discovery uses: the configured trust anchors, and the user's trust decision. */
  async grpcDiscoveryTls(trustInvalid: boolean): Promise<TlsOptions | undefined> {
    const ca = await this.core.trustAnchors();
    if (ca === undefined && !trustInvalid) {
      return undefined;
    }
    return { ...(ca !== undefined ? { ca: [...ca] } : {}), ...(trustInvalid ? { rejectUnauthorized: false } : {}) };
  }

  /**
   * Places a gRPC API an importer mapped from a file that is not a contract (an OpenCollection
   * whose `.proto` files could not be read): only the slug and the order are settled here, and it
   * records no definition, so the user imports one or uses server reflection later. A gRPC API with
   * a definition comes in through {@link addGrpcApi}, which also writes its cache. Saves immediately.
   *
   * @throws ProjectError `invalid-argument` for an API that carries a definition
   */
  async importGrpcApi(input: { readonly api: GrpcApi }): Promise<{ project: ProjectWire; apiId: string }> {
    const open = this.core.require();
    const project = open.project;
    if (input.api.definition !== undefined) {
      // A definition with no cache behind it would fail the first send.
      throw new ProjectError('invalid-argument', 'A gRPC API with a definition is placed by addGrpcApi', {
        details: { id: input.api.id },
      });
    }
    const api: GrpcApi = {
      ...input.api,
      slug: uniqueSlug(input.api.name, takenApiSlugs(project)),
      order: nextApiOrder(project),
    };
    open.project = { ...project, containers: { ...project.containers, grpc: [...grpcApisOf(project), api] } };
    open.dirty = true;
    await this.core.save({ reason: 'import' });
    return { project: this.core.snapshot() as ProjectWire, apiId: api.id };
  }
  /** Whether `apiId` is one of the open project's gRPC APIs. */
  ownsApi(apiId: string): boolean {
    return grpcApisOf(this.core.require().project).some((api) => api.id === apiId);
  }

  /**
   * The `.proto` files (or descriptor set) cached for `apiId`, read from its own folder: the same
   * card an OpenAPI API's documents fill, with `proto` where it shows the document's version.
   *
   * Nothing is re-fetched to answer this: an API whose definition was not cached has no documents
   * to show, and says so with `definition-cache-missing` rather than reaching the network behind
   * the user's back.
   */
  async apiDefinitionDocuments(apiId: string): Promise<ApiDefinitionDocuments> {
    const grpc = this.requireGrpcApi(apiId);
    const cache = await readGrpcDefinitionCache(apiDefinitionDir(this.core.require().dir, grpc.slug));
    return {
      documents:
        cache.kind === 'proto'
          ? cache.manifest.files.map((file) => ({ location: file.path, size: file.bytes }))
          : [{ location: cache.manifest.file.path, size: cache.manifest.file.bytes }],
      rootLocation: cache.manifest.source,
      fetchedAt: cache.manifest.fetchedAt,
      declaredVersion: cache.kind === 'proto' ? 'proto' : 'descriptors',
    };
  }

  /**
   * One cached document's text, matched by the location the manifest records.
   *
   * The renderer names a location, never a path: a document the manifest does not list is an
   * `unknown-document` error, so this can never be turned into a read of an arbitrary file.
   */
  async apiDefinitionText(apiId: string, location: string): Promise<string> {
    const grpc = this.requireGrpcApi(apiId);
    const cache = await readGrpcDefinitionCache(apiDefinitionDir(this.core.require().dir, grpc.slug));
    if (cache.kind === 'descriptors') {
      // A discovered definition is a binary descriptor set, not text; there is nothing to show.
      throw new ProjectError(
        'definition-not-text',
        'This API was discovered from a running server, so its definition is a binary descriptor set rather than .proto text',
        { details: { apiId, location } },
      );
    }
    const text = cache.sources.get(location);
    if (text === undefined) {
      throw new ProjectError('not-found', `No file "${location}" in this API's definition`, {
        details: { apiId, location },
      });
    }
    return text;
  }

  /** Writes every cached document of `apiId` into `dir`, byte for byte, returning the file names. */
  async exportApiDefinitionTo(apiId: string, dir: string): Promise<string[]> {
    const grpc = this.requireGrpcApi(apiId);
    const cache = await readGrpcDefinitionCache(apiDefinitionDir(this.core.require().dir, grpc.slug));
    if (cache.kind === 'descriptors') {
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(nodeFs, join(dir, cache.manifest.file.path), Buffer.from(cache.descriptors));
      return [cache.manifest.file.path];
    }
    const written: string[] = [];
    for (const [path, text] of cache.sources) {
      // The import paths were validated as safe segments when the cache was written, so joining
      // them under `dir` cannot leave it.
      await mkdir(join(dir, ...path.split('/').slice(0, -1)), { recursive: true });
      await writeFileAtomic(nodeFs, join(dir, ...path.split('/')), Buffer.from(text, 'utf8'));
      written.push(path);
    }
    return written;
  }
}
