/**
 * The `api.*` channels: importing an OpenAPI document, and reading back the definition it cached.
 *
 * Separate from `definition.*` because the two describe different things. A WSDL bundle is resolved
 * into main's memory and answered from there; an OpenAPI definition is read from its cache on demand,
 * so there is no per-API engine state to keep, and an API whose definition was never cached simply
 * has no documents to show rather than silently re-fetching them.
 */

import { pathToFileURL } from 'node:url';
import { importPostmanCollection, WirebenchError } from '@wirebench/engine';
import type { OpenApiSource } from '@wirebench/engine';
import { channels, events } from '../../shared/ipc.js';
import type { OpenApiSourceWire } from '../../shared/wire-types.js';
import { MAX_DOCUMENT_TEXT_BYTES } from '../../shared/wire-types.js';
import type { ReadPicks } from '../dialog-picks.js';
import { pickFolder } from '../native-dialogs.js';
import type { OpenApiImportService } from '../openapi-import.js';
import type { ProtoImportService } from '../proto-import.js';
import { allowsReadPath, checkedImportSource } from '../path-access.js';
import { resolve } from 'node:path';
import type { ProtoSourceWire } from '../../shared/wire-types.js';
import { toAuthConfigWire } from '../project-wire.js';
import type { ProjectRouter } from '../project-router.js';
import { emitEvent } from './events.js';
import { registerHandler } from './register.js';

/** What the `api.*` channels need. A stub stands in for each part in tests. */
export interface ApiChannelDeps {
  readonly router: Pick<
    ProjectRouter,
    | 'addApi'
    | 'addGrpcApi'
    | 'importAsyncApi'
    | 'apiDefinitionDocuments'
    | 'apiDefinitionText'
    | 'exportApiDefinitionTo'
    | 'grpcDefinition'
    | 'grpcFields'
    | 'grpcRefresh'
    | 'grpcSample'
  >;
  readonly imports: Pick<OpenApiImportService, 'run' | 'cancel'>;
  /**
   * The AsyncAPI import runner — the OpenAPI service's `runAsyncApi`, so `api.cancelImport` reaches
   * it through `imports.cancel`. Optional so the OpenAPI-only tests need not build one.
   */
  readonly asyncApiImports?: Pick<OpenApiImportService, 'runAsyncApi'>;
  /** The `.proto` import service; optional so the OpenAPI-only tests need not build one. */
  readonly protoImports?: Pick<ProtoImportService, 'run' | 'cancel'>;
  /** Creates a project inside the open workspace; used only by an import that asks for one. */
  readonly addProject: (name: string) => Promise<{ readonly projectId: string }>;
  /** Takes back a project created for an import that then failed, so no empty project is left. */
  readonly removeProject: (projectId: string, options: { deleteFiles: boolean }) => Promise<unknown>;
  /** The folders of every project open in the workspace, for the `file`-path containment check. */
  readonly projectDirs: () => readonly string[];
  /** The session's dialog memory: proof a `file` source was picked by the user, not named. */
  readonly picks: ReadPicks;
}

/** The engine's source shape. A `file` path becomes a `file:` URL here, where the platform is known. */
function toEngineSource(source: OpenApiSourceWire): OpenApiSource {
  if (source.kind === 'file') {
    return { kind: 'file', path: pathToFileURL(source.path).href };
  }
  if (source.kind === 'text') {
    return { kind: 'text', text: source.text, ...(source.location !== undefined ? { location: source.location } : {}) };
  }
  return source;
}

/** What the API records as where its definition came from: the location as the user gave it. */
function sourceLabel(source: OpenApiSourceWire): string {
  if (source.kind === 'url') {
    return source.url;
  }
  if (source.kind === 'file') {
    return source.path;
  }
  return source.location ?? 'inline:openapi';
}

/**
 * The path-access check for a `.proto` source: a folder or each file must be inside an open project
 * or picked this session; text and URLs are not paths and pass as they are.
 *
 * @throws WirebenchError `import-path-refused`
 */
async function checkedProtoSource(
  roots: readonly string[],
  picks: ReadPicks | undefined,
  source: ProtoSourceWire,
): Promise<ProtoSourceWire> {
  const refuse = (path: string): never => {
    throw new WirebenchError(
      'import-path-refused',
      `Wirebench will not read "${path}": use Browse… to pick .proto files outside the project folder`,
      { details: { path } },
    );
  };
  if (source.kind === 'folder') {
    const resolved = resolve(source.path);
    if (!(await allowsReadPath(roots, picks, resolved))) {
      refuse(source.path);
    }
    return { kind: 'folder', path: resolved };
  }
  if (source.kind === 'files') {
    const paths: string[] = [];
    for (const path of source.paths) {
      const resolved = resolve(path);
      if (!(await allowsReadPath(roots, picks, resolved))) {
        refuse(path);
      }
      paths.push(resolved);
    }
    return { kind: 'files', paths };
  }
  return source;
}

/** Registers the `api.*` IPC channels. */
export function registerApiChannels(deps: ApiChannelDeps): void {
  const { router } = deps;

  registerHandler(channels.api.importOpenApi, async (request, sender) => {
    // A `file` source is a read at a renderer-named path, answered before any project is created,
    // so a refusal changes nothing — the same order `project.addInterface` uses.
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, request.source);
    const imported = await deps.imports.run(
      {
        source: toEngineSource(checked),
        ...(request.token !== undefined ? { token: request.token } : {}),
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.baseUrl !== undefined ? { baseUrl: request.baseUrl } : {}),
        ...(request.securityScheme !== undefined ? { securityScheme: request.securityScheme } : {}),
      },
      {
        onProgress: (progress) => {
          emitEvent(sender, events.engine.progress, progress);
        },
      },
    );
    const summary = {
      ...imported.summary,
      servers: imported.summary.servers.map((server) => ({ ...server })),
      securitySchemes: imported.summary.securitySchemes.map((scheme) => ({
        name: scheme.name,
        type: scheme.type,
        applied: scheme.applied,
        ...(scheme.description !== undefined ? { description: scheme.description } : {}),
        ...(scheme.reason !== undefined ? { reason: scheme.reason } : {}),
        // Flattened here rather than spread with the rest, so the field carries the wire shape
        // alone: a spread would leave the engine's own union in the type beside it.
        ...(scheme.auth !== undefined ? { auth: toAuthConfigWire(scheme.auth) } : {}),
      })),
      skipped: imported.summary.skipped.map((entry) => ({ ...entry })),
    };
    const place = {
      api: imported.api,
      documents: imported.documents,
      source: sourceLabel(checked),
      declaredVersion: imported.document.declaredVersion,
      ...(request.cache !== undefined ? { cache: request.cache } : {}),
    };

    if ('projectId' in request.target) {
      const added = await router.addApi(request.target.projectId, place);
      return { ...added, projectId: request.target.projectId, summary };
    }
    // A `newProjectName` target creates the project only once the document has been read, so a
    // document that cannot be imported never leaves a project behind; if placing it fails anyway,
    // the project goes again and the placement's own error is what the caller hears.
    const { projectId } = await deps.addProject(request.target.newProjectName);
    try {
      const added = await router.addApi(projectId, place);
      return { ...added, projectId, summary };
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });

  registerHandler(channels.api.importAsyncApi, async (request, sender) => {
    const asyncApiImports = deps.asyncApiImports;
    if (asyncApiImports === undefined) {
      throw new WirebenchError('not-supported', 'This build cannot import AsyncAPI documents');
    }
    // Checked before anything is read or created, as `api.importOpenApi` does.
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, request.source);
    const imported = await asyncApiImports.runAsyncApi(
      {
        source: toEngineSource(checked),
        ...(request.token !== undefined ? { token: request.token } : {}),
        ...(request.server !== undefined ? { server: request.server } : {}),
      },
      {
        onProgress: (progress) => {
          emitEvent(sender, events.engine.progress, progress);
        },
      },
    );
    const api =
      request.name !== undefined && request.name.trim() !== '' ? { ...imported.api, name: request.name } : imported.api;
    const summary = {
      name: api.name,
      title: imported.summary.title,
      declaredVersion: imported.summary.declaredVersion,
      ...(imported.summary.server !== undefined ? { server: imported.summary.server } : {}),
      servers: [...imported.summary.servers],
      requests: imported.summary.requests,
      messages: imported.summary.messages,
      skipped: imported.summary.skipped.map((entry) => ({ where: entry.where, reason: entry.reason })),
      unresolved: [...imported.summary.unresolved],
      unsupportedKeywords: [...imported.summary.unsupportedKeywords],
    };
    const place = {
      api,
      documents: imported.documents,
      source: checked.kind === 'text' ? (checked.location ?? 'inline:asyncapi') : sourceLabel(checked),
      declaredVersion: imported.declaredVersion,
      ...(request.cache !== undefined ? { cache: request.cache } : {}),
    };

    if ('projectId' in request.target) {
      const added = await router.importAsyncApi(request.target.projectId, place);
      return { ...added, projectId: request.target.projectId, summary };
    }
    // As for OpenAPI: the project is created only once the document has been read and mapped, and
    // is taken back if placing the API fails.
    const { projectId } = await deps.addProject(request.target.newProjectName);
    try {
      const added = await router.importAsyncApi(projectId, place);
      return { ...added, projectId, summary };
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });

  registerHandler(channels.api.importPostman, async (request) => {
    let checkedSource:
      { readonly kind: 'file'; readonly path: string } | { readonly kind: 'text'; readonly text: string };
    if (request.source.kind === 'file') {
      const checked = await checkedImportSource(deps.projectDirs(), deps.picks, {
        kind: 'file',
        path: request.source.path,
      });
      if (checked.kind !== 'file') {
        throw new WirebenchError('invalid-argument', 'Expected a file source');
      }
      checkedSource = { kind: 'file', path: checked.path };
    } else {
      checkedSource = { kind: 'text', text: request.source.text };
    }

    const imported = await importPostmanCollection(checkedSource, {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.baseUrl !== undefined ? { baseUrl: request.baseUrl } : {}),
    });

    const place = {
      api: imported.api,
      documents: [],
      source: checkedSource.kind === 'file' ? checkedSource.path : 'inline:postman',
      declaredVersion: 'postman-collection',
      cache: false,
    };

    if ('projectId' in request.target) {
      const added = await router.addApi(request.target.projectId, place);
      return { ...added, projectId: request.target.projectId, summary: imported.summary };
    }

    const { projectId } = await deps.addProject(request.target.newProjectName);
    try {
      const added = await router.addApi(projectId, place);
      return { ...added, projectId, summary: imported.summary };
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });

  registerHandler(channels.api.importProto, async (request, sender) => {
    const protoImports = deps.protoImports;
    if (protoImports === undefined) {
      throw new WirebenchError('not-supported', 'This build cannot import .proto files');
    }
    // A folder or a file is a read at a renderer-named path: each must be inside an open project or
    // have been picked in a native dialog this session, checked before anything is created.
    const source = await checkedProtoSource(deps.projectDirs(), deps.picks, request.source);
    const run = await protoImports.run(
      {
        source,
        ...(request.token !== undefined ? { token: request.token } : {}),
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.grpcTarget !== undefined ? { target: request.grpcTarget } : {}),
        ...(request.tls !== undefined ? { tls: request.tls } : {}),
      },
      {
        onProgress: (progress) => {
          emitEvent(sender, events.engine.progress, progress);
        },
      },
    );
    const summary = {
      name: run.imported.api.name,
      target: run.imported.api.target,
      ...run.imported.summary,
      roots: [...run.roots],
      kind: run.kind === 'proto' ? ('proto' as const) : ('reflection' as const),
      ...(run.kind === 'reflection' ? { reflectionVersion: run.version } : {}),
    };
    const place = {
      api: run.imported.api,
      roots: run.roots,
      source: run.sourceLabel,
      ...(request.cache !== undefined ? { cache: request.cache } : {}),
      ...(request.source.kind === 'reflection' && request.source.version !== undefined
        ? { requestedVersion: request.source.version }
        : {}),
      ...(run.kind === 'proto'
        ? { kind: 'proto' as const, sources: run.sources }
        : {
            kind: 'reflection' as const,
            descriptors: run.descriptors,
            version: run.version,
            trustInvalid: run.trustInvalid,
          }),
    };
    if ('projectId' in request.target) {
      const added = await router.addGrpcApi(request.target.projectId, place);
      return { ...added, projectId: request.target.projectId, summary };
    }
    const { projectId } = await deps.addProject(request.target.newProjectName);
    try {
      const added = await router.addGrpcApi(projectId, place);
      return { ...added, projectId, summary };
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });

  registerHandler(channels.api.grpcDefinition, async (request) => {
    const definition = await router.grpcDefinition(request.apiId);
    return {
      services: definition.services.map((service) => ({
        name: service.name,
        fullName: service.fullName,
        package: service.package,
        ...(service.comment !== undefined ? { comment: service.comment } : {}),
        methods: service.methods.map((method) => ({ ...method })),
      })),
      files: definition.files.map((file) => ({ ...file })),
      source: definition.source,
      fetchedAt: definition.fetchedAt,
      roots: [...definition.roots],
      kind: definition.kind,
      ...(definition.reflectionVersion !== undefined ? { reflectionVersion: definition.reflectionVersion } : {}),
    };
  });

  registerHandler(channels.api.grpcSample, async (request) => ({
    text: await router.grpcSample(request.apiId, request.type),
  }));

  registerHandler(channels.api.grpcFields, async (request) => {
    const descriptor = await router.grpcFields(request.apiId, request.type, request.path);
    if (descriptor === undefined) {
      return { fields: [] };
    }
    return {
      fullName: descriptor.fullName,
      fields: descriptor.fields.map((field) => ({
        name: field.name,
        type: field.type,
        valueKind: field.valueKind,
        repeated: field.repeated,
        ...(field.oneof !== undefined ? { oneof: field.oneof } : {}),
        ...(field.enumValues !== undefined ? { enumValues: [...field.enumValues] } : {}),
        ...(field.comment !== undefined ? { comment: field.comment } : {}),
      })),
    };
  });

  registerHandler(channels.api.grpcRefresh, async (request) => {
    const refreshed = await router.grpcRefresh(request.apiId, {
      ...(request.version !== undefined ? { version: request.version } : {}),
    });
    return {
      projectId: refreshed.project.id,
      project: refreshed.project,
      summary: {
        ...refreshed.summary,
        roots: [...(refreshed.project.grpcApis.find((api) => api.id === request.apiId)?.definition?.roots ?? [])],
        kind: 'reflection' as const,
        reflectionVersion: refreshed.version,
      },
      requestsAdded: refreshed.reconciled.requestsAdded.length,
      requestsOrphaned: refreshed.reconciled.requestsOrphaned.length,
      requestsRestored: refreshed.reconciled.requestsRestored.length,
      foldersAdded: refreshed.reconciled.foldersAdded.length,
    };
  });

  registerHandler(channels.api.cancelImport, (request) =>
    Promise.resolve({
      cancelled:
        deps.imports.cancel(request.token).cancelled || (deps.protoImports?.cancel(request.token).cancelled ?? false),
    }),
  );

  // Identity only — no text — so a large definition stays a bounded payload.
  registerHandler(channels.api.definitionDocuments, async (request) => {
    const read = await router.apiDefinitionDocuments(request.apiId);
    return { ...read, documents: read.documents.map((document) => ({ ...document })) };
  });

  registerHandler(channels.api.definitionText, async (request) => {
    const text = await router.apiDefinitionText(request.apiId, request.location);
    const size = Buffer.byteLength(text, 'utf8');
    if (size > MAX_DOCUMENT_TEXT_BYTES) {
      throw new WirebenchError(
        'document-too-large',
        `Document "${request.location}" is too large to show (${String(size)} bytes)`,
        { details: { location: request.location, size } },
      );
    }
    return { text };
  });

  registerHandler(channels.api.exportDefinition, async (request, sender) => {
    const dir = await pickFolder(sender, { title: 'Export definition to folder' });
    if (dir === undefined) {
      return { cancelled: true, files: [] };
    }
    return { cancelled: false, dir, files: await router.exportApiDefinitionTo(request.apiId, dir) };
  });
}
