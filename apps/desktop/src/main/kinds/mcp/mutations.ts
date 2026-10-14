/**
 * Applying the MCP fifth of a {@link ProjectChange} to a project model (#79).
 *
 * The fifth sibling to the WebSocket, gRPC and REST arms: an MCP server shares nothing with the
 * others but the `Project` it sits in and the folder tree shape. Everything here is immutable and
 * rebuilds only the path from the server down to the node it touched. Slugs are derived here and
 * made unique within their container, because the file layout is main's business (ADR-0005).
 *
 * A server's catalogue is never written through a change: a refresh writes it, through the host
 * (`McpHost.setMcpCatalogue`), so a patch cannot plant a catalogue the server never listed.
 */

import {
  createMcpFolder,
  createMcpRequest,
  createMcpServer,
  mcpServersOf,
  nextApiOrder,
  ProjectError,
  uniqueSlug,
  withMcpServers,
} from '@wirebench/engine';
import type {
  McpFolder,
  McpOperation,
  McpRequestDef,
  McpRequestSettings,
  McpServer,
  McpServerSettings,
  McpTransport,
  Project,
} from '@wirebench/engine';
import type { RestFolderPatchWire } from '../../../shared/kinds/rest/wire.js';
import type {
  McpOperationWire,
  McpRequestPatchWire,
  McpServerPatchWire,
  McpTransportWire,
} from '../../../shared/kinds/mcp/wire.js';
import { takenApiSlugs, toEngineAuthConfig, toEngineRows } from '../../project-api-mutations.js';
import type { KindMutations } from '../kind-main.js';

/** What a mutation produced: the next model, and the entity it created when it created one. */
export interface McpMutationResult {
  readonly project: Project;
  readonly createdId?: string;
}

/** Anything that holds MCP folders and requests: a server, or a folder inside one. */
type Container = Pick<McpServer, 'folders' | 'requests'>;

function notFound(what: string, id: string): never {
  throw new ProjectError('project-entity-not-found', `No ${what} with id ${id}`, { details: { what, id } });
}

/** The MCP server with this id, or a clear error naming it. */
export function requireMcpServer(project: Project, apiId: string): McpServer {
  return mcpServersOf(project).find((server) => server.id === apiId) ?? notFound('MCP server', apiId);
}

/** `project` with `next` in place of the server of the same id. */
export function replaceMcpServer(project: Project, next: McpServer): Project {
  return withMcpServers(
    project,
    mcpServersOf(project).map((server) => (server.id === next.id ? next : server)),
  );
}

function renumber<T extends { readonly order: number }>(items: readonly T[]): T[] {
  return items.map((item, index) => ({ ...item, order: index }));
}

/** Every slug already used by a folder or request in `container`, for {@link uniqueSlug}. */
function takenSlugs(container: Container, exceptId?: string): Set<string> {
  const taken = new Set<string>();
  for (const folder of container.folders) if (folder.id !== exceptId) taken.add(folder.slug);
  for (const request of container.requests) if (request.id !== exceptId) taken.add(request.slug);
  return taken;
}

/** Drops keys whose value ended up `undefined`, so a cleared optional is absent. */
function cleanUndefined<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function mapFolder(
  folders: readonly McpFolder[],
  folderId: string,
  transform: (folder: McpFolder) => McpFolder,
): McpFolder[] | undefined {
  let found = false;
  const next = folders.map((folder) => {
    if (folder.id === folderId) {
      found = true;
      return transform(folder);
    }
    const deeper = mapFolder(folder.folders, folderId, transform);
    if (deeper === undefined) return folder;
    found = true;
    return { ...folder, folders: deeper };
  });
  return found ? next : undefined;
}

/** Rebuilds `server` with `transform` applied to the container `parentId` names, or the server itself. */
function inContainer(
  server: McpServer,
  parentId: string | undefined,
  transform: (container: Container) => Container,
): McpServer | undefined {
  if (parentId === undefined) return { ...server, ...transform(server) };
  const folders = mapFolder(server.folders, parentId, (folder) => ({ ...folder, ...transform(folder) }));
  return folders === undefined ? undefined : { ...server, folders };
}

function containerHolds(container: Container, nodeId: string): boolean {
  if (container.requests.some((request) => request.id === nodeId)) return true;
  return container.folders.some((folder) => folder.id === nodeId || containerHolds(folder, nodeId));
}

/** The MCP server holding `nodeId` (a folder or a request), if any. */
export function mcpServerOwning(project: Project, nodeId: string): McpServer | undefined {
  return mcpServersOf(project).find((server) => containerHolds(server, nodeId));
}

/** A transport from the wire, its tables and credentials in the engine's shape. */
export function toEngineMcpTransport(transport: McpTransportWire): McpTransport {
  if (transport.type === 'stdio') {
    return {
      type: 'stdio',
      command: transport.command,
      args: [...transport.args],
      ...(transport.cwd !== undefined ? { cwd: transport.cwd } : {}),
      env: toEngineRows(transport.env),
    };
  }
  return {
    type: transport.type,
    url: transport.url,
    headers: toEngineRows(transport.headers),
    ...(transport.auth !== undefined ? { auth: toEngineAuthConfig(transport.auth) } : {}),
  };
}

/** An operation from the wire, a prompt's arguments in the engine's shape. */
export function toEngineMcpOperation(operation: McpOperationWire): McpOperation {
  switch (operation.method) {
    case 'tools/call':
      return { method: operation.method, tool: operation.tool, arguments: operation.arguments };
    case 'resources/read':
      return { method: operation.method, uri: operation.uri };
    case 'prompts/get':
      return { method: operation.method, prompt: operation.prompt, arguments: toEngineRows(operation.arguments) };
    default:
      return { method: operation.method };
  }
}

/** Adds an MCP server, ordered after every interface and API the project already has. */
export function addMcpServer(
  project: Project,
  input: { readonly name: string; readonly transport?: McpTransportWire },
): McpMutationResult {
  const server = createMcpServer(input.name, {
    slug: uniqueSlug(input.name, takenApiSlugs(project)),
    order: nextApiOrder(project),
    ...(input.transport !== undefined ? { transport: toEngineMcpTransport(input.transport) } : {}),
  });
  return { project: withMcpServers(project, [...mcpServersOf(project), server]), createdId: server.id };
}

/**
 * Applies a patch to an MCP server. A `null` clears the description; `transport` and `settings`
 * are replaced whole. The catalogue and its metadata are kept as they are.
 */
export function updateMcpServer(project: Project, apiId: string, patch: McpServerPatchWire): McpMutationResult {
  const server = requireMcpServer(project, apiId);
  const next = cleanUndefined<McpServer>({
    ...server,
    name: patch.name ?? server.name,
    slug:
      patch.name !== undefined && patch.name !== server.name
        ? uniqueSlug(patch.name, takenApiSlugs(project, apiId))
        : server.slug,
    description: patch.description === null ? undefined : (patch.description ?? server.description),
    transport: patch.transport !== undefined ? toEngineMcpTransport(patch.transport) : server.transport,
    settings: patch.settings !== undefined ? cleanUndefined<McpServerSettings>(patch.settings) : server.settings,
  });
  return { project: replaceMcpServer(project, next) };
}

/** Removes an MCP server and everything in it. The other containers keep their orders. */
export function removeMcpServer(project: Project, apiId: string): McpMutationResult {
  requireMcpServer(project, apiId);
  return {
    project: withMcpServers(
      project,
      mcpServersOf(project).filter((server) => server.id !== apiId),
    ),
  };
}

/** Adds a folder to a server's root or to another of its folders. */
export function addMcpFolder(
  project: Project,
  input: { readonly apiId: string; readonly parentId?: string; readonly name: string },
): McpMutationResult {
  const server = requireMcpServer(project, input.apiId);
  let createdId = '';
  const next = inContainer(server, input.parentId, (container) => {
    const folder = createMcpFolder(input.name, {
      slug: uniqueSlug(input.name, takenSlugs(container)),
      order: container.folders.length,
    });
    createdId = folder.id;
    return { ...container, folders: [...container.folders, folder] };
  });
  if (next === undefined) notFound('folder', input.parentId ?? input.apiId);
  return { project: replaceMcpServer(project, next), createdId };
}

/**
 * Applies a patch to an MCP folder: its name and description. An MCP folder holds no credentials
 * (the server's transport does), so a patch's `auth` is not applied; its scripts are kept.
 */
export function updateMcpFolder(project: Project, folderId: string, patch: RestFolderPatchWire): McpMutationResult {
  const server = mcpServerOwning(project, folderId) ?? notFound('folder', folderId);
  const rename = (container: Container): Container => ({
    ...container,
    folders: container.folders.map((folder) => {
      if (folder.id !== folderId) return { ...folder, ...rename(folder) };
      return cleanUndefined<McpFolder>({
        ...folder,
        name: patch.name ?? folder.name,
        slug:
          patch.name !== undefined && patch.name !== folder.name
            ? uniqueSlug(patch.name, takenSlugs(container, folder.id))
            : folder.slug,
        description: patch.description === null ? undefined : (patch.description ?? folder.description),
      });
    }),
  });
  return { project: replaceMcpServer(project, { ...server, ...rename(server) }) };
}

function extractFolder(
  folders: readonly McpFolder[],
  folderId: string,
): { readonly folders: McpFolder[]; readonly removed: McpFolder | undefined } {
  let removed: McpFolder | undefined;
  const next: McpFolder[] = [];
  for (const folder of folders) {
    if (folder.id === folderId) {
      removed = folder;
      continue;
    }
    const deeper = extractFolder(folder.folders, folderId);
    if (deeper.removed !== undefined) {
      removed = deeper.removed;
      next.push({ ...folder, folders: renumber(deeper.folders) });
    } else {
      next.push(folder);
    }
  }
  return { folders: next, removed };
}

function extractRequest(
  server: McpServer,
  requestId: string,
): { readonly server: McpServer; readonly removed: McpRequestDef | undefined } {
  let removed: McpRequestDef | undefined;
  const strip = (container: Container): Container => {
    const own = container.requests.find((request) => request.id === requestId);
    if (own !== undefined) {
      removed = own;
      return { ...container, requests: renumber(container.requests.filter((request) => request.id !== requestId)) };
    }
    return { ...container, folders: container.folders.map((folder) => ({ ...folder, ...strip(folder) })) };
  };
  return { server: { ...server, ...strip(server) }, removed };
}

/** Removes an MCP folder and everything inside it. */
export function removeMcpFolder(project: Project, folderId: string): McpMutationResult {
  const server = mcpServerOwning(project, folderId) ?? notFound('folder', folderId);
  const { folders, removed } = extractFolder(server.folders, folderId);
  if (removed === undefined) notFound('folder', folderId);
  return { project: replaceMcpServer(project, { ...server, folders: renumber(folders) }) };
}

/** `Request 1`, `Request 2`, … skipping names the container already uses. */
function nextRequestName(container: Container): string {
  const used = new Set(container.requests.map((request) => request.name));
  for (let n = 1; ; n += 1) {
    const candidate = `Request ${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Adds an MCP request to a server's root or to a folder; it lists the server's tools unless told otherwise. */
export function addMcpRequest(
  project: Project,
  input: {
    readonly apiId: string;
    readonly parentId?: string;
    readonly name?: string;
    readonly operation?: McpOperationWire;
  },
): McpMutationResult {
  const server = requireMcpServer(project, input.apiId);
  let createdId = '';
  const next = inContainer(server, input.parentId, (container) => {
    const name = input.name ?? nextRequestName(container);
    const request = createMcpRequest(name, {
      slug: uniqueSlug(name, takenSlugs(container)),
      order: container.requests.length,
      ...(input.operation !== undefined ? { operation: toEngineMcpOperation(input.operation) } : {}),
    });
    createdId = request.id;
    return { ...container, requests: [...container.requests, request] };
  });
  if (next === undefined) notFound('folder', input.parentId ?? input.apiId);
  return { project: replaceMcpServer(project, next), createdId };
}

/** The saved request with a patch applied: what the editor is looking at, for this send or update. */
export function withMcpPatch(request: McpRequestDef, patch?: McpRequestPatchWire): McpRequestDef {
  if (patch === undefined) return request;
  return cleanUndefined<McpRequestDef>({
    ...request,
    name: patch.name ?? request.name,
    description: patch.description === null ? undefined : (patch.description ?? request.description),
    operation: patch.operation !== undefined ? toEngineMcpOperation(patch.operation) : request.operation,
    settings: patch.settings !== undefined ? cleanUndefined<McpRequestSettings>(patch.settings) : request.settings,
  });
}

/** Applies a patch to an MCP request; a rename re-slugs it within its container. */
export function updateMcpRequest(project: Project, requestId: string, patch: McpRequestPatchWire): McpMutationResult {
  const server = mcpServerOwning(project, requestId) ?? notFound('request', requestId);
  const apply = (container: Container): Container => ({
    ...container,
    requests: container.requests.map((request) => {
      if (request.id !== requestId) return request;
      return {
        ...withMcpPatch(request, patch),
        slug:
          patch.name !== undefined && patch.name !== request.name
            ? uniqueSlug(patch.name, takenSlugs(container, request.id))
            : request.slug,
      };
    }),
    folders: container.folders.map((folder) => ({ ...folder, ...apply(folder) })),
  });
  return { project: replaceMcpServer(project, { ...server, ...apply(server) }) };
}

/** Removes an MCP request from wherever it is. */
export function removeMcpRequest(project: Project, requestId: string): McpMutationResult {
  const server = mcpServerOwning(project, requestId) ?? notFound('request', requestId);
  const { server: next, removed } = extractRequest(server, requestId);
  if (removed === undefined) notFound('request', requestId);
  return { project: replaceMcpServer(project, next) };
}

/** Duplicates an MCP request beside the original, named `<name> copy`, with a fresh id. */
export function cloneMcpRequest(project: Project, requestId: string): McpMutationResult {
  const server = mcpServerOwning(project, requestId) ?? notFound('request', requestId);
  let createdId = '';
  const apply = (container: Container): Container => {
    const index = container.requests.findIndex((request) => request.id === requestId);
    if (index === -1) {
      return { ...container, folders: container.folders.map((folder) => ({ ...folder, ...apply(folder) })) };
    }
    const original = container.requests[index]!;
    const name = `${original.name} copy`;
    const copy = createMcpRequest(name, {
      slug: uniqueSlug(name, takenSlugs(container)),
      operation: original.operation,
      settings: original.settings,
      assertions: original.assertions,
      ...(original.description !== undefined ? { description: original.description } : {}),
      ...(original.scripts !== undefined ? { scripts: original.scripts } : {}),
    });
    createdId = copy.id;
    const requests = [...container.requests];
    requests.splice(index + 1, 0, copy);
    return { ...container, requests: renumber(requests) };
  };
  return { project: replaceMcpServer(project, { ...server, ...apply(server) }), createdId };
}

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

/** Moves an MCP folder or request to a new parent at an index, inside its own server only. */
export function moveMcpNode(
  project: Project,
  input: { readonly nodeId: string; readonly parentId?: string; readonly index: number },
): McpMutationResult {
  const server = mcpServerOwning(project, input.nodeId) ?? notFound('node', input.nodeId);
  if (input.parentId !== undefined && input.parentId === input.nodeId) {
    throw new ProjectError('project-move-into-self', 'A folder cannot be moved into itself', {
      details: { nodeId: input.nodeId },
    });
  }
  const folderMove = extractFolder(server.folders, input.nodeId);
  if (folderMove.removed !== undefined) {
    const moved = folderMove.removed;
    if (input.parentId !== undefined && containerHolds(moved, input.parentId)) {
      throw new ProjectError('project-move-into-self', 'A folder cannot be moved inside itself', {
        details: { nodeId: input.nodeId, parentId: input.parentId },
      });
    }
    const stripped: McpServer = { ...server, folders: renumber(folderMove.folders) };
    const next = inContainer(stripped, input.parentId, (container) => {
      const folders = [...container.folders];
      folders.splice(clamp(input.index, folders.length), 0, {
        ...moved,
        slug: uniqueSlug(moved.name, takenSlugs(container, moved.id)),
      });
      return { ...container, folders: renumber(folders) };
    });
    if (next === undefined) notFound('folder', input.parentId ?? server.id);
    return { project: replaceMcpServer(project, next) };
  }
  const requestMove = extractRequest(server, input.nodeId);
  if (requestMove.removed === undefined) notFound('node', input.nodeId);
  const moved = requestMove.removed;
  const next = inContainer(requestMove.server, input.parentId, (container) => {
    const requests = [...container.requests];
    requests.splice(clamp(input.index, requests.length), 0, {
      ...moved,
      slug: uniqueSlug(moved.name, takenSlugs(container, moved.id)),
    });
    return { ...container, requests: renumber(requests) };
  });
  if (next === undefined) notFound('folder', input.parentId ?? server.id);
  return { project: replaceMcpServer(project, next) };
}

/** The change kinds MCP owns. */
export const mcpMutations: KindMutations = {
  'add-mcp-server': (project, change) =>
    addMcpServer(project, {
      name: change.name,
      ...(change.transport !== undefined ? { transport: change.transport } : {}),
    }),
  'update-mcp-server': (project, change) => updateMcpServer(project, change.apiId, change.patch),
  'remove-mcp-server': (project, change) => removeMcpServer(project, change.apiId),
  'add-mcp-request': (project, change) =>
    addMcpRequest(project, {
      apiId: change.apiId,
      ...(change.parentId !== undefined ? { parentId: change.parentId } : {}),
      ...(change.name !== undefined ? { name: change.name } : {}),
      ...(change.operation !== undefined ? { operation: change.operation } : {}),
    }),
  'update-mcp-request': (project, change) => updateMcpRequest(project, change.requestId, change.patch),
  'remove-mcp-request': (project, change) => removeMcpRequest(project, change.requestId),
  'clone-mcp-request': (project, change) => cloneMcpRequest(project, change.requestId),
};
