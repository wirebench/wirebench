import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import { channels, events } from '../../shared/ipc.js';
import { MAX_DOCUMENT_TEXT_BYTES } from '../../shared/wire-types.js';
import type { ReadPicks, RecordsWritePicks } from '../dialog-picks.js';
import { allowsReadPath } from '../path-access.js';
import type { EngineService } from '../engine-service.js';
import { pickFolder, pickSaveFile } from '../native-dialogs.js';
import type { ProjectRouter } from '../project-router.js';
import { declarationAtOffset, schemaIndexOf } from '../schema-index.js';
import { emitEvent } from './events.js';
import { registerHandler } from './register.js';

/**
 * The `ProjectRouter` surface the Update/Export/Docs channels drive; a stub stands in for it
 * in tests, exactly as `request.*` does.
 */
export type DefinitionChannelProject = Pick<
  ProjectRouter,
  | 'planDefinitionUpdate'
  | 'applyDefinitionUpdate'
  | 'exportDefinitionTo'
  | 'definitionDocs'
  | 'projectSnapshot'
  | 'projectId'
>;

/** What the Update/Export/Docs half of the `definition.*` channels needs beyond the engine. */
export interface DefinitionChannelDeps {
  readonly project: DefinitionChannelProject;
  /**
   * The folders of every project open in the workspace. A `definition.import { kind: 'file' }`
   * path is allowed when it is inside one of them — the workspace replaces the single "the
   * open project folder" this check used to ask `snapshot()` for.
   */
  readonly projectDirs?: () => readonly string[];
  /**
   * The session's dialog memory: the *write* half records the Save-as target the docs picker
   * returns, the *read* half is what proves a `definition.import { kind: 'file' }` path was
   * chosen by the user rather than merely named by the renderer.
   */
  readonly picks: RecordsWritePicks & ReadPicks;
}

/** Default file name for a generated documentation file, per format. */
function docsFileName(format: 'html' | 'markdown'): string {
  return format === 'html' ? 'definition.html' : 'definition.md';
}

/**
 * Registers the `definition.*` IPC channels against a shared `EngineService` instance.
 *
 * `deps` adds the project-backed half (plan/apply an update, export the bundle, generate
 * documentation). It is optional so the read-only channels can be registered on their own in
 * tests. Every file the write channels touch is named by a *native dialog run in main*, never
 * by the renderer.
 */
export function registerDefinitionChannels(service: EngineService, deps?: DefinitionChannelDeps): void {
  registerHandler(channels.definition.import, async (request, sender) => {
    // A `file` import is a file *read* at a renderer-named path, so it answers the same
    // question every other main-side read does (`main/path-access.ts`): the path is inside the
    // open project folder, or the user drove the "Browse…" Open dialog to it this session.
    // Nothing else — not a drag-and-drop, not a typed-in path — is evidence. The dialog's
    // drop zone therefore reads the file in the renderer and imports it as `text`.
    let source = request.source;
    if (source.kind === 'file') {
      const resolved = resolve(source.path);
      const allowed = await allowsReadPath(deps?.projectDirs?.() ?? [], deps?.picks, resolved);
      if (!allowed) {
        throw new WirebenchError(
          'import-path-refused',
          `Wirebench will not read "${source.path}": use Browse… to pick a WSDL outside the project folder`,
          { details: { path: source.path } },
        );
      }
      source = { kind: 'file', path: resolved };
    }
    return service.importDefinition(
      { ...request, source },
      {
        onProgress: (progress) => {
          emitEvent(sender, events.engine.progress, progress);
        },
      },
    );
  });

  registerHandler(channels.definition.close, (request) => Promise.resolve(service.close(request.interfaceId)));

  registerHandler(channels.definition.cancelImport, (request) => Promise.resolve(service.cancelImport(request.token)));

  // The list is identity only — no text — so a large import graph stays a bounded payload.
  registerHandler(channels.definition.documents, (request) => {
    const result = service.resultFor(request.interfaceId);
    return Promise.resolve({
      documents: result.bundle.documents.map((document) => ({
        location: document.location,
        kind: document.kind,
        size: document.bytes.byteLength,
        ...(document.namespace !== undefined ? { namespace: document.namespace } : {}),
      })),
      loadedAt: service.loadedAtFor(request.interfaceId),
    });
  });

  // One document's text, on demand. `location` is matched against the bundle's own locations:
  // the renderer never names a filesystem path, and nothing is re-fetched to answer this.
  registerHandler(channels.definition.documentText, (request) => {
    const result = service.resultFor(request.interfaceId);
    const document = result.bundle.documents.find((candidate) => candidate.location === request.location);
    if (document === undefined) {
      throw new WirebenchError('unknown-document', `No document "${request.location}" in this definition`, {
        details: { interfaceId: request.interfaceId, location: request.location },
      });
    }
    if (document.bytes.byteLength > MAX_DOCUMENT_TEXT_BYTES) {
      throw new WirebenchError(
        'document-too-large',
        `Document "${request.location}" is too large to show (${String(document.bytes.byteLength)} bytes)`,
        { details: { location: request.location, size: document.bytes.byteLength } },
      );
    }
    return Promise.resolve({ text: document.text });
  });

  registerHandler(channels.definition.schemaIndex, (request) =>
    Promise.resolve({ namespaces: schemaIndexOf(service.schemaSetFor(request.interfaceId)) }),
  );

  registerHandler(channels.definition.declarationAt, (request) => {
    // The offset is a caret position in the very envelope that came with it, so anything past
    // its end is a caller bug rather than a miss worth answering with `null`.
    if (request.offset > request.envelopeXml.length) {
      throw new WirebenchError('invalid-offset', 'The caret offset is past the end of the envelope', {
        details: { offset: request.offset, length: request.envelopeXml.length },
      });
    }
    return Promise.resolve(
      declarationAtOffset(service.schemaSetFor(request.interfaceId), request.envelopeXml, request.offset),
    );
  });

  if (deps === undefined) {
    return;
  }
  const { project, picks } = deps;

  registerHandler(channels.definition.planUpdate, (request) =>
    project.planDefinitionUpdate(request.interfaceId, request.source),
  );

  registerHandler(channels.definition.applyUpdate, async (request) => {
    const applied = await project.applyDefinitionUpdate(request.interfaceId, request.source, request.options);
    const projectId = project.projectId(request.interfaceId);
    const snapshot = projectId === undefined ? null : project.projectSnapshot(projectId);
    if (snapshot === null) {
      throw new WirebenchError('no-project', 'The project was closed while the definition was updating');
    }
    return { ...applied, project: snapshot };
  });

  registerHandler(channels.definition.export, async (request, sender) => {
    const dir = await pickFolder(sender, { title: 'Export definition to folder' });
    if (dir === undefined) {
      return { cancelled: true, files: [] };
    }
    return { cancelled: false, dir, files: await project.exportDefinitionTo(request.interfaceId, dir) };
  });

  registerHandler(channels.definition.generateDocs, async (request, sender) => {
    // Render before the dialog: a definition that cannot be documented should say so rather
    // than asking the user where to put a file that will never be written.
    const document = project.definitionDocs(request.interfaceId, request.format);
    const path = await pickSaveFile(sender, picks, {
      title: 'Save documentation',
      defaultPath: docsFileName(request.format),
      filters:
        request.format === 'html'
          ? [{ name: 'HTML', extensions: ['html'] }]
          : [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (path === undefined) {
      return { cancelled: true };
    }
    await writeFile(path, document, 'utf8');
    return { cancelled: false, path };
  });
}
