/**
 * The MCP mutations (#79): what each `ProjectChange` does to an MCP server and its tree, through the
 * same `applyChange` every change goes through, and the rules the file layout depends on: unique
 * slugs, a rename that re-slugs, a move that stays inside its own server, and a catalogue no change
 * can write.
 */
import { describe, expect, it } from 'vitest';
import { createMcpFolder, createMcpRequest, createMcpServer, createProject, mcpServersOf } from '@wirebench/engine';
import type { McpServer, Project } from '@wirebench/engine';
import { applyChange, type MutationDeps } from '../src/project-mutations.js';
import type { ProjectChange } from '@wirebench/wire/wire-types';

const deps: MutationDeps = { generate: () => Promise.reject(new Error('not used')) };

/** A project with one stdio server: a root request and a `Files` folder holding one. */
function seeded(): Project {
  const server: McpServer = createMcpServer('Local files', {
    id: 's-1',
    transport: { type: 'stdio', command: 'node', args: ['server.mjs'], env: [] },
    catalogueInfo: {
      fetchedAt: '2026-10-13T00:00:00.000Z',
      serverInfo: { name: 'fs', version: '1' },
      protocolVersion: 'x',
    },
    catalogue: { tools: [{ name: 'read', inputSchema: { type: 'object' } }] },
    requests: [createMcpRequest('List tools', { id: 'q-root' })],
    folders: [
      createMcpFolder('Files', {
        id: 'f-1',
        requests: [
          createMcpRequest('Read', {
            id: 'q-read',
            operation: { method: 'tools/call', tool: 'read', arguments: '{"path":"a"}' },
          }),
        ],
      }),
    ],
  });
  return { ...createProject('Demo', { id: 'p1' }), containers: { mcp: [server] } };
}

async function apply(project: Project, change: ProjectChange) {
  return applyChange(project, change, deps);
}

const server = (project: Project): McpServer => mcpServersOf(project)[0]!;

describe('MCP server changes', () => {
  it('adds a stdio server with no command by default, and one with the transport given', async () => {
    const plain = await apply(createProject('P'), { kind: 'add-mcp-server', name: 'Files' });
    expect(server(plain.project)).toMatchObject({
      id: plain.createdId,
      name: 'Files',
      slug: 'Files',
      transport: { type: 'stdio', command: '', args: [], env: [] },
    });
    const http = await apply(plain.project, {
      kind: 'add-mcp-server',
      name: 'Files',
      transport: {
        type: 'http',
        url: 'https://mcp.test/mcp',
        headers: [{ name: 'x-a', value: '1', enabled: true }],
        auth: { type: 'bearer', tokenRef: 'sec_t' },
      },
    });
    const added = mcpServersOf(http.project)[1]!;
    expect(added.slug).not.toBe('Files');
    expect(added.transport).toEqual({
      type: 'http',
      url: 'https://mcp.test/mcp',
      headers: [{ name: 'x-a', value: '1', enabled: true }],
      auth: { type: 'bearer', tokenRef: 'sec_t' },
    });
    expect(added.order).toBeGreaterThan(server(http.project).order);
  });

  it('renames, re-slugs, replaces the transport and settings, clears the description and keeps the catalogue', async () => {
    const described = await apply(seeded(), { kind: 'update-mcp-server', apiId: 's-1', patch: { description: 'd' } });
    const { project } = await apply(described.project, {
      kind: 'update-mcp-server',
      apiId: 's-1',
      patch: {
        name: 'Remote',
        description: null,
        transport: { type: 'sse', url: 'https://mcp.test/sse', headers: [] },
        settings: { timeoutMs: 5000 },
      },
    });
    const next = server(project);
    expect(next).toMatchObject({ name: 'Remote', slug: 'Remote', settings: { timeoutMs: 5000 } });
    expect(next.description).toBeUndefined();
    expect('description' in next).toBe(false);
    expect(next.transport).toEqual({ type: 'sse', url: 'https://mcp.test/sse', headers: [] });
    expect(next.catalogue).toEqual(server(seeded()).catalogue);
    expect(next.catalogueInfo).toEqual(server(seeded()).catalogueInfo);
  });

  it('removes a server and everything in it', async () => {
    const { project } = await apply(seeded(), { kind: 'remove-mcp-server', apiId: 's-1' });
    expect(mcpServersOf(project)).toEqual([]);
  });
});

describe('MCP request changes', () => {
  it('adds a request that lists tools by default, or the operation given, in a folder', async () => {
    const listed = await apply(seeded(), { kind: 'add-mcp-request', apiId: 's-1' });
    const root = server(listed.project).requests.find((request) => request.id === listed.createdId)!;
    expect(root).toMatchObject({ name: 'Request 1', operation: { method: 'tools/list' }, order: 1 });

    const prompt = await apply(seeded(), {
      kind: 'add-mcp-request',
      apiId: 's-1',
      parentId: 'f-1',
      name: 'Greet',
      operation: { method: 'prompts/get', prompt: 'greet', arguments: [{ name: 'who', value: 'Ada', enabled: true }] },
    });
    const inFolder = server(prompt.project).folders[0]!.requests.find((request) => request.id === prompt.createdId)!;
    expect(inFolder.operation).toEqual({
      method: 'prompts/get',
      prompt: 'greet',
      arguments: [{ name: 'who', value: 'Ada', enabled: true }],
    });
  });

  it('replaces the operation and settings, and re-slugs on a rename', async () => {
    const { project } = await apply(seeded(), {
      kind: 'update-mcp-request',
      requestId: 'q-read',
      patch: {
        name: 'Read file',
        operation: { method: 'resources/read', uri: 'file:///a' },
        settings: { timeoutMs: 9 },
      },
    });
    const request = server(project).folders[0]!.requests[0]!;
    expect(request).toMatchObject({
      name: 'Read file',
      slug: 'Read file',
      operation: { method: 'resources/read', uri: 'file:///a' },
      settings: { timeoutMs: 9 },
    });
  });

  it('clones beside the original with a fresh id, and removes', async () => {
    const cloned = await apply(seeded(), { kind: 'clone-mcp-request', requestId: 'q-read' });
    const requests = server(cloned.project).folders[0]!.requests;
    expect(requests.map((request) => request.name)).toEqual(['Read', 'Read copy']);
    expect(requests[1]!.id).toBe(cloned.createdId);
    expect(requests[1]!.operation).toEqual(requests[0]!.operation);

    const removed = await apply(cloned.project, { kind: 'remove-mcp-request', requestId: 'q-read' });
    expect(server(removed.project).folders[0]!.requests.map((request) => request.id)).toEqual([cloned.createdId]);
  });

  it('edits an MCP request through the shared assertions and scripts changes', async () => {
    const asserted = await apply(seeded(), {
      kind: 'set-request-assertions',
      requestId: 'q-read',
      assertions: [{ type: 'status', equals: 0 }],
    });
    expect(server(asserted.project).folders[0]!.requests[0]!.assertions).toHaveLength(1);
    const scripted = await apply(seeded(), {
      kind: 'update-request-scripts',
      requestId: 'q-read',
      scripts: { pre: 'wb.request.arguments = {}' },
    });
    expect(server(scripted.project).folders[0]!.requests[0]!.scripts?.pre?.text).toBe('wb.request.arguments = {}');
    const folderScripted = await apply(seeded(), {
      kind: 'update-request-scripts',
      requestId: 'f-1',
      scripts: { post: 'tests.ok = true' },
    });
    expect(server(folderScripted.project).folders[0]!.scripts?.post?.text).toBe('tests.ok = true');
  });
});

describe('MCP folders', () => {
  it('adds, renames and removes a folder through the shared folder changes', async () => {
    const added = await apply(seeded(), { kind: 'add-folder', apiId: 's-1', name: 'Prompts' });
    expect(server(added.project).folders.map((folder) => folder.name)).toEqual(['Files', 'Prompts']);
    const renamed = await apply(added.project, {
      kind: 'update-folder',
      folderId: added.createdId!,
      patch: { name: 'Greetings', description: 'all of them' },
    });
    expect(server(renamed.project).folders[1]).toMatchObject({ name: 'Greetings', description: 'all of them' });
    const removed = await apply(renamed.project, { kind: 'remove-folder', folderId: added.createdId! });
    expect(server(removed.project).folders.map((folder) => folder.id)).toEqual(['f-1']);
  });

  it('moves a request into a folder, and refuses a folder into itself', async () => {
    const { project } = await apply(seeded(), { kind: 'move-node', nodeId: 'q-root', parentId: 'f-1', index: 0 });
    expect(server(project).requests).toEqual([]);
    expect(server(project).folders[0]!.requests.map((request) => request.id)).toEqual(['q-root', 'q-read']);
    const error = await apply(seeded(), { kind: 'move-node', nodeId: 'f-1', parentId: 'f-1', index: 0 }).catch(
      (caught: unknown) => caught,
    );
    expect((error as { code?: string }).code).toBe('project-move-into-self');
  });
});
