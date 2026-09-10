/**
 * The `attachments.*` IPC channels: everything the attachments inspector needs to move
 * attachment *bytes*, none of which ever cross the context bridge.
 *
 * The renderer only ever holds handles — `sendId` + index for a response part, `requestId` +
 * `attachmentId` for a request one — and asks main to write them somewhere or hand them to the
 * OS. That is what keeps the renderer free of the file system while still offering Save as…,
 * double-click-to-open and an Add-attachments picker.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow, dialog, shell } from 'electron';
import { WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { ExchangeCache } from '../exchange-cache.js';
import type { ProjectService } from '../project-service.js';
import { registerHandler } from './register.js';

/** Subdirectory of `userData` that {@link registerAttachmentChannels}'s "open" writes into. */
export const ATTACHMENTS_TMP_DIR = 'attachments-tmp';

/** What the `attachments.*` channels need; a stub stands in for each of these in tests. */
export interface AttachmentChannelDeps {
  /** Holds the response bytes of recent sends, keyed by `sendId`. */
  readonly exchanges: Pick<ExchangeCache, 'getAttachment'>;
  /** Resolves (and allow-lists) a saved request's attachment to a file on disk. */
  readonly project: Pick<ProjectService, 'resolveAttachmentPath'>;
  /** Where "open" writes its temporary copies; `app.getPath('userData')` in the app. */
  readonly userDataDir: string;
}

/**
 * File extension for a media type, mirroring the sniffing table `add-attachment` uses in the
 * other direction. `.bin` for anything unrecognised, because a file with no extension at all is
 * one the OS will refuse to open.
 */
export function extensionForContentType(contentType: string): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase();
  switch (type) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'application/pdf':
      return '.pdf';
    case 'application/xml':
    case 'text/xml':
      return '.xml';
    case 'text/plain':
      return '.txt';
    case 'application/json':
      return '.json';
    case 'application/zip':
      return '.zip';
    default:
      return '.bin';
  }
}

/** e2e cannot drive native dialogs, so these env vars short-circuit them, as `fs.*` does. */
function e2eSavePathOverride(): string | undefined {
  return process.env['WIREBENCH_E2E_SAVE_PATH'];
}
function e2eOpenPathOverride(): string | undefined {
  return process.env['WIREBENCH_E2E_OPEN_PATH'];
}

/**
 * A single path segment: separators and `..` runs collapsed to `_`, so a Content-ID (which the
 * *server* chose) or a send id cannot steer a write out of the folder it is meant to land in.
 */
function safeSegment(name: string): string {
  const cleaned = name.replace(/[/\\]/g, '_').replace(/\.\.+/g, '_');
  return cleaned.length > 0 ? cleaned : 'attachment';
}

function unknownAttachment(sendId: string, index: number): WirebenchError {
  return new WirebenchError(
    'unknown-attachment',
    `No attachment ${String(index)} on send ${sendId} (it may have been evicted from the cache)`,
    { details: { sendId, index } },
  );
}

/**
 * Registers the `attachments.*` channels.
 *
 * Save and open both read from the {@link ExchangeCache}, which is bounded — an exchange old
 * enough to have been evicted answers `unknown-attachment` rather than writing a wrong file.
 */
export function registerAttachmentChannels(deps: AttachmentChannelDeps): void {
  registerHandler(channels.attachments.saveResponse, async (request, sender) => {
    const attachment = deps.exchanges.getAttachment(request.sendId, request.index);
    if (attachment === undefined) {
      throw unknownAttachment(request.sendId, request.index);
    }
    const defaultName =
      attachment.name ?? `${safeSegment(attachment.contentId)}${extensionForContentType(attachment.contentType)}`;

    let targetPath = request.path;
    if (targetPath === undefined) {
      const override = e2eSavePathOverride();
      if (override !== undefined) {
        targetPath = override;
      } else {
        const window = BrowserWindow.fromWebContents(sender) ?? undefined;
        const result = await dialog.showSaveDialog(window as BrowserWindow, {
          title: 'Save attachment as…',
          defaultPath: defaultName,
        });
        targetPath = result.canceled ? undefined : result.filePath;
      }
    }
    if (targetPath === undefined) {
      return { cancelled: true };
    }
    await writeFile(targetPath, Buffer.from(attachment.bytes));
    return { path: targetPath };
  });

  registerHandler(channels.attachments.openResponse, async (request) => {
    const attachment = deps.exchanges.getAttachment(request.sendId, request.index);
    if (attachment === undefined) {
      throw unknownAttachment(request.sendId, request.index);
    }
    // A temp copy under `userData` rather than the OS temp dir: it is a path the app already
    // owns, so it stays inside what the packaged app is allowed to read and write.
    const dir = join(deps.userDataDir, ATTACHMENTS_TMP_DIR);
    await mkdir(dir, { recursive: true });
    const name = `${safeSegment(request.sendId)}-${String(request.index)}${extensionForContentType(attachment.contentType)}`;
    const path = join(dir, name);
    await writeFile(path, Buffer.from(attachment.bytes));
    await openWithShell(path);
    return { path };
  });

  registerHandler(channels.attachments.openRequest, async (request) => {
    // `resolveAttachmentPath` owns the allow-list (project folder, attachment cache, or the
    // absolute path the attachment itself declares) and throws when the file is out of bounds.
    const path = await deps.project.resolveAttachmentPath(request.requestId, request.attachmentId);
    await openWithShell(path);
    return { path };
  });

  registerHandler(channels.attachments.pickFiles, async (_request, sender) => {
    const override = e2eOpenPathOverride();
    if (override !== undefined) {
      // Comma-separated so an e2e spec can exercise a multi-file add.
      return { paths: override.split(',').filter((path) => path.length > 0) };
    }
    const window = BrowserWindow.fromWebContents(sender) ?? undefined;
    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      title: 'Add attachments',
      properties: ['openFile', 'multiSelections'],
    });
    return { paths: result.canceled ? [] : [...result.filePaths] };
  });
}

/**
 * Hands `path` to the OS. `shell.openPath` reports a failure as a non-empty string rather than
 * by throwing, which would otherwise be swallowed into a "success" reply.
 */
async function openWithShell(path: string): Promise<void> {
  const problem = await shell.openPath(path);
  if (problem.length > 0) {
    throw new WirebenchError('open-failed', `Could not open "${path}": ${problem}`, { details: { path } });
  }
}
