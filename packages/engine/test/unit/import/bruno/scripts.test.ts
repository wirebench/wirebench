import { describe, expect, it } from 'vitest';
import { ocOfBrunoFolder } from '../../../../src/import/bruno/convert.js';
import { mapBruno } from '../../../../src/import/bruno/import.js';
import { ocOfBrunoExport } from '../../../../src/import/bruno/json-export.js';
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

  it('scans the calls the layer refuses, and gives bru.runRequest the send advice', () => {
    const mapped = mapFolder(
      {},
      {
        'ping.bru': request(
          'script:pre-request {\n  await bru.runRequest("Auth/Login");\n  bru.getProcessEnv("HOME");\n  bru.visualize("table", {});\n  bru.deleteAllVars();\n  req.getAuthMode();\n  req.setHeaders({});\n}\n',
        ),
      },
    );
    const warnings = mapped.report.warnings;
    expect(warnings).toContain(
      'The scripts of "Ping" call bru.runRequest, which a script cannot do: send that request as a sequence step, or use OAuth2 auth for a token',
    );
    expect(warnings).toContain(
      'The scripts of "Ping" call what Wirebench does not run: bru.deleteAllVars, bru.getProcessEnv, bru.visualize, req.getAuthMode, req.setHeaders',
    );
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
      'Scripts on the API and 1 request were imported switched off: read each on its Scripts tab, then switch them on.',
    );
    expect(warnings).toContain(
      'The scripts of "Ping" call bru.sendRequest, which a script cannot do: send that request as a sequence step, or use OAuth2 auth for a token',
    );
    expect(warnings).toContain(
      'The scripts of "Ping" steer the run (bru.setNextRequest): obeyed in API and folder runs only',
    );
    expect(mapped.report.notes.some((note) => note.includes('is never run'))).toBe(false);
  });

  it('attaches gRPC item, folder and collection scripts to the gRPC API', () => {
    const mapped = mapFolder(
      {},
      {
        'collection.bru': 'script:pre-request {\n  bru.setVar("root", 1);\n}\n',
        'rpc/folder.bru': 'meta {\n  name: Rpc\n}\n\nscript:pre-request {\n  bru.setVar("dir", 1);\n}\n',
        'rpc/hello.bru': `${GRPC}script:post-response {\n  bru.setVar("b", 2);\n}\n`,
      },
    );
    const grpc = mapped.collections[0]!.grpc!;
    expect(grpc.scripts).toMatchObject({ api: 'bruno', enabled: false, postResponseOrder: 'inner-first' });
    expect(grpc.scripts?.pre?.text).toBe('bru.setVar("root", 1);\n');
    expect(grpc.folders[0]!.scripts).toMatchObject({ pre: { text: 'bru.setVar("dir", 1);\n' }, enabled: false });
    expect(grpc.folders[0]!.requests[0]!.scripts).toMatchObject({ post: { text: 'bru.setVar("b", 2);\n' } });
    expect(mapped.scripts).toEqual([]);
  });

  it('saves the scripts of a WebSocket item as text, and says so', () => {
    const mapped = mapFolder(
      {},
      {
        'ping.bru': request(''),
        'socket.bru': `${WS}script:pre-request {\n  bru.setVar("a", 1);\n}\n`,
      },
    );
    expect(mapped.scripts).toEqual([
      { path: 'imported-scripts/c/echo.before-request.js', source: 'bru.setVar("a", 1);\n' },
    ]);
    expect(mapped.report.notes).toContain(
      'Echo: its before-request script has no place to run in Wirebench, so it was saved to imported-scripts/c/echo.before-request.js and is never run.',
    );
    expect(apiRequests(mapped.collections[0]!.rest!)[0]!.scripts).toBeUndefined();
  });

  it('saves the collection script as text when no REST or gRPC API holds it', () => {
    const mapped = mapFolder(
      {},
      {
        'collection.bru': 'script:pre-request {\n  bru.setVar("root", 1);\n}\n',
        'socket.bru': WS,
      },
    );
    expect(mapped.scripts.map((file) => file.path)).toEqual(['imported-scripts/c/c.before-request.js']);
  });
});

const GRPC =
  'meta {\n  name: Hello\n  type: grpc\n  seq: 1\n}\n\ngrpc {\n  url: grpc://h:1\n  method: /a.B/C\n  body: grpc\n}\n\n';
const WS = 'meta {\n  name: Echo\n  type: ws\n  seq: 2\n}\n\nws {\n  url: wss://h/ws\n  body: ws\n}\n\n';

/** A Bruno JSON export, whose items carry no path of their own: only their names. */
function mapExport(items: unknown[]) {
  let n = 0;
  const { collection, report } = ocOfBrunoExport({ version: '1', name: 'Shop', items });
  return mapBruno(collection, report, { newId: () => `id${String((n += 1))}` });
}

const login = (script?: string): Record<string, unknown> => ({
  type: 'http',
  name: 'Login',
  seq: 1,
  request: {
    url: 'https://a.example.com/login',
    method: 'GET',
    ...(script !== undefined ? { script: { req: script } } : {}),
  },
});
const folder = (name: string, items: unknown[], script?: string): Record<string, unknown> => ({
  type: 'folder',
  name,
  root: { meta: { name }, ...(script !== undefined ? { request: { script: { req: script } } } : {}) },
  items,
});

describe('Bruno scripts follow their item, not its name', () => {
  it('two folders each holding "Login": only the one with a script has one', () => {
    const api = mapExport([folder('A', [login('a()')]), folder('B', [login()])]).collections[0]!.rest!;
    const [a, b] = apiFolders(api);
    expect(a!.requests[0]!.scripts?.pre?.text).toBe('a()\n');
    expect(b!.requests[0]!.scripts).toBeUndefined();
  });

  it('two "Login" requests with different scripts each keep their own', () => {
    const api = mapExport([folder('A', [login('a()')]), folder('B', [login('b()')])]).collections[0]!.rest!;
    const [a, b] = apiFolders(api);
    expect(a!.requests[0]!.scripts?.pre?.text).toBe('a()\n');
    expect(b!.requests[0]!.scripts?.pre?.text).toBe('b()\n');
  });

  it('a folder and a request sharing a name keep separate scripts', () => {
    const api = mapExport([folder('Login', [login()], 'dir()'), login('req()')]).collections[0]!.rest!;
    expect(apiFolders(api)[0]!.scripts?.pre?.text).toBe('dir()\n');
    expect(apiFolders(api)[0]!.requests[0]!.scripts).toBeUndefined();
    expect(api.requests[0]!.scripts?.pre?.text).toBe('req()\n');
  });
});
