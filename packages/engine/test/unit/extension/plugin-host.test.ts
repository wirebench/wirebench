import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePluginManifest } from '#core/extension/plugin/manifest';
import type { InstalledPlugin } from '#core/extension/plugin/store';
import { envMarker } from '#core/http/codegen/index';
import type { CodeRequest } from '#core/http/codegen/index';
import type { RunResult } from '#core/run/run';
import { mapPluginImport } from '../../../src/import/plugin-import.js';
import { createPluginHost, detectPluginFormat, type PluginHost } from '../../../src/plugins.js';
import { createBuiltinRegistry } from '../../../src/protocols.js';
import { manifest } from './plugin-fixtures.js';

const CODE = `
export const importers = {
  acme: {
    detect(input) { return input.text.startsWith('ACME') ? 'definite' : null; },
    async import(input, context) {
      const remote = context.net ? (await context.net.fetch({ url: input.text.slice(5).trim() })).body : undefined;
      return {
        apis: [{ name: remote ?? 'Acme', items: [
          { kind: 'folder', name: 'Users', items: [
            { kind: 'request', name: 'List users', method: 'GET', url: '\${baseUrl}/users', headers: [{ name: 'Accept', value: 'application/json' }] },
          ] },
          { kind: 'request', name: 'Create', method: 'post', url: 'https://api.example.test/items', body: { kind: 'raw', text: '{"a":1}', contentType: 'application/json' } },
        ] }],
        variables: [{ name: 'baseUrl', value: 'https://api.example.test' }, { name: 'token', value: 'hidden', secret: true }],
      };
    },
  },
  bad: { detect() { return 'maybe'; }, import() { return { apis: 'no' }; } },
};
export const reporters = {
  summary: { render(report) { return report.requests.map((r) => r.name + ' ' + r.outcome + ' ' + ('exchange' in r)).join('\\n'); } },
};
export const codeGenerators = {
  echo: { generate(request, layout) { return { code: JSON.stringify({ request, layout }), notes: ['made by echo'] }; } },
};
`;

function plugin(overrides: Record<string, unknown> = {}): InstalledPlugin {
  const parsed = parsePluginManifest(
    JSON.stringify(
      manifest({
        contributes: {
          importers: [
            { id: 'acme', title: 'Acme collection' },
            { id: 'bad', title: 'Bad' },
          ],
          reporters: [{ id: 'summary', title: 'Summary', extension: '.txt' }],
          codeGenerators: [{ id: 'echo', title: 'Echo', language: 'json' }],
        },
        ...overrides,
      }),
    ),
  );
  if (!parsed.ok) throw new Error(parsed.problems.join('; '));
  return { manifest: parsed.manifest, code: CODE, dir: '/nowhere' };
}

let server: Server;
let origin: string;
const hosts: PluginHost[] = [];
const hostOf = (plugins: readonly InstalledPlugin[]): PluginHost => {
  const host = createPluginHost(plugins);
  hosts.push(host);
  return host;
};

beforeAll(async () => {
  server = createServer((_request, response) => response.end('Remote API'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await Promise.all(hosts.map((host) => host.dispose()));
  await new Promise((resolve) => server.close(resolve));
});

describe('a plugin host', () => {
  it('registers namespaced contributions behind the plugin’s own switch', () => {
    const host = hostOf([plugin()]);
    expect(host.features.map((feature) => [feature.id, feature.requires])).toEqual([['plugin:acme', ['plugins']]]);
    const registry = createBuiltinRegistry(undefined, host.contributions, host.features);
    expect(registry.extensions.reporters.map((entry) => entry.id)).toEqual(['json', 'acme/summary']);
    for (const switches of [{ 'plugin:acme': false }, { plugins: false }]) {
      const off = createBuiltinRegistry(switches, host.contributions, host.features).extensions;
      expect(off.reporters.map((entry) => entry.id)).toEqual(['json']);
      expect(() => off.reporter('acme/summary')).toThrow(expect.objectContaining({ code: 'feature-disabled' }));
    }
  });

  it('detects, and maps an import into REST APIs with secrets left out', async () => {
    const { importers } = hostOf([plugin()]).contributions;
    const found = await detectPluginFormat(importers ?? [], { filename: 'a.acme', text: 'ACME' });
    expect(found).toMatchObject({ kind: 'found', confidence: 'definite', importer: { id: 'acme/acme' } });
    expect(await detectPluginFormat(importers ?? [], { text: 'other' })).toEqual({ kind: 'none' });
    if (found.kind !== 'found' || found.importer.import === undefined) throw new Error('no importer');
    const mapped = mapPluginImport(
      await found.importer.import({ filename: 'a.acme', text: 'ACME' }),
      'Acme collection',
    );
    const api = mapped.collections[0]?.rest;
    expect(api?.name).toBe('Acme');
    expect(mapped.counts).toMatchObject({ requests: 2, folders: 1 });
    // As for an exported collection: the shared base becomes the API's, the request keeps its path.
    expect(api?.baseUrl).toBe('${baseUrl}');
    expect(api?.folders[0]?.requests[0]).toMatchObject({ name: 'List users', method: 'GET', url: '/users' });
    expect(api?.requests[0]).toMatchObject({ method: 'POST', body: { kind: 'raw', language: 'json' } });
    expect(mapped.variables.projectProperties?.variables).toEqual([
      { name: 'baseUrl', value: 'https://api.example.test', enabled: true, secret: false },
      { name: 'token', value: '', enabled: true, secret: true, awaitsValue: true },
    ]);
    expect(JSON.stringify(mapped)).not.toContain('hidden');
    expect(mapped.variables.report.warnings).toEqual([
      'Acme collection: 1 secret value was not imported; enter them again',
    ]);
  });

  it('refuses a result that is not an import', async () => {
    const bad = hostOf([plugin()]).contributions.importers?.find((entry) => entry.id === 'acme/bad');
    expect(await bad?.detect?.({ text: 'x' })).toBeNull();
    await expect(bad?.import?.({ text: 'x' })).rejects.toMatchObject({ code: 'plugin-error' });
  });

  it('gives an importer that lists an origin the brokered network, and one that does not none', async () => {
    const netted = hostOf([plugin({ capabilities: { network: [origin] } })]).contributions.importers?.[0];
    expect((await netted?.import?.({ text: `ACME ${origin}/x` }))?.apis[0]?.name).toBe('Remote API');
    const bare = hostOf([plugin()]).contributions.importers?.[0];
    expect((await bare?.import?.({ text: `ACME ${origin}/x` }))?.apis[0]?.name).toBe('Acme');
  });

  it('hands a reporter outcomes without exchanges', async () => {
    const reporter = hostOf([plugin()]).contributions.reporters?.[0];
    const result = {
      startedAt: '2026-10-23T10:00:00.000Z',
      summary: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0, durationMs: 5 },
      requests: [
        {
          path: 'a/b',
          group: 'a',
          name: 'Ping',
          protocol: 'rest',
          outcome: 'failed',
          unasserted: false,
          assertions: [],
          exchange: { request: 'GET / HTTP/1.1\r\nAuthorization: Bearer x', response: 'HTTP/1.1 500' },
        },
      ],
    } as unknown as RunResult;
    expect(await reporter?.render(result, { name: 'wirebench', version: '6.1.0' })).toBe('Ping failed false');
  });

  it('hands a code generator credentials only as environment reads', async () => {
    const generator = hostOf([plugin()]).contributions.codeGenerators?.[0];
    const request: CodeRequest = {
      method: 'GET',
      url: `https://api.example.test/${envMarker('TENANT')}`,
      headers: [
        { name: 'Authorization', value: 'Bearer literal-token' },
        { name: 'X-Key', value: envMarker('WIREBENCH_SECRET_KEY') },
      ],
      body: { kind: 'none' },
      followRedirects: true,
    };
    const generated = await generator?.generate(request, { indent: 4 });
    expect(generated?.code).not.toContain('literal-token');
    const seen = JSON.parse(generated?.code ?? '{}') as {
      request: { url: unknown; headers: unknown };
      layout: unknown;
    };
    expect(seen.request.url).toEqual([{ text: 'https://api.example.test/' }, { env: 'TENANT' }]);
    expect(seen.request.headers).toEqual([
      { name: 'Authorization', value: [{ env: 'WIREBENCH_HEADER_AUTHORIZATION' }] },
      { name: 'X-Key', value: [{ env: 'WIREBENCH_SECRET_KEY' }] },
    ]);
    expect(seen.layout).toEqual({ unit: '    ', followRedirects: true });
    expect(generated?.notes).toEqual([
      'header Authorization is read from WIREBENCH_HEADER_AUTHORIZATION.',
      'made by echo',
    ]);
  });
});
