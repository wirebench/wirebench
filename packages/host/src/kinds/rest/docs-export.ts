/**
 * `api.exportDocs` (API Overview spec §3.3): one REST API's documentation written to a file the user
 * picks. Main builds the document from the open project's model with the same builder the docs tab
 * uses, renders it (Markdown, or one self-contained HTML page), runs the native Save dialog and
 * writes the file; no path crosses the bridge. Nothing is resolved, so no secret reaches the file.
 */
import type { Caller } from '../../host/platform.js';
import {
  apiDocumentToHtml,
  apiDocumentToMarkdown,
  buildApiDocument,
  nodeFs,
  restApisOf,
  WirebenchError,
  writeFileAtomic,
} from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { authTypeLabel } from '@wirebench/wire/auth-types';
import { channels } from '@wirebench/wire/ipc';
import type { RecordsWritePicks } from '../../dialog-picks.js';
import { registerHandler, type HandlerTable } from '../../ipc/register.js';
import type { NativeDialogs } from '../../native-dialogs.js';

export type DocsFormat = 'html' | 'markdown';

/** The API's documentation as file text, and the name the Save dialog proposes for it. */
export function apiDocsFile(
  project: Project,
  apiId: string,
  format: DocsFormat,
): { readonly fileName: string; readonly text: string } {
  const api = restApisOf(project).find((candidate) => candidate.id === apiId);
  if (api === undefined) {
    throw new WirebenchError('not-found', `No REST API with id "${apiId}"`, { details: { apiId } });
  }
  const auth = api.auth === undefined || api.auth.type === 'inherit' ? 'none' : api.auth.type;
  const doc = buildApiDocument(api, authTypeLabel(auth));
  // A name the OS accepts: path separators and other reserved characters become dashes.
  const base = api.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'api';
  return format === 'html'
    ? { fileName: `${base}.html`, text: apiDocumentToHtml(doc) }
    : { fileName: `${base}.md`, text: apiDocumentToMarkdown(doc) };
}

export interface RestDocsChannelDeps {
  /** Which open project holds an entity, and that project's host. */
  readonly router: {
    projectId(entityId: string): string | undefined;
    hostFor(projectId: string): { readonly open?: { readonly project: Project } | undefined };
  };
  readonly picks: RecordsWritePicks;
  /** The Save dialog; the native one in production. */
  readonly dialogs: Pick<NativeDialogs, 'pickSaveFile'>;
  /** Writes the file; atomic in production. */
  readonly write?: (path: string, text: string) => Promise<void>;
}

export function registerRestDocsChannels(table: HandlerTable, deps: RestDocsChannelDeps): void {
  const write = deps.write ?? ((path: string, text: string) => writeFileAtomic(nodeFs, path, text));

  registerHandler(table, channels.api.exportDocs, async (request, sender: Caller) => {
    const projectId = deps.router.projectId(request.apiId);
    const project = projectId === undefined ? undefined : deps.router.hostFor(projectId).open?.project;
    if (project === undefined) {
      throw new WirebenchError('not-found', `No REST API with id "${request.apiId}"`, {
        details: { apiId: request.apiId },
      });
    }
    // Built before the dialog: an API that cannot be documented says so instead of asking for a path.
    const file = apiDocsFile(project, request.apiId, request.format);
    const path = await deps.dialogs.pickSaveFile(sender, deps.picks, {
      title: 'Save documentation',
      defaultPath: file.fileName,
      filters:
        request.format === 'html'
          ? [{ name: 'HTML', extensions: ['html'] }]
          : [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (path === undefined) {
      return { cancelled: true };
    }
    await write(path, file.text);
    return { cancelled: false, path };
  });
}
