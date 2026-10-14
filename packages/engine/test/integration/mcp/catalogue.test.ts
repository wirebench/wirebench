/**
 * *Refresh catalogue* against real servers (#79): the stdio fixture behind the approval gate, a
 * server that advertises prompts only, a server that dies, and the Streamable HTTP helper.
 */
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refreshMcpCatalogue } from '../../../src/mcp/catalogue.js';
import { serializeMcpCatalogue } from '../../../src/mcp/files.js';
import { createMcpServer } from '../../../src/mcp/model.js';
import type { McpServer, McpTransport } from '../../../src/mcp/model.js';
import { createProject } from '../../../src/project/model.js';
import type { CommandApprovalRequest, SendHost } from '../../../src/run/host.js';
import { createRunScope } from '../../../src/run/scope.js';
import { startTestMcpHttpServer } from '../../helpers/mcp-http-server.js';
import type { TestMcpHttpServer } from '../../helpers/mcp-http-server.js';
import { testHost } from '../../helpers/send-host.js';

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/mcp/stdio-server.mjs');
const PROJECT_DIR = resolve(import.meta.dirname, '../../fixtures');

let http: TestMcpHttpServer;

beforeAll(async () => {
  http = await startTestMcpHttpServer({ json: true });
});

afterAll(async () => {
  await http.close();
});

const stdio = (mode: string): McpTransport => ({
  type: 'stdio',
  command: process.execPath,
  args: [FIXTURE, mode],
  env: [],
});

const scopeFor = (server: McpServer) =>
  createRunScope({
    project: { ...createProject('P', { id: 'p' }), containers: { mcp: [server] } },
    projectDir: PROJECT_DIR,
    overrides: {},
    host: testHost(),
  });

function approving(): { host: SendHost; asked: CommandApprovalRequest[] } {
  const asked: CommandApprovalRequest[] = [];
  return {
    asked,
    host: testHost(
      {},
      {
        approveCommand: (request) => {
          asked.push(request);
          return Promise.resolve(true);
        },
      },
    ),
  };
}

const now = () => new Date('2026-10-14T00:00:00.000Z');

describe('refreshMcpCatalogue', () => {
  it('lists the stdio fixture once its command is approved, sorted and with its metadata', async () => {
    const server = createMcpServer('Local', { id: 's1', transport: stdio('sdk') });
    const { host, asked } = approving();
    const refreshed = await refreshMcpCatalogue(server, scopeFor(server), host, { now });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ serverName: 'Local' });
    expect(Object.keys(refreshed.catalogue)).toEqual(['tools']);
    expect(refreshed.catalogue.tools!.map((t) => t.name)).toEqual(['echo', 'env', 'fail']);
    expect(refreshed.info).toMatchObject({
      fetchedAt: '2026-10-14T00:00:00.000Z',
      serverInfo: { name: 'fixture', version: '1.2.3' },
    });
    expect(refreshed.info.protocolVersion).not.toBe('');

    // A second refresh with nothing changed saves the same bytes.
    const again = await refreshMcpCatalogue(server, scopeFor(server), host, { now });
    expect(serializeMcpCatalogue(again.catalogue)).toBe(serializeMcpCatalogue(refreshed.catalogue));
  });

  it('keeps only the lists the server advertised', async () => {
    const server = createMcpServer('Prompts', { id: 's2', transport: stdio('sdk-prompts') });
    const { catalogue } = await refreshMcpCatalogue(server, scopeFor(server), approving().host);
    expect(Object.keys(catalogue)).toEqual(['prompts']);
    expect(catalogue.prompts!.map((p) => p.name)).toEqual(['greet']);
  });

  it('refuses a command the host has not approved, before anything runs', async () => {
    const server = createMcpServer('Local', { id: 's3', transport: stdio('sdk') });
    await expect(refreshMcpCatalogue(server, scopeFor(server), testHost())).rejects.toMatchObject({
      code: 'mcp-command-unapproved',
    });
  });

  it('fails with the session error, and the server stderr, when the server dies', async () => {
    const server = createMcpServer('Crash', { id: 's4', transport: stdio('crash') });
    await expect(refreshMcpCatalogue(server, scopeFor(server), approving().host)).rejects.toMatchObject({
      details: { stderr: expect.stringContaining('cannot open the database') as unknown },
    });
  });

  it('lists a Streamable HTTP server, which asks for no approval', async () => {
    const server = createMcpServer('Remote', { id: 's5', transport: { type: 'http', url: http.url, headers: [] } });
    const { catalogue, info } = await refreshMcpCatalogue(server, scopeFor(server), testHost());
    expect(catalogue.tools!.map((t) => t.name)).toEqual(['echo', 'fail', 'slow']);
    expect(info.serverInfo).toEqual({ name: 'http-fixture', version: '2.0.0' });
  });
});
