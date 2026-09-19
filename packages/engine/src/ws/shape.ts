/**
 * The pure tree and naming rules of a WebSocket API: walking its folders, and naming a saved
 * message's file.
 *
 * A leaf on purpose. `model.ts` needs `project/paths.js` for its slugs, and that reaches
 * `node:path`, which a renderer bundle cannot have — so the handful of rules the editor also needs
 * live here, with no runtime imports but `pretty.ts` (itself browser-safe), and `model.ts`
 * re-exports them so nothing else moved.
 */

import { prettyFrameText } from './pretty.js';
import type { WsApi, WsFolder, WsRequestDef, WsSavedMessage } from './model.js';

/** Every request in `folder` and, depth-first, in the folders below it. */
export function wsFolderRequests(folder: Pick<WsFolder, 'folders' | 'requests'>): WsRequestDef[] {
  return [...folder.requests, ...folder.folders.flatMap((child) => wsFolderRequests(child))];
}

/** Every request in `api`, its root requests first and then each folder depth-first. */
export function wsApiRequests(api: WsApi): WsRequestDef[] {
  return wsFolderRequests(api);
}

/** Every folder in `api`, depth-first. */
export function wsApiFolders(api: WsApi): WsFolder[] {
  const walk = (folders: readonly WsFolder[]): WsFolder[] =>
    folders.flatMap((folder) => [folder, ...walk(folder.folders)]);
  return walk(api.folders);
}

/** The file name a saved message is stored under, named by what it holds. */
export function wsMessageFileName(
  requestSlug: string,
  message: Pick<WsSavedMessage, 'slug' | 'format' | 'content'>,
): string {
  const language = message.format === 'binary' ? 'b64' : prettyFrameText(message.content).language;
  return `${requestSlug}.msg-${message.slug}.${language === 'text' ? 'txt' : language}`;
}
