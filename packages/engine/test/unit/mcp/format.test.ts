/**
 * The MCP fifth of the `apis/` folder (#79): a server shares the directory with the other APIs and
 * says so with `kind: mcp`; a call's arguments go to a sibling `<slug>.args.json` only when there
 * are any; the catalogue goes to `catalogue.json` in a stable order; and loading back produces the
 * same model, byte-stably.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serializeMcpCatalogue } from '../../../src/mcp/files.js';
import {
  createMcpFolder,
  createMcpRequest,
  createMcpServer,
  mcpServerFolders,
  mcpServerRequests,
  mcpServersOf,
} from '../../../src/mcp/model.js';
import type { McpCatalogue, McpOperation, McpServer, McpTransport } from '../../../src/mcp/model.js';
import { loadProject } from '../../../src/project/load.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import { projectFiles } from '../../../src/project/serialize.js';
import { tempProjectDir } from '../project/fixture.js';

function projectWith(...servers: McpServer[]): Project {
  return { ...createProject('MCP Project', { id: 'P1' }), containers: { mcp: servers } };
}

/** Writes a file map straight to a temp directory and loads it back. */
async function loadFrom(files: ReadonlyMap<string, string>) {
  const dir = await tempProjectDir();
  for (const [relative, content] of files) {
    const absolute = join(dir, ...relative.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  const result = await loadProject(dir);
  await rm(dir, { recursive: true, force: true });
  return result;
}

async function expectRoundTrip(project: Project): Promise<ReadonlyMap<string, string>> {
  const first = projectFiles(project);
  const reloaded = await loadFrom(first);
  expect(reloaded.problems).toEqual([]);
  expect(mcpServersOf(reloaded.project)).toEqual(mcpServersOf(project));
  expect(projectFiles(reloaded.project)).toEqual(first);
  return first;
}

const TRANSPORTS: readonly McpTransport[] = [
  {
    type: 'stdio',
    command: 'node',
    args: ['server.js', '--port', '${port}'],
    cwd: 'tools/mcp',
    env: [
      { name: 'API_KEY', value: '${secret:weather-key}', enabled: true },
      { name: 'DEBUG', value: '1', enabled: false },
    ],
  },
  { type: 'stdio', command: 'weather-mcp', args: [], env: [] },
  {
    type: 'http',
    url: 'https://mcp.example.test/mcp',
    headers: [{ name: 'X-Tenant', value: 'acme', enabled: true }],
    auth: { type: 'bearer', tokenRef: 'ref-1' },
  },
  { type: 'http', url: 'http://localhost:3000/mcp', headers: [] },
  { type: 'sse', url: 'https://legacy.example.test/sse', headers: [], auth: { type: 'none' } },
];

const OPERATIONS: readonly McpOperation[] = [
  { method: 'tools/list' },
  { method: 'resources/list' },
  { method: 'resources/templates/list' },
  { method: 'prompts/list' },
  { method: 'tools/call', tool: 'get_weather', arguments: '{\n  "city": "${city}"\n}\n' },
  { method: 'tools/call', tool: 'ping', arguments: '' },
  { method: 'resources/read', uri: 'file:///logs/${day}.txt' },
  {
    method: 'prompts/get',
    prompt: 'summarise',
    arguments: [
      { name: 'topic', value: 'rain', enabled: true },
      { name: 'tone', value: 'dry', enabled: false },
    ],
  },
  { method: 'prompts/get', prompt: 'hello', arguments: [] },
];

describe('an MCP server round-trips byte-identically', () => {
  it.each(TRANSPORTS.map((transport) => [transport.type, transport] as const))(
    'with a %s transport',
    async (_type, transport) => {
      const files = await expectRoundTrip(
        projectWith(
          createMcpServer('Weather', {
            id: 'S1',
            transport,
            settings: { timeoutMs: 5_000, protocolVersion: '2025-06-18' },
          }),
        ),
      );
      expect(files.get('apis/Weather/api.yaml')).toContain('kind: mcp\n');
    },
  );

  it.each(OPERATIONS.map((operation, index) => [operation.method, index, operation] as const))(
    'with a %s request (#%i)',
    async (_method, _index, operation) => {
      const request = createMcpRequest('Op', {
        id: 'R1',
        operation,
        settings: { timeoutMs: 1_000 },
        assertions: [{ type: 'match', language: 'jsonpath', expression: '$.content[0].text', equals: 'ok' }],
      });
      await expectRoundTrip(projectWith(createMcpServer('Weather', { id: 'S1', requests: [request] })));
    },
  );

  it('with folders, scripts and the catalogue', async () => {
    const project = projectWith(
      createMcpServer('Weather', {
        id: 'S1',
        description: 'The forecast server',
        catalogueInfo: {
          fetchedAt: '2026-10-13T10:00:00.000Z',
          serverInfo: { name: 'weather', version: '1.2.0' },
          protocolVersion: '2025-06-18',
        },
        catalogue: {
          tools: [{ name: 'get_weather', description: 'Forecast', inputSchema: { type: 'object' } }],
          prompts: [{ name: 'summarise', arguments: [{ name: 'topic', required: true }] }],
        },
        folders: [
          createMcpFolder('Calls', {
            id: 'F1',
            requests: [
              createMcpRequest('Forecast', {
                id: 'R1',
                operation: { method: 'tools/call', tool: 'get_weather', arguments: '{"city":"Oslo"}' },
                scripts: {
                  pre: { text: 'wb.vars.set("a", "1");\n' },
                  api: 'wirebench',
                  enabled: true,
                  secrets: [],
                },
              }),
            ],
          }),
        ],
      }),
    );
    const files = await expectRoundTrip(project);
    expect([...files.keys()].filter((key) => key.startsWith('apis/Weather/')).sort()).toEqual([
      'apis/Weather/api.yaml',
      'apis/Weather/catalogue.json',
      'apis/Weather/requests/Calls/Forecast.args.json',
      'apis/Weather/requests/Calls/Forecast.pre.ts',
      'apis/Weather/requests/Calls/Forecast.request.yaml',
      'apis/Weather/requests/Calls/folder.yaml',
    ]);
    const server = mcpServersOf(project)[0]!;
    expect(mcpServerRequests(server).map((request) => request.id)).toEqual(['R1']);
    expect(mcpServerFolders(server).map((folder) => folder.id)).toEqual(['F1']);
  });
});

describe('a tools/call request’s arguments', () => {
  it('go to <slug>.args.json, named from the request', () => {
    const request = createMcpRequest('Forecast', {
      id: 'R1',
      operation: { method: 'tools/call', tool: 'get_weather', arguments: '{"city":"Oslo"}' },
    });
    const files = projectFiles(projectWith(createMcpServer('Weather', { id: 'S1', requests: [request] })));
    expect(files.get('apis/Weather/requests/Forecast.args.json')).toBe('{"city":"Oslo"}');
    expect(files.get('apis/Weather/requests/Forecast.request.yaml')).toContain(
      'operation:\n  arguments:\n    file: Forecast.args.json\n  method: tools/call\n  tool: get_weather\n',
    );
  });

  it('write no file when there are none', () => {
    const request = createMcpRequest('Ping', {
      id: 'R1',
      operation: { method: 'tools/call', tool: 'ping', arguments: '  \n' },
    });
    const files = projectFiles(projectWith(createMcpServer('Weather', { id: 'S1', requests: [request] })));
    expect([...files.keys()].filter((key) => key.endsWith('.args.json'))).toEqual([]);
    expect(files.get('apis/Weather/requests/Ping.request.yaml')).not.toContain('arguments');
  });

  it('load as none, with a problem, when the file is gone', async () => {
    const request = createMcpRequest('Forecast', {
      id: 'R1',
      operation: { method: 'tools/call', tool: 'get_weather', arguments: '{"city":"Oslo"}' },
    });
    const files = new Map(projectFiles(projectWith(createMcpServer('Weather', { id: 'S1', requests: [request] }))));
    files.delete('apis/Weather/requests/Forecast.args.json');
    const { project, problems } = await loadFrom(files);
    expect(mcpServersOf(project)[0]?.requests[0]?.operation).toEqual({
      method: 'tools/call',
      tool: 'get_weather',
      arguments: '',
    });
    expect(problems).toEqual([
      {
        code: 'missing-body',
        message: 'Request "Forecast" has no arguments file; loaded with no arguments',
        file: 'apis/Weather/requests/Forecast.args.json',
      },
    ]);
  });

  it.each(['../../../secret.json', 'nested/args.json', '..'])(
    'refuse a file name that leaves the request’s folder: %s',
    async (file) => {
      const files = new Map(projectFiles(projectWith(createMcpServer('Weather', { id: 'S1' }))));
      files.set(
        'apis/Weather/requests/Leak.request.yaml',
        `kind: mcp\nid: R1\nname: Leak\norder: 0\noperation:\n  method: tools/call\n  tool: t\n  arguments:\n    file: ${JSON.stringify(file)}\n`,
      );
      await expect(loadFrom(files)).rejects.toMatchObject({ code: 'project-path-invalid' });
    },
  );

  it('are deleted by a save that no longer has them', async () => {
    const dir = await tempProjectDir();
    const withArgs = createMcpRequest('Forecast', {
      id: 'R1',
      operation: { method: 'tools/call', tool: 'get_weather', arguments: '{"city":"Oslo"}' },
    });
    await saveProject(projectWith(createMcpServer('Weather', { id: 'S1', requests: [withArgs] })), dir);
    const cleared = { ...withArgs, operation: { method: 'tools/call', tool: 'get_weather', arguments: '' } } as const;
    const result = await saveProject(projectWith(createMcpServer('Weather', { id: 'S1', requests: [cleared] })), dir);
    expect(result.removed).toEqual(['apis/Weather/requests/Forecast.args.json']);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('catalogue.json', () => {
  const unsorted: McpCatalogue = {
    prompts: [{ name: 'b' }, { description: 'first', name: 'a' }],
    tools: [
      { name: 'zeta', inputSchema: { type: 'object', properties: { b: {}, a: {} } } },
      { inputSchema: { type: 'object' }, description: 'Alpha', name: 'alpha', title: 'Alpha tool', extra: 1 },
    ],
    resourceTemplates: [{ uriTemplate: 'mem://{id}', name: 'mem' }],
    resources: [
      { uri: 'file:///z', name: 'z' },
      { uri: 'file:///a', name: 'a' },
    ],
  };

  it('is sorted by name or URI, with each entry’s keys in a fixed order, the rest kept as sent', () => {
    const text = serializeMcpCatalogue(unsorted);
    const document = JSON.parse(text) as Required<Record<keyof McpCatalogue, { readonly [key: string]: unknown }[]>>;
    expect(Object.keys(document)).toEqual(['tools', 'resources', 'resourceTemplates', 'prompts']);
    expect(document.tools.map((tool) => tool['name'])).toEqual(['alpha', 'zeta']);
    expect(Object.keys(document.tools[0]!)).toEqual(['name', 'title', 'description', 'inputSchema', 'extra']);
    expect(Object.keys((document.tools[1]!['inputSchema'] as { properties: object }).properties)).toEqual(['b', 'a']);
    expect(document.resources.map((resource) => resource['uri'])).toEqual(['file:///a', 'file:///z']);
    expect(document.prompts.map((prompt) => prompt['name'])).toEqual(['a', 'b']);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('is the same bytes whatever order the server listed things in', () => {
    const reversed: McpCatalogue = {
      tools: [...unsorted.tools!].reverse(),
      resources: [...unsorted.resources!].reverse(),
      resourceTemplates: unsorted.resourceTemplates!,
      prompts: [...unsorted.prompts!].reverse(),
    };
    expect(serializeMcpCatalogue(reversed)).toBe(serializeMcpCatalogue(unsorted));
  });

  it('holds only the lists the server advertised', () => {
    expect(serializeMcpCatalogue({ tools: [] })).toBe('{\n  "tools": []\n}\n');
  });

  it('is deleted by a save once the server has none', async () => {
    const dir = await tempProjectDir();
    await saveProject(projectWith(createMcpServer('Weather', { id: 'S1', catalogue: { tools: [] } })), dir);
    const result = await saveProject(projectWith(createMcpServer('Weather', { id: 'S1' })), dir);
    expect(result.removed).toEqual(['apis/Weather/catalogue.json']);
    await rm(dir, { recursive: true, force: true });
  });

  it('that does not read as a catalogue is a problem, and a save leaves it as it is', async () => {
    const dir = await tempProjectDir();
    await saveProject(projectWith(createMcpServer('Weather', { id: 'S1' })), dir);
    await writeFile(join(dir, 'apis', 'Weather', 'catalogue.json'), '{ not json', 'utf8');
    const { project, problems } = await loadProject(dir);
    expect(mcpServersOf(project)[0]?.catalogue).toBeUndefined();
    expect(problems.map((problem) => [problem.code, problem.file])).toEqual([
      ['catalogue-file-invalid', 'apis/Weather/catalogue.json'],
    ]);
    const result = await saveProject(project, dir);
    expect(result.removed).toEqual([]);
    expect(await readFile(join(dir, 'apis', 'Weather', 'catalogue.json'), 'utf8')).toBe('{ not json');
    await rm(dir, { recursive: true, force: true });
  });
});
