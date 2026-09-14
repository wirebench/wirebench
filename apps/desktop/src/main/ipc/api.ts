/**
 * The `api.*` channels: importing an OpenAPI document, and reading back the definition it cached.
 *
 * Separate from `definition.*` because the two describe different things. A WSDL bundle is resolved
 * into main's memory and answered from there; an OpenAPI definition is read from its cache on demand,
 * so there is no per-API engine state to keep, and an API whose definition was never cached simply
 * has no documents to show rather than silently re-fetching them.
 */

import { pathToFileURL } from 'node:url';
import { WirebenchError } from '@wirebench/engine';
import type { OpenApiSource } from '@wirebench/engine';
import { channels, events } from '../../shared/ipc.js';
import type { OpenApiSourceWire } from '../../shared/wire-types.js';
import { MAX_DOCUMENT_TEXT_BYTES } from '../../shared/wire-types.js';
import type { ReadPicks } from '../dialog-picks.js';
import { pickFolder } from '../native-dialogs.js';
import type { OpenApiImportService } from '../openapi-import.js';
import { checkedImportSource } from '../path-access.js';
import { toAuthConfigWire } from '../project-wire.js';
import type { ProjectRouter } from '../project-router.js';
import { emitEvent } from './events.js';
import { registerHandler } from './register.js';

/** What the `api.*` channels need. A stub stands in for each part in tests. */
export interface ApiChannelDeps {
  readonly router: Pick<
    ProjectRouter,
    'addApi' | 'apiDefinitionDocuments' | 'apiDefinitionText' | 'exportApiDefinitionTo'
  >;
  readonly imports: Pick<OpenApiImportService, 'run' | 'cancel'>;
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

  registerHandler(channels.api.cancelImport, (request) => Promise.resolve(deps.imports.cancel(request.token)));

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
