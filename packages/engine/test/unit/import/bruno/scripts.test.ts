import { describe, expect, it } from 'vitest';
import { ocOfBrunoFolder } from '../../../../src/import/bruno/convert.js';
import { mapBruno } from '../../../../src/import/bruno/import.js';
import { apiFolders, apiRequests } from '../../../../src/rest/model.js';

/** A Bruno folder from `bruno.json` and the given files, mapped with numbered ids. */
function mapFolder(config: Record<string, unknown>, files: Record<string, string>) {
  let n = 0;
  const { collection, report } = ocOfBrunoFolder(
    new Map([['bruno.json', JSON.stringify({ name: 'c', ...config })], ...Object.entries(files)]),
    'c',
  );
  return mapBruno(collection, report, { newId: () => `id${String((n += 1))}` });
}

const request = (blocks: string): string =>
  `meta {\n  name: Ping\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://a.example.com/x\n}\n\n${blocks}`;

describe('Bruno scripts are attached', () => {
  it("a request's pre and post scripts attach with api bruno, enabled false", () => {
    const mapped = mapFolder(
      {},
      {
        'ping.bru': request(
          'script:pre-request {\n  bru.setVar("a", 1);\n}\n\nscript:post-response {\n  bru.setVar("b", 2);\n}\n',
        ),
      },
    );
    const [ping] = apiRequests(mapped.collections[0]!.rest!);
    expect(ping!.scripts).toEqual({
      pre: { text: 'bru.setVar("a", 1);\n' },
      post: { text: 'bru.setVar("b", 2);\n' },
      api: 'bruno',
      enabled: false,
      secrets: [],
    });
  });

  it('post-response and tests join, tests second', () => {
    const mapped = mapFolder(
      {},
      {
        'ping.bru': request(
          'tests {\n  test("ok", () => {});\n}\n\nscript:post-response {\n  bru.setVar("b", 2);\n}\n',
        ),
      },
    );
    const [ping] = apiRequests(mapped.collections[0]!.rest!);
    expect(ping!.scripts?.post?.text).toBe('bru.setVar("b", 2);\n\ntest("ok", () => {});\n');
  });

  it("a folder's and the collection's scripts attach at their own level", () => {
    const mapped = mapFolder(
      {},
      {
        'collection.bru': 'script:pre-request {\n  bru.setVar("root", 1);\n}\n',
        'orders/folder.bru': 'meta {\n  name: Orders\n}\n\nscript:pre-request {\n  bru.setVar("dir", 1);\n}\n',
        'orders/ping.bru': request(''),
      },
    );
    const api = mapped.collections[0]!.rest!;
    expect(api.scripts).toMatchObject({ pre: { text: 'bru.setVar("root", 1);\n' }, api: 'bruno', enabled: false });
    expect(apiFolders(api)[0]!.scripts).toMatchObject({ pre: { text: 'bru.setVar("dir", 1);\n' }, enabled: false });
    expect(apiRequests(api)[0]!.scripts).toBeUndefined();
  });

  it('a sandwich collection sets postResponseOrder inner-first', () => {
    const mapped = mapFolder(
      { scripts: { flow: 'sandwich' } },
      { 'ping.bru': request('script:post-response {\n  bru.setVar("b", 2);\n}\n') },
    );
    expect(mapped.collections[0]!.rest!.scripts).toEqual({
      api: 'bruno',
      enabled: false,
      secrets: [],
      postResponseOrder: 'inner-first',
    });
  });

  it('no flow at all runs inner-first too, and keeps the collection script it has', () => {
    const mapped = mapFolder(
      {},
      {
        'collection.bru': 'script:post-response {\n  bru.setVar("root", 1);\n}\n',
        'ping.bru': request(''),
      },
    );
    expect(mapped.collections[0]!.rest!.scripts).toMatchObject({
      post: { text: 'bru.setVar("root", 1);\n' },
      postResponseOrder: 'inner-first',
    });
  });

  it('sequential sets outer-first', () => {
    const mapped = mapFolder(
      { scripts: { flow: 'sequential' } },
      { 'ping.bru': request('script:post-response {\n  bru.setVar("b", 2);\n}\n') },
    );
    expect(mapped.collections[0]!.rest!.scripts?.postResponseOrder).toBe('outer-first');
  });

  it('a collection with no script stores no order', () => {
    const mapped = mapFolder({ scripts: { flow: 'sandwich' } }, { 'ping.bru': request('') });
    expect(mapped.collections[0]!.rest!.scripts).toBeUndefined();
  });

  it('a module helper is still saved under imported-scripts', () => {
    const mapped = mapFolder(
      {},
      {
        'ping.bru': request('script:pre-request {\n  const lib = require("./lib.js");\n}\n'),
        'lib.js': 'module.exports = {};\n',
      },
    );
    expect(mapped.scripts).toEqual([{ path: 'imported-scripts/c/lib.js.module.js', source: 'module.exports = {};\n' }]);
  });

  it('no other script file is written', () => {
    const mapped = mapFolder(
      {},
      {
        'collection.bru': 'script:pre-request {\n  bru.setVar("root", 1);\n}\n',
        'orders/folder.bru': 'meta {\n  name: Orders\n}\n\ntests {\n  test("ok", () => {});\n}\n',
        'orders/ping.bru': request('script:pre-request {\n  bru.setVar("a", 1);\n}\n'),
      },
    );
    expect(mapped.scripts).toEqual([]);
    expect(mapped.counts.scripts).toBe(0);
  });

  it('reports where scripts were switched off and the calls Wirebench does not run', () => {
    const mapped = mapFolder(
      {},
      {
        'collection.bru': 'script:pre-request {\n  bru.setVar("root", 1);\n}\n',
        'ping.bru': request('script:pre-request {\n  await bru.sendRequest({});\n  bru.setNextRequest("Other");\n}\n'),
      },
    );
    const warnings = mapped.report.warnings;
    expect(warnings).toContain(
      'Scripts on the API and 1 request were imported switched off: read each on its Scripts tab, then switch them on',
    );
    expect(warnings).toContain(
      'The scripts of "Ping" call bru.sendRequest, which a script cannot do: send that request as a sequence step, or use OAuth2 auth for a token',
    );
    expect(warnings).toContain(
      'The scripts of "Ping" steer the run (bru.setNextRequest): obeyed in API and folder runs only',
    );
    expect(mapped.report.notes.some((note) => note.includes('is never run'))).toBe(false);
  });

  it('warns about the scripts of a gRPC request, which has no script slot', () => {
    const mapped = mapFolder(
      {},
      {
        'ping.bru': request(''),
        'rpc.bru':
          'meta {\n  name: Rpc\n  type: grpc\n  seq: 2\n}\n\ngrpc {\n  url: grpc://h:1\n  method: /a.B/C\n  body: grpc\n}\n\nscript:pre-request {\n  bru.setVar("a", 1);\n}\n',
      },
    );
    expect(mapped.report.warnings).toContain(
      'Rpc: its scripts were not imported; only HTTP and GraphQL requests keep scripts.',
    );
  });
});
