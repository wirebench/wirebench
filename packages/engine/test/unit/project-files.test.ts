/**
 * The published JSON Schemas (#66) against what a build writes: real project folders, loaded and
 * saved at the current format, must have every YAML file claimed by exactly one kind and valid
 * against that kind's schema. A JSON Schema validator does the checking, not Zod, so a schema that
 * drops or misstates a constraint in the conversion fails here.
 */
import { cp, readFile } from 'node:fs/promises';
import { join, matchesGlob } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { createMcpFolder, createMcpRequest, createMcpServer } from '../../src/mcp/model.js';
import { createMock, createMockOperation, createMockResponse } from '../../src/mock/model.js';
import { PROJECT_FILE_KINDS, PROJECT_SCHEMA_BASE_URL, projectJsonSchemas } from '../../src/project-files.js';
import { loadProject } from '../../src/project/load.js';
import { FORMAT_VERSION } from '../../src/project/model.js';
import { saveProject } from '../../src/project/save.js';
import { parseYaml } from '../../src/project/yaml.js';
import { listTree, sampleProject, tempProjectDir } from './project/fixture.js';

const ENGINE_FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const PROJECTS = {
  'format-v5 fixture': join(ENGINE_FIXTURES, 'format-v5', 'project'),
  'CLI runner fixture': join(import.meta.dirname, '..', '..', '..', 'cli', 'test', 'fixtures', 'runner-project'),
};

function validators() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return new Map(projectJsonSchemas().map(({ kind, schema }) => [kind.name, ajv.compile(schema)]));
}

/** The kinds whose globs claim `relative`. */
function kindsOf(relative: string): string[] {
  return PROJECT_FILE_KINDS.filter((kind) => kind.files.some((glob) => matchesGlob(relative, glob))).map(
    (kind) => kind.name,
  );
}

async function expectValidTree(dir: string): Promise<void> {
  const validate = validators();
  const files = (await listTree(dir)).filter((file) => file.endsWith('.yaml'));
  expect(files).toContain('wirebench.yaml');
  for (const file of files) {
    const kinds = kindsOf(file);
    expect(kinds, file).toHaveLength(1);
    const check = validate.get(kinds[0]!)!;
    const valid = check(parseYaml(await readFile(join(dir, file), 'utf8'), file));
    expect(check.errors ?? [], file).toEqual([]);
    expect(valid, file).toBe(true);
  }
}

describe('projectJsonSchemas', () => {
  it('gives every kind its own schema, under the current format version', () => {
    const schemas = projectJsonSchemas();
    expect(new Set(schemas.map(({ path }) => path)).size).toBe(PROJECT_FILE_KINDS.length);
    for (const { path, kind, schema } of schemas) {
      expect(path).toBe(`v${FORMAT_VERSION}/${kind.name}.schema.json`);
      expect(schema['$id']).toBe(`${PROJECT_SCHEMA_BASE_URL}/${path}`);
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    }
  });

  it.each(Object.entries(PROJECTS))(
    'accepts every YAML file of the %s, saved at the current format',
    async (_, source) => {
      const dir = await tempProjectDir();
      await cp(source, dir, { recursive: true });
      const { project, problems } = await loadProject(dir);
      expect(problems).toEqual([]);
      await saveProject(project, dir);
      await expectValidTree(dir);
    },
  );

  it('accepts every YAML file of a sample project as saved', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);
    await expectValidTree(dir);
  });

  it('accepts the files of a saved mock, every field set', async () => {
    const dir = await tempProjectDir();
    const response = createMockResponse('Out of stock', {
      status: 500,
      headers: [{ name: 'X-Trace', value: 'mock' }],
      delayMs: 250,
      body: 'xml',
      bodyText: '<fault/>',
      match: [
        {
          from: 'body',
          language: 'xpath',
          expression: '//ord:sku',
          namespaces: { ord: 'urn:orders' },
          equals: 'SKU-0',
        },
        { from: 'query', name: 'dryRun', exists: false },
      ],
      scenario: { name: 'stock', state: 'Empty', next: 'Restocked' },
    });
    const mock = createMock(
      'Orders mock',
      { containerId: 'C1', binding: '{urn:orders}OrderSoap' },
      {
        description: 'Stands in for orders.',
        port: 8089,
        path: '/orders',
        validation: 'report',
        operations: [
          createMockOperation('PlaceOrder', 'PlaceOrder', {
            dispatch: 'match',
            defaultResponseId: response.id,
            responses: [response],
          }),
        ],
      },
    );
    await saveProject({ ...sampleProject(), mocks: [mock] }, dir);
    const files = await listTree(dir);
    expect(files.filter((file) => file.startsWith('mocks/') && file.endsWith('.yaml'))).toHaveLength(3);
    await expectValidTree(dir);
  });

  it('accepts the files of saved MCP servers, every transport and operation (#79)', async () => {
    const dir = await tempProjectDir();
    const call = createMcpRequest('Forecast', {
      operation: { method: 'tools/call', tool: 'get_weather', arguments: '{"city":"Oslo"}' },
      settings: { timeoutMs: 2_000 },
    });
    const prompt = createMcpRequest('Summary', {
      order: 1,
      operation: {
        method: 'prompts/get',
        prompt: 'summarise',
        arguments: [{ name: 'topic', value: 'rain', enabled: true }],
      },
    });
    const read = createMcpRequest('Log', { order: 2, operation: { method: 'resources/read', uri: 'file:///log' } });
    const stdio = createMcpServer('Local', {
      transport: {
        type: 'stdio',
        command: 'node',
        args: ['s.js'],
        cwd: 'tools',
        env: [{ name: 'K', value: '${secret:k}', enabled: true }],
      },
      settings: { timeoutMs: 5_000, protocolVersion: '2025-06-18' },
      catalogueInfo: {
        fetchedAt: '2026-10-13T00:00:00.000Z',
        serverInfo: { name: 's', version: '1' },
        protocolVersion: '2025-06-18',
      },
      catalogue: { tools: [] },
      requests: [call, prompt, read],
      folders: [createMcpFolder('Lists', { requests: [createMcpRequest('Tools')] })],
    });
    const http = createMcpServer('Remote', {
      order: 1,
      transport: {
        type: 'http',
        url: 'https://mcp.test/mcp',
        headers: [{ name: 'X-A', value: '1', enabled: false }],
        auth: { type: 'bearer', tokenRef: 'r' },
      },
    });
    const sse = createMcpServer('Legacy', {
      order: 2,
      transport: { type: 'sse', url: 'https://mcp.test/sse', headers: [] },
    });
    await saveProject(
      { ...sampleProject(), containers: { ...sampleProject().containers, mcp: [stdio, http, sse] } },
      dir,
    );
    expect((await listTree(dir)).filter((file) => /^apis\/(Local|Remote|Legacy)\/.*\.yaml$/.test(file))).toHaveLength(
      8,
    );
    await expectValidTree(dir);
  });

  it('refuses a manifest of another format version, and a request without its kind', () => {
    const validate = validators();
    const manifest = {
      formatVersion: FORMAT_VERSION - 1,
      id: 'p1',
      name: 'P',
      settings: { cacheDefinitions: true, defaultTimeoutMs: 30000, prettyPrintResponses: true },
      properties: {},
    };
    expect(validate.get('manifest')!(manifest)).toBe(false);
    expect(validate.get('manifest')!({ ...manifest, formatVersion: FORMAT_VERSION })).toBe(true);

    const request = { kind: 'rest', id: 'r1', name: 'R', order: 0, method: 'GET', url: 'https://example.test' };
    expect(validate.get('api-request')!(request)).toBe(true);
    const withoutKind: Partial<typeof request> = { ...request };
    delete withoutKind.kind;
    expect(validate.get('api-request')!(withoutKind)).toBe(false);
  });
});
