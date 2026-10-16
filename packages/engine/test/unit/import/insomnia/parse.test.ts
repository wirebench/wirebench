import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InsomniaError } from '../../../../src/errors.js';
import type { InsNode } from '../../../../src/import/insomnia/index.js';
import { parseInsomnia } from '../../../../src/import/insomnia/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../../../../../fixtures/insomnia/crafted');

function fixture(name: string): string {
  return readFileSync(resolve(fixtureDir, name), 'utf8');
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof InsomniaError) return error.code;
    throw error;
  }
  return 'no error';
}

function names(nodes: readonly InsNode[]): string[] {
  return nodes.map((n) => n.name);
}

function v4(resources: unknown[]): string {
  return JSON.stringify({ _type: 'export', __export_format: 4, resources });
}

const ws = { _id: 'wrk_1', parentId: null, name: 'W', scope: 'collection', _type: 'workspace' };

describe('parseInsomnia v4', () => {
  it('v4 builds the tree from parentId', () => {
    for (const name of ['v4.json', 'v4.yaml']) {
      const doc = parseInsomnia(fixture(name));
      expect(doc.kind).toBe('collection');
      expect(doc.workspaces).toHaveLength(1);
      const [w] = doc.workspaces;
      expect(w?.name).toBe('Orders API');
      const folder = w?.items.find((n) => n.name === 'Orders');
      expect(folder?.kind).toBe('folder');
      if (folder?.kind !== 'folder') throw new Error('folder expected');
      expect(folder.headers).toEqual([{ name: 'X-Tenant', value: '{{ _.tenant }}', disabled: false }]);
      expect(folder.auth).toMatchObject({ type: 'bearer', token: '{{ _.token }}' });
      expect(folder.environment).toEqual({ tenant: 'acme' });
      expect(folder.scripts).toEqual({ pre: "console.log('folder pre-request');", post: '' });
      expect(folder.description).toBe('Everything under /orders');
      const create = folder.children.find((n) => n.name === 'Create order');
      expect(create).toMatchObject({
        kind: 'http',
        method: 'POST',
        url: '{{ _.baseUrl }}/orders',
        settings: { followRedirects: 'global', encodeUrl: true },
      });
      if (create?.kind !== 'http') throw new Error('http expected');
      expect(create.parameters.map((p) => [p.name, p.disabled])).toEqual([
        ['dryRun', true],
        ['expand', false],
      ]);
      expect(create.body['mimeType']).toBe('application/json');
      expect(create.scripts.pre).toContain('requestedAt');
      const upload = folder.children.find((n) => n.name === 'Upload attachment');
      if (upload?.kind !== 'http') throw new Error('http expected');
      expect(upload.settings.followRedirects).toBe('off');
      expect(upload.pathParameters).toEqual([{ name: 'id', value: '42', disabled: false }]);
      const grpc = folder.children.find((n) => n.kind === 'grpc');
      expect(grpc).toMatchObject({
        url: 'grpc.example.com:443',
        protoFileId: 'pf_7777777777777777777777777777aaaa',
        protoMethodName: '/orders.v1.Orders/GetOrder',
        message: '{"id": "42"}',
        reflection: false,
      });
      const socket = w?.items.find((n) => n.kind === 'websocket');
      expect(socket).toMatchObject({ url: 'wss://echo.example.com/ws', headers: [{ name: 'X-Token' }] });
      expect(socket?.kind === 'websocket' ? socket.payload : 'x').toBeTypeOf('string');
      expect(w?.protos.map((p) => p.id)).toEqual(['pf_7777777777777777777777777777aaaa']);
      expect(w?.extras).toContain('cookie jar');
    }
  });

  it('v4 splits two workspaces', () => {
    const doc = parseInsomnia(fixture('v4-two-workspaces.json'));
    expect(doc.workspaces.map((w) => w.name)).toEqual(['Orders API', 'Billing API']);
    const billing = doc.workspaces[1];
    expect(names(billing?.items ?? [])).toEqual(['Invoices']);
    const invoices = billing?.items[0];
    expect(invoices?.kind === 'folder' ? names(invoices.children) : []).toEqual(['List invoices']);
    expect(billing?.baseEnv?.data).toEqual({ baseUrl: 'https://billing.example.com' });
    // Nothing of the first workspace leaks into the second.
    expect(doc.workspaces[0]?.items.some((n) => n.name === 'Invoices')).toBe(false);
  });

  it('v4 private sub-environment is kept with private: true', () => {
    const [w] = parseInsomnia(fixture('v4.json')).workspaces;
    expect(w?.baseEnv).toMatchObject({ name: 'Base Environment', color: '#00aa88', private: false });
    expect(w?.baseEnv?.data).toMatchObject({ baseUrl: 'https://api.example.com', db: { host: 'localhost' } });
    expect(w?.baseEnv?.order).toMatchObject({ '&': ['baseUrl', 'tenant', 'db'] });
    expect(w?.subEnvs).toHaveLength(1);
    expect(w?.subEnvs[0]).toMatchObject({ name: 'Staging', private: true, color: '#ff8800' });
    expect(w?.subEnvs[0]?.data['__insomnia_vault']).toBeDefined();
  });

  it('v4 proto_file texts are kept with their directory', () => {
    const text = v4([
      ws,
      { _id: 'pd_1', parentId: 'wrk_1', name: 'protos', _type: 'proto_directory' },
      { _id: 'pf_1', parentId: 'pd_1', name: 'orders.proto', protoText: 'syntax = "proto3";', _type: 'proto_file' },
      { _id: 'pf_2', parentId: 'wrk_1', name: 'top.proto', protoText: 'syntax = "proto3";', _type: 'proto_file' },
    ]);
    const [w] = parseInsomnia(text).workspaces;
    expect(w?.protos).toEqual([
      { id: 'pf_1', name: 'orders.proto', text: 'syntax = "proto3";', dirId: 'pd_1', path: 'protos/orders.proto' },
      { id: 'pf_2', name: 'top.proto', text: 'syntax = "proto3";', path: 'top.proto' },
    ]);
  });

  it('an extra type key on a v4 resource is ignored', () => {
    const text = v4([
      { ...ws, type: 'Workspace' },
      {
        _id: 'req_1',
        parentId: 'wrk_1',
        type: 'Request',
        _type: 'request',
        name: 'One',
        url: 'https://x.example.com',
        method: 'GET',
        metaSortKey: 1,
      },
    ]);
    const [w] = parseInsomnia(text).workspaces;
    expect(w?.items).toMatchObject([{ kind: 'http', name: 'One' }]);
  });

  it('a v4 socket.io request is skipped and named', () => {
    const text = v4([
      ws,
      { _id: 'sio_1', parentId: 'wrk_1', _type: 'socketio_request', name: 'Live', url: 'https://x.example.com' },
    ]);
    const doc = parseInsomnia(text);
    expect(doc.workspaces[0]?.items).toEqual([{ kind: 'skipped', name: 'Live', what: 'Socket.IO request' }]);
    expect(doc.report.warnings.join('\n')).toContain('Live');
  });

  it('siblings sort by sortKey ascending, ties by id descending (folders and requests interleaved)', () => {
    const req = (id: string, name: string, key: number) => ({
      _id: id,
      parentId: 'wrk_1',
      _type: 'request',
      name,
      url: 'https://x.example.com',
      method: 'GET',
      metaSortKey: key,
    });
    const text = v4([
      ws,
      req('req_a', 'a-tie', 5),
      { _id: 'fld_z', parentId: 'wrk_1', _type: 'request_group', name: 'folder-first', metaSortKey: -10 },
      req('req_c', 'c-tie', 5),
      req('req_b', 'b-mid', 0.5),
      { _id: 'fld_y', parentId: 'wrk_1', _type: 'request_group', name: 'folder-tie', metaSortKey: 5 },
    ]);
    const [w] = parseInsomnia(text).workspaces;
    // key -10, then 0.5, then the three at 5 by id descending: req_c, req_a, fld_y
    expect(names(w?.items ?? [])).toEqual(['folder-first', 'b-mid', 'c-tie', 'a-tie', 'folder-tie']);
  });
});

describe('parseInsomnia v5', () => {
  it('v5 nests children', () => {
    const doc = parseInsomnia(fixture('v5-collection.yaml'));
    expect(doc.kind).toBe('collection');
    const [w] = doc.workspaces;
    expect(w?.name).toBe('Orders API');
    const folder = w?.items.find((n) => n.kind === 'folder');
    expect(folder?.kind === 'folder' ? names(folder.children) : []).toEqual([
      // sortKey: -...6 (gRPC) < -...5 < -...4 < -...3 < -...2 (ascending)
      'GetOrder (gRPC)',
      'Latest order (chained)',
      'Order by id (GraphQL)',
      'Upload attachment',
      'Create order',
    ]);
    if (folder?.kind !== 'folder') throw new Error('folder expected');
    expect(folder.description).toBe('Everything under /orders');
    expect(folder.scripts.pre).toContain('folder pre-request');
    const create = folder.children.find((n) => n.name === 'Create order');
    if (create?.kind !== 'http') throw new Error('http expected');
    expect(create.scripts.pre).toContain('requestedAt');
    expect(create.scripts.post).toContain('insomnia.test');
    expect(create.description).toBe('Creates an order');
    expect(create.settings).toMatchObject({ followRedirects: 'global', encodeUrl: true });
    expect(create.headers.map((h) => [h.name, h.disabled])).toEqual([
      ['Content-Type', false],
      ['X-Debug', true],
    ]);
    const upload = folder.children.find((n) => n.name === 'Upload attachment');
    if (upload?.kind !== 'http') throw new Error('http expected');
    expect(upload.body['params']).toHaveLength(2);
    expect(upload.parameters).toEqual([]);
    expect(upload.settings.other).toContain('storeCookies');
  });

  it('v5 discriminates folder, http, grpc, websocket', () => {
    const [w] = parseInsomnia(fixture('v5-collection.yaml')).workspaces;
    expect(w?.items.map((n) => n.kind).sort()).toEqual(['folder', 'websocket']);
    const folder = w?.items.find((n) => n.kind === 'folder');
    const kinds = folder?.kind === 'folder' ? folder.children.map((n) => n.kind).sort() : [];
    expect(kinds).toEqual(['grpc', 'http', 'http', 'http', 'http']);
    const grpc = folder?.kind === 'folder' ? folder.children.find((n) => n.kind === 'grpc') : undefined;
    expect(grpc).toMatchObject({
      url: 'grpc.example.com:443',
      protoMethodName: '/orders.v1.Orders/GetOrder',
      message: '{"id": "42"}',
      reflection: false,
      metadata: [{ name: 'authorization', disabled: false }],
    });
    const socket = w?.items.find((n) => n.kind === 'websocket');
    expect(socket).toMatchObject({
      url: 'wss://echo.example.com/ws',
      headers: [{ name: 'X-Token', value: '{{ _.token }}' }],
    });
    expect(socket?.kind === 'websocket' ? socket.payload : 'x').toBeUndefined();
  });

  it('a socket.io item is skipped and named', () => {
    const text = [
      'type: collection.insomnia.rest/5.0',
      'name: S',
      'collection:',
      '  - name: Live feed',
      '    url: https://x.example.com',
      '    meta: {id: socketio-req_1, sortKey: 1}',
      '    eventListeners: [{id: e1, eventName: tick, desc: "", isOpen: true}]',
      '  - name: By id only',
      '    url: https://x.example.com',
      '    meta: {id: socketio-req_2, sortKey: 2}',
      '',
    ].join('\n');
    const doc = parseInsomnia(text);
    expect(doc.workspaces[0]?.items).toEqual([
      { kind: 'skipped', name: 'Live feed', what: 'Socket.IO request' },
      { kind: 'skipped', name: 'By id only', what: 'Socket.IO request' },
    ]);
    expect(doc.report.warnings.join('\n')).toContain('Live feed');
  });

  it('siblings sort by sortKey ascending, ties by id descending in v5 too', () => {
    const text = [
      'type: collection.insomnia.rest/5.0',
      'name: S',
      'collection:',
      '  - {name: tie-a, method: GET, url: u, meta: {id: req_a, sortKey: 1}}',
      '  - {name: first, method: GET, url: u, meta: {id: req_z, sortKey: -5}}',
      '  - {name: tie-folder, meta: {id: fld_b, sortKey: 1}, children: []}',
      '  - {name: tie-c, method: GET, url: u, meta: {id: req_c, sortKey: 1}}',
      '',
    ].join('\n');
    const [w] = parseInsomnia(text).workspaces;
    expect(names(w?.items ?? [])).toEqual(['first', 'tie-c', 'tie-a', 'tie-folder']);
  });

  it('spec kind reads as a collection and reports its embedded spec', () => {
    const doc = parseInsomnia(fixture('v5-spec.yaml'));
    expect(doc.kind).toBe('collection');
    expect(names(doc.workspaces[0]?.items ?? [])).toEqual(['List pets']);
    expect(doc.workspaces[0]?.extras).toContain('API spec');
    expect(doc.report.warnings.join('\n')).toMatch(/OpenAPI/);
  });

  it('v5 environment file reads base and subs', () => {
    const doc = parseInsomnia(fixture('v5-environment.yaml'));
    expect(doc.kind).toBe('environment');
    const [w] = doc.workspaces;
    expect(w?.name).toBe('Shared environments');
    expect(w?.items).toEqual([]);
    expect(w?.baseEnv).toMatchObject({ name: 'Base Environment', color: '#00aa88', private: false });
    expect(w?.baseEnv?.data).toMatchObject({ baseUrl: 'https://api.example.com' });
    expect(w?.subEnvs.map((e) => [e.name, e.private])).toEqual([['Staging', true]]);
  });

  it('v5 schema 5.0 rows with empty names are dropped', () => {
    const text = [
      'type: collection.insomnia.rest/5.0',
      'name: S',
      'collection:',
      '  - name: r',
      '    url: u',
      '    method: GET',
      '    headers:',
      '      - {id: h1, name: "", value: ""}',
      '      - {id: h2, name: X-A, value: "1"}',
      '    parameters:',
      '      - {id: p1, name: "", value: ""}',
      '    body:',
      '      mimeType: application/x-www-form-urlencoded',
      '      params:',
      '        - {id: b1, name: "", value: ""}',
      '        - {id: b2, name: k, value: v}',
      '',
    ].join('\n');
    const item = parseInsomnia(text).workspaces[0]?.items[0];
    if (item?.kind !== 'http') throw new Error('http expected');
    expect(item.headers).toEqual([{ name: 'X-A', value: '1', disabled: false }]);
    expect(item.parameters).toEqual([]);
    expect(item.body['params']).toEqual([{ id: 'b2', name: 'k', value: 'v' }]);
  });
});

describe('parseInsomnia errors', () => {
  it('insomnia-malformed for text that is not an export', () => {
    expect(codeOf(() => parseInsomnia('a: [unclosed'))).toBe('insomnia-malformed');
    expect(codeOf(() => parseInsomnia('- just\n- a list\n'))).toBe('insomnia-malformed');
    expect(codeOf(() => parseInsomnia('hello: world\n'))).toBe('insomnia-malformed');
    expect(codeOf(() => parseInsomnia('{"__export_format": 4}'))).toBe('insomnia-malformed');
  });

  it('insomnia-malformed for an alias bomb', () => {
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x]'];
    for (let i = 0; i < 150; i += 1) lines.push(`b${i}: *a`);
    expect(codeOf(() => parseInsomnia(lines.join('\n')))).toBe('insomnia-malformed');
  });

  it('insomnia-too-large past 50 MB', () => {
    const big = 'x'.repeat(50 * 1024 * 1024 + 1);
    expect(codeOf(() => parseInsomnia(big))).toBe('insomnia-too-large');
  });

  it('insomnia-old-format for __export_format 1 to 3', () => {
    for (const n of [1, 2, 3]) {
      try {
        parseInsomnia(JSON.stringify({ _type: 'export', __export_format: n, resources: [] }));
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(InsomniaError);
        expect((error as InsomniaError).code).toBe('insomnia-old-format');
        expect((error as InsomniaError).message).toMatch(/re-export/i);
      }
    }
  });

  it('insomnia-not-collection for a mock or an MCP file, naming the kind', () => {
    for (const [type, word] of [
      ['mock.insomnia.rest/5.0', /mock/i],
      ['mcpClient.insomnia/5.0', /MCP/],
    ] as const) {
      try {
        parseInsomnia(`type: ${type}\nname: M\n`);
        expect.unreachable();
      } catch (error) {
        expect((error as InsomniaError).code).toBe('insomnia-not-collection');
        expect((error as InsomniaError).message).toMatch(word);
      }
    }
  });
});

describe('parseInsomnia bounds and v4 workspace kinds', () => {
  it('v4 folders without an id are kept empty and finish fast', () => {
    const nested = (n: number): unknown[] =>
      Array.from({ length: n }, () => ({ parentId: 'wrk_1', _type: 'request_group', name: 'f' }));
    const started = Date.now();
    const doc = parseInsomnia(v4([ws, ...nested(5)]));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(doc.workspaces[0]?.items).toHaveLength(5);
    expect(doc.report.warnings.join('\n')).toContain('no id');
  }, 5000);

  it('a v5 alias cycle is refused as malformed', () => {
    const text = [
      'type: collection.insomnia.rest/5.0',
      'name: S',
      'collection: &c',
      '  - {name: a, meta: {id: fld_a}, children: *c}',
      '  - {name: b, meta: {id: fld_b}, children: *c}',
      '',
    ].join('\n');
    expect(codeOf(() => parseInsomnia(text))).toBe('insomnia-malformed');
  }, 5000);

  it('a budget overrun is refused as malformed', () => {
    const items = Array.from({ length: 100_001 }, (_, i) => ({
      name: `r${i}`,
      method: 'GET',
      url: 'u',
      meta: { id: `req_${i}` },
    }));
    const text = JSON.stringify({ type: 'collection.insomnia.rest/5.0', name: 'S', collection: items });
    try {
      parseInsomnia(text);
      expect.unreachable();
    } catch (error) {
      expect((error as InsomniaError).code).toBe('insomnia-malformed');
      expect((error as InsomniaError).message).toContain('100000');
    }
  }, 10000);

  it('a v4 mock-server workspace beside a collection is skipped with a warning', () => {
    const doc = parseInsomnia(
      v4([ws, { _id: 'wrk_2', parentId: null, name: 'Mocks', scope: 'mock-server', _type: 'workspace' }]),
    );
    expect(doc.workspaces.map((w) => w.name)).toEqual(['W']);
    expect(doc.report.warnings.join('\n')).toContain('Mocks');
  });

  it('a v4 file with only mock or MCP workspaces is not a collection', () => {
    for (const scope of ['mock-server', 'mcp']) {
      const text = v4([{ _id: 'wrk_2', parentId: null, name: 'M', scope, _type: 'workspace' }]);
      expect(codeOf(() => parseInsomnia(text))).toBe('insomnia-not-collection');
    }
  });

  it('legacy base-environment sub-environments go to the first workspace only', () => {
    const second = { _id: 'wrk_2', parentId: null, name: 'W2', scope: 'collection', _type: 'workspace' };
    const sub = { _id: 'env_s', parentId: '__BASE_ENVIRONMENT_ID__', name: 'Legacy', data: {}, _type: 'environment' };
    const doc = parseInsomnia(v4([ws, second, sub]));
    expect(doc.workspaces.map((w) => w.subEnvs.length)).toEqual([1, 0]);
  });
});
