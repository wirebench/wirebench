import { describe, expect, it } from 'vitest';
import { InsomniaError } from '#core/errors';
import type { InsFolder, InsHttp, InsNode } from '../../../../src/import/insomnia/model.js';
import { parseInsomnia } from '../../../../src/import/insomnia/parse.js';
import { insomniaFixture } from './fixtures.js';

const names = (nodes: readonly InsNode[]): string[] => nodes.map((node) => node.name);
const folder = (nodes: readonly InsNode[], name: string): InsFolder => {
  const found = nodes.find((node) => node.name === name);
  if (found?.kind !== 'folder') throw new Error(`no folder ${name}`);
  return found;
};

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InsomniaError);
    return (error as InsomniaError).code;
  }
  return undefined;
}

describe('parseInsomnia: v4', () => {
  it('builds the tree from parentId', () => {
    const doc = parseInsomnia(insomniaFixture('v4.json'));
    expect(doc).toMatchObject({ format: 4, kind: 'collection' });
    const [workspace] = doc.workspaces;
    expect(workspace?.name).toBe('Orders API');
    // Sort keys are negative creation times, so the newest item comes first, as in Insomnia.
    expect(names(workspace!.items)).toEqual(['Live feed', 'Echo (WebSocket)', 'Orders']);
    expect(names(folder(workspace!.items, 'Orders').children)).toEqual([
      'GetOrder (gRPC)',
      'Latest order (chained)',
      'Order by id (GraphQL)',
      'Upload attachment',
      'Create order',
    ]);
  });

  it('reads the YAML form the same as the JSON one', () => {
    expect(parseInsomnia(insomniaFixture('v4.yaml'))).toEqual(parseInsomnia(insomniaFixture('v4.json')));
  });

  it('splits two workspaces', () => {
    const doc = parseInsomnia(insomniaFixture('v4-two-workspaces.json'));
    expect(doc.workspaces.map((w) => w.name)).toEqual(['Billing', 'Shipping']);
    expect(names(doc.workspaces[0]!.items)).toEqual(['List invoices']);
    expect(names(folder(doc.workspaces[1]!.items, 'Parcels').children)).toEqual(['Track parcel']);
    expect(doc.workspaces[0]!.baseEnv).toBeUndefined();
    expect(doc.workspaces[1]!.baseEnv?.data).toEqual({ region: 'eu' });
  });

  it('keeps a private sub-environment with private: true and its vault names', () => {
    const [workspace] = parseInsomnia(insomniaFixture('v4.json')).workspaces;
    expect(workspace?.baseEnv).toMatchObject({ name: 'Base Environment', private: false, color: '#00aa88' });
    expect(workspace?.subEnvs).toEqual([
      expect.objectContaining({
        name: 'Staging',
        private: true,
        data: { baseUrl: 'https://staging.example.com' },
        vault: ['svcPassword'],
      }),
    ]);
  });

  it('keeps proto_file texts with their directory', () => {
    const [workspace] = parseInsomnia(insomniaFixture('v4.json')).workspaces;
    expect(workspace?.protoDirs).toEqual([{ id: 'pd_7777777777777777777777777777aaaa', name: 'protos' }]);
    expect(workspace?.protos).toEqual([
      expect.objectContaining({ name: 'orders.proto', dirId: 'pd_7777777777777777777777777777aaaa' }),
    ]);
    expect(workspace?.protos[0]?.text).toContain('service Orders');
  });

  it('reads the WebSocket payload, the test suites and the cookie jar', () => {
    const [workspace] = parseInsomnia(insomniaFixture('v4.json')).workspaces;
    expect(workspace?.items.find((n) => n.kind === 'websocket')).toMatchObject({
      payload: { text: '{"hello":"world"}', mode: 'application/json' },
    });
    expect(workspace?.testSuites).toEqual([
      { name: 'Smoke', tests: [{ name: 'creates an order', requestId: 'req_2222222222222222222222222222aaaa' }] },
    ]);
    expect(workspace?.cookies).toBe(1);
  });

  it('ignores an extra type key on a resource', () => {
    const orders = folder(parseInsomnia(insomniaFixture('v4.json')).workspaces[0]!.items, 'Orders');
    expect(orders.children.find((n) => n.name === 'Latest order (chained)')?.kind).toBe('http');
  });

  it('reads the flat settings and the inherit rule for auth', () => {
    const orders = folder(parseInsomnia(insomniaFixture('v4.json')).workspaces[0]!.items, 'Orders');
    const upload = orders.children.find((n) => n.name === 'Upload attachment') as InsHttp;
    expect(upload.settings).toEqual({ followRedirects: 'off', encodeUrl: true, other: ['store-cookies-off'] });
    expect(upload.auth).toBeUndefined();
    expect(orders.auth).toMatchObject({ type: 'bearer' });
  });

  it('hangs resources with no workspace above them from one shared workspace', () => {
    const doc = parseInsomnia(
      JSON.stringify({
        __export_format: 4,
        resources: [{ _id: 'req_1', parentId: '__WORKSPACE_ID__', _type: 'request', name: 'Lone', url: 'https://a' }],
      }),
    );
    expect(doc.workspaces).toHaveLength(1);
    expect(names(doc.workspaces[0]!.items)).toEqual(['Lone']);
  });

  it('sorts siblings by sort key ascending, ties by id descending, folders and requests interleaved', () => {
    const doc = parseInsomnia(
      JSON.stringify({
        __export_format: 4,
        resources: [
          { _id: 'wrk_1', _type: 'workspace', name: 'W' },
          { _id: 'req_a', parentId: 'wrk_1', _type: 'request', name: 'A', metaSortKey: 5 },
          { _id: 'fld_b', parentId: 'wrk_1', _type: 'request_group', name: 'B', metaSortKey: 1 },
          { _id: 'req_c', parentId: 'wrk_1', _type: 'request', name: 'C', metaSortKey: 5 },
          { _id: 'req_d', parentId: 'wrk_1', _type: 'request', name: 'D', metaSortKey: -3 },
        ],
      }),
    );
    expect(names(doc.workspaces[0]!.items)).toEqual(['D', 'B', 'C', 'A']);
  });
});

describe('parseInsomnia: v5', () => {
  it('nests children and tells folder, http, grpc and websocket apart', () => {
    const doc = parseInsomnia(insomniaFixture('v5-collection.yaml'));
    expect(doc).toMatchObject({ format: 5, kind: 'collection' });
    const items = doc.workspaces[0]!.items;
    expect(items.map((n) => n.kind)).toEqual(['websocket', 'folder']);
    const orders = folder(items, 'Orders');
    expect(orders.children.map((n) => n.kind)).toEqual(['grpc', 'http', 'http', 'http', 'http']);
    expect(orders.scripts.pre).toContain('folder pre-request');
    expect(orders.environment).toEqual({ tenant: 'acme' });
    expect(orders.description).toBe('Everything under /orders');
  });

  it('reads the settings object and the scripts', () => {
    const orders = folder(parseInsomnia(insomniaFixture('v5-collection.yaml')).workspaces[0]!.items, 'Orders');
    const create = orders.children.find((n) => n.name === 'Create order') as InsHttp;
    expect(create.scripts.post).toContain('insomnia.test');
    expect(create.parameters).toEqual([
      { name: 'dryRun', value: 'true', disabled: true },
      { name: 'expand', value: 'items', disabled: false },
    ]);
    const upload = orders.children.find((n) => n.name === 'Upload attachment') as InsHttp;
    expect(upload.settings.followRedirects).toBe('off');
    expect(upload.body.params?.[1]).toMatchObject({ type: 'file', fileName: '/Users/dev/invoice.pdf' });
  });

  it('reads base and sub environments with the vault taken out', () => {
    const [workspace] = parseInsomnia(insomniaFixture('v5-collection.yaml')).workspaces;
    expect(workspace?.baseEnv?.data).toEqual({
      baseUrl: 'https://api.example.com',
      tenant: 'base',
      db: { host: 'localhost', port: 5432 },
    });
    expect(workspace?.baseEnv?.order).toBeDefined();
    expect(workspace?.subEnvs[0]).toMatchObject({ name: 'Staging', private: true, vault: ['svcPassword'] });
    expect(workspace?.cookies).toBe(1);
  });

  it('skips a Socket.IO item and keeps its name', () => {
    const doc = parseInsomnia(
      'type: collection.insomnia.rest/5.0\nname: W\ncollection:\n  - url: https://io\n    name: Feed\n    meta: {id: socketio-req_1}\n    eventListeners: []\n',
    );
    expect(doc.workspaces[0]!.items).toEqual([
      { kind: 'skipped', id: 'socketio-req_1', name: 'Feed', what: 'Socket.IO request' },
    ]);
  });

  it('reads a spec kind as a collection and flags its embedded spec and suites', () => {
    const doc = parseInsomnia(insomniaFixture('v5-spec.yaml'));
    expect(doc.kind).toBe('collection');
    expect(doc.workspaces[0]).toMatchObject({ spec: true, testSuites: [{ name: 'Pets suite' }] });
    expect(names(doc.workspaces[0]!.items)).toEqual(['List pets']);
  });

  it('reads an environment file with its subs in sort order', () => {
    const doc = parseInsomnia(insomniaFixture('v5-environment.yaml'));
    expect(doc.kind).toBe('environment');
    expect(doc.workspaces[0]!.baseEnv?.data).toEqual({ region: 'eu-west-1', retries: 3 });
    expect(doc.workspaces[0]!.subEnvs.map((e) => e.name)).toEqual(['Development', 'Production']);
  });

  it('drops schema 5.0 rows with empty names', () => {
    const doc = parseInsomnia(
      'type: collection.insomnia.rest/5.0\nname: W\ncollection:\n  - name: R\n    method: GET\n    url: https://a\n    headers:\n      - {id: pair_1, name: "", value: ""}\n      - {id: pair_2, name: X, value: "1"}\n',
    );
    expect((doc.workspaces[0]!.items[0] as InsHttp).headers).toEqual([{ name: 'X', value: '1', disabled: false }]);
  });

  it('is told by its type value, not by the text starting with it', () => {
    const doc = parseInsomnia('# exported\nname: W\ntype: collection.insomnia.rest/5.0\ncollection: []\n');
    expect(doc.format).toBe(5);
  });
});

describe('parseInsomnia: refusals', () => {
  it('refuses text that is not JSON or YAML', () => {
    expect(codeOf(() => parseInsomnia('{ "a": '))).toBe('insomnia-malformed');
  });

  it('refuses a document that is not an Insomnia export', () => {
    expect(codeOf(() => parseInsomnia('{"info": {}, "item": []}'))).toBe('insomnia-malformed');
    expect(codeOf(() => parseInsomnia('[1, 2]'))).toBe('insomnia-malformed');
  });

  it('refuses a file past 50 MB', () => {
    expect(codeOf(() => parseInsomnia(' '.repeat(50 * 1024 * 1024 + 1)))).toBe('insomnia-too-large');
  });

  it('refuses formats 1 to 3 and asks for a re-export', () => {
    for (const format of [1, 2, 3]) {
      expect(codeOf(() => parseInsomnia(JSON.stringify({ __export_format: format, resources: [] })))).toBe(
        'insomnia-old-format',
      );
    }
    expect(() => parseInsomnia('{"__export_format": 3}')).toThrow(/current Insomnia/);
  });

  it('refuses a mock server or MCP client file, naming it', () => {
    expect(codeOf(() => parseInsomnia('type: mock.insomnia.rest/5.0\nname: M\n'))).toBe('insomnia-not-collection');
    expect(() => parseInsomnia('type: mcpClient.insomnia/5.0\nname: M\n')).toThrow(/an MCP client/);
  });
});

describe('parseInsomnia: hostile exports and v4 workspace kinds', () => {
  const ws = { _id: 'wrk_1', parentId: null, name: 'W', scope: 'collection', _type: 'workspace' };
  const v4 = (resources: unknown[]): string => JSON.stringify({ _type: 'export', __export_format: 4, resources });

  it('keeps a v4 folder with no id empty, with a warning, and finishes fast', () => {
    const idless = Array.from({ length: 5 }, () => ({ parentId: 'wrk_1', _type: 'request_group', name: 'f' }));
    const started = Date.now();
    const doc = parseInsomnia(v4([ws, ...idless]));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(doc.workspaces[0]?.items).toHaveLength(5);
    expect(doc.workspaces[0]?.items.every((n) => n.kind === 'folder' && n.children.length === 0)).toBe(true);
    expect(doc.report.warnings.join('\n')).toContain('has no id; its contents were skipped');
  }, 5000);

  it('does not recurse into parentless v4 folders with no id', () => {
    const idless = Array.from({ length: 2 }, () => ({ _type: 'request_group', name: 'f' }));
    const started = Date.now();
    const doc = parseInsomnia(v4([ws, ...idless]));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(doc.report.warnings.join('\n')).toContain('has no id');
  }, 5000);

  it('does not let a v4 folder with no id adopt resources that have no parent', () => {
    const doc = parseInsomnia(
      v4([
        ws,
        { _type: 'request_group', parentId: 'wrk_1', name: 'f' },
        { _id: 'req_x', _type: 'request', name: 'orphan', url: 'u', method: 'GET' },
      ]),
    );
    const f = folder(doc.workspaces[0]!.items, 'f');
    expect(f.children).toEqual([]);
  });

  it('refuses a v5 YAML alias loop as malformed', () => {
    const source = [
      'type: collection.insomnia.rest/5.0',
      'name: S',
      'collection: &c',
      '  - {name: a, meta: {id: fld_a}, children: *c}',
      '  - {name: b, meta: {id: fld_b}, children: *c}',
      '',
    ].join('\n');
    expect(codeOf(() => parseInsomnia(source))).toBe('insomnia-malformed');
  }, 10000);

  it('refuses an export past 100000 items as malformed, naming the limit', () => {
    const items = Array.from({ length: 100_001 }, (_, i) => ({
      name: `r${i}`,
      method: 'GET',
      url: 'u',
      meta: { id: `req_${i}` },
    }));
    const source = JSON.stringify({ type: 'collection.insomnia.rest/5.0', name: 'S', collection: items });
    expect(codeOf(() => parseInsomnia(source))).toBe('insomnia-malformed');
    expect(() => parseInsomnia(source)).toThrow(/100000/);
  }, 20000);

  it('spends the same budget on v4 items', () => {
    const items = Array.from({ length: 100_001 }, (_, i) => ({
      _id: `req_${i}`,
      parentId: 'wrk_1',
      _type: 'request',
      name: `r${i}`,
      url: 'u',
      method: 'GET',
    }));
    expect(() => parseInsomnia(v4([ws, ...items]))).toThrow(/100000/);
  }, 20000);

  it('reads valid JSON with the JSON parser, so a repeated key does not fail it', () => {
    const source = `{"__export_format": 4, "resources": [], "resources": [${JSON.stringify(ws)}]}`;
    expect(parseInsomnia(source).workspaces.map((w) => w.name)).toEqual(['W']);
  });

  it('gives legacy base-environment sub-environments to the first workspace only', () => {
    const second = { _id: 'wrk_2', parentId: null, name: 'W2', scope: 'collection', _type: 'workspace' };
    const sub = { _id: 'env_s', parentId: '__BASE_ENVIRONMENT_ID__', name: 'Legacy', data: {}, _type: 'environment' };
    const doc = parseInsomnia(v4([ws, second, sub]));
    expect(doc.workspaces.map((w) => `${w.name}:${w.subEnvs.map((e) => e.name).join(',')}`)).toEqual([
      'W:Legacy',
      'W2:',
    ]);
  });

  it('skips a v4 mock-server workspace beside a collection, with a warning', () => {
    const doc = parseInsomnia(
      v4([ws, { _id: 'wrk_2', parentId: null, name: 'Mocks', scope: 'mock-server', _type: 'workspace' }]),
    );
    expect(doc.workspaces.map((w) => w.name)).toEqual(['W']);
    expect(doc.report.warnings.join('\n')).toContain('"Mocks" is a mock server and was skipped');
  });

  it('refuses a v4 file holding only mock-server or MCP workspaces as not a collection', () => {
    for (const scope of ['mock-server', 'mcp']) {
      const source = v4([{ _id: 'wrk_2', parentId: null, name: 'M', scope, _type: 'workspace' }]);
      expect(codeOf(() => parseInsomnia(source))).toBe('insomnia-not-collection');
    }
  });
});
