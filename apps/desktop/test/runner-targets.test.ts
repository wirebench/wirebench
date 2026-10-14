// @vitest-environment node
/**
 * Runner targets for MCP (#79): *Run…* on a server row runs the server's requests, as an API's, and a
 * folder of a server runs its own; each request is listed with its kind.
 */
import { describe, expect, it } from 'vitest';
import { createMcpFolder, createMcpRequest, createMcpServer, createProject, withMcpServers } from '@wirebench/engine';
import { resolveTarget, runnerRequests } from '../src/main/runner/targets.js';
import { defaultRunnerSettings } from '../src/shared/runner-defaults.js';

function project() {
  const nested = createMcpRequest('Read a file', {
    id: 'mcp-read',
    operation: { method: 'tools/call', tool: 'read_file', arguments: '{}' },
  });
  const server = createMcpServer('Files', {
    id: 'mcp-api-1',
    requests: [createMcpRequest('List tools', { id: 'mcp-list' })],
    folders: [createMcpFolder('Reads', { id: 'mcp-folder', requests: [nested] })],
  });
  return withMcpServers(createProject('Demo', { id: 'p1' }), [server]);
}

describe('an MCP Runner target', () => {
  it('runs a server’s requests, as an API’s', () => {
    const target = resolveTarget(project(), 'mcp-api-1');
    expect(target).toMatchObject({ kind: 'api', id: 'mcp-api-1', name: 'Files' });
    expect(runnerRequests(target!, defaultRunnerSettings())).toEqual([
      expect.objectContaining({ id: 'mcp-list', name: 'List tools', protocol: 'mcp' }),
      expect.objectContaining({ id: 'mcp-read', name: 'Read a file', protocol: 'mcp' }),
    ]);
  });

  it('runs a server folder’s own requests', () => {
    const target = resolveTarget(project(), 'mcp-folder');
    expect(target).toMatchObject({ kind: 'folder', name: 'Reads' });
    expect(runnerRequests(target!, defaultRunnerSettings()).map((request) => request.id)).toEqual(['mcp-read']);
  });
});

describe('a single-request Runner target', () => {
  it('runs one request on its own, named after it', () => {
    const target = resolveTarget(project(), 'mcp-read');
    expect(target).toMatchObject({ kind: 'request', id: 'mcp-read', name: 'Read a file' });
    expect(runnerRequests(target!, defaultRunnerSettings()).map((request) => request.id)).toEqual(['mcp-read']);
  });

  it('names nothing for an id no request, folder or API has', () => {
    expect(resolveTarget(project(), 'nope')).toBeUndefined();
  });
});
