/**
 * The pure tree and naming rules of an MCP server: walking its folders, and naming a call's
 * arguments file.
 *
 * A leaf on purpose. `model.ts` needs `project/paths.js` for its slugs, and that reaches
 * `node:path`, which a renderer bundle cannot have, so the rules the editor also needs live here
 * with no runtime imports, and `model.ts` re-exports them.
 */

import type { McpFolder, McpRequestDef, McpServer } from './model.js';

/** Every request in `folder` and, depth-first, in the folders below it. */
export function mcpFolderRequests(folder: Pick<McpFolder, 'folders' | 'requests'>): McpRequestDef[] {
  return [...folder.requests, ...folder.folders.flatMap((child) => mcpFolderRequests(child))];
}

/** Every request in `server`, its root requests first and then each folder depth-first. */
export function mcpServerRequests(server: McpServer): McpRequestDef[] {
  return mcpFolderRequests(server);
}

/** Every folder in `server`, depth-first. */
export function mcpServerFolders(server: McpServer): McpFolder[] {
  const walk = (folders: readonly McpFolder[]): McpFolder[] =>
    folders.flatMap((folder) => [folder, ...walk(folder.folders)]);
  return walk(server.folders);
}

/** The sibling file a `tools/call` request's arguments are kept in. */
export function mcpArgsFileName(requestSlug: string): string {
  return `${requestSlug}.args.json`;
}

/** True when a call's arguments text is blank: no file is written for it, and `{}` is sent. */
export function mcpArgumentsEmpty(text: string): boolean {
  return text.trim() === '';
}
