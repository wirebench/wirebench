/**
 * MCP's router methods (spec §5.3; #79): each names the MCP host method it reaches and how the host
 * is found. `ProjectRouter`, `WorkspaceService` and `window-scope.ts` all derive from this one list.
 */

import type { ProjectWire } from '../../../shared/wire-types.js';
import type { KindRoute, KindRouter } from '../kind-main.js';
import type { McpHost } from './host.js';

export const mcpRoutes = {
  /** Keeps a refresh's catalogue and its metadata on the server, and saves. */
  setMcpCatalogue: { method: 'setMcpCatalogue', by: 'entity' },
} as const satisfies Readonly<Record<string, KindRoute<McpHost>>>;

export type McpRouter = KindRouter<McpHost, typeof mcpRoutes>;

/** The ids MCP's channels address, for `WorkspaceService`'s routing index: servers, their folders and requests. */
export function* mcpEntityIds(project: ProjectWire): Iterable<string> {
  const owners = new Set(project.mcpServers.map((server) => server.id));
  yield* owners;
  for (const folder of project.folders) if (owners.has(folder.apiId)) yield folder.id;
  for (const request of project.mcpRequests) yield request.id;
}
