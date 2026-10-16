import { describe, expect, it } from 'vitest';
import { ThunderError } from '../../../../src/errors.js';
import type { MappedClientImport } from '../../../../src/import/client-import.js';
import { joinBaseUrl, mapThunderClient } from '../../../../src/import/thunder/convert.js';
import { importThunderClient } from '../../../../src/import/thunder/import.js';
import { parseThunderExport } from '../../../../src/import/thunder/parse.js';
import type { RestApi, RestFolder, RestRequestDef } from '../../../../src/rest/model.js';
import { thunderFixture, thunderFixtureDir } from './fixtures.js';

function mapped(name: string): MappedClientImport {
  return mapThunderClient(parseThunderExport(thunderFixture(name)));
}

function all(container: RestApi | RestFolder): RestRequestDef[] {
  return [...container.folders.flatMap(all), ...container.requests];
}

const shop = () => mapped('collection-1.2.json');
const shopApi = (): RestApi => {
  const rest = shop().collections[0]?.rest;
  if (rest === undefined) throw new Error('no API');
  return rest;
};
const request = (name: string) => all(shopApi()).find((r) => r.name === name);
const warnings = () => shop().report.warnings;

describe('joinBaseUrl', () => {
  it('joins with exactly one slash and leaves an absolute URL as it is', () => {
    expect(joinBaseUrl('https://a.test/api/', '/x')).toBe('https://a.test/api/x');
    expect(joinBaseUrl('https://a.test/api', 'x')).toBe('https://a.test/api/x');
    expect(joinBaseUrl('https://a.test/api/', '')).toBe('https://a.test/api');
    expect(joinBaseUrl('https://a.test', 'https://b.test/y')).toBe('https://b.test/y');
    expect(joinBaseUrl('https://a.test', '{{host}}/y')).toBe('{{host}}/y');
    expect(joinBaseUrl('', '/x')).toBe('/x');
  });
});

describe('mapThunderClient: tree', () => {
  it('builds the folders by parent, sorted, and puts an orphan folder at the root', () => {
    const api = shopApi();
    expect(api.folders.map((f) => f.name)).toEqual(['lost', 'admin']);
    expect(api.folders[1]?.folders.map((f) => f.name)).toEqual(['orders']);
    expect(api.requests.map((r) => r.name)).toEqual(['Upload picture', 'Product by id', 'Events']);
  });

  it('keeps the base URL, without its trailing slash, as the server, and the paths relative to it', () => {
    expect(shopApi().baseUrl).toBe('${baseUrl}/api');
    expect(request('Create order')?.url).toBe('/orders/{orderId}/items');
    expect(request('Upload picture')?.url).toBe('/products/${productId}/picture');
  });

  it('skips a WebSocket request with a warning', () => {
    expect(request('Socket')).toBeUndefined();
    expect(warnings()).toContain('Socket: its request type "ws" has no published file shape, so it was not imported.');
  });
});

describe('mapThunderClient: broken trees', () => {
  type Row = { _id: string; name: string; containerId: string };
  const req = (id: string, folder: string) => ({
    _id: id,
    name: id,
    url: `https://a.test/${id}`,
    method: 'GET',
    containerId: folder,
  });
  const exported = (folders: Row[], requests: ReturnType<typeof req>[]) =>
    mapThunderClient(
      parseThunderExport(JSON.stringify({ clientName: 'Thunder Client', collectionName: 'Tree', folders, requests })),
    );

  it('writes a folder once when two share an id, with a warning, instead of recursing', () => {
    const result = exported(
      [
        { _id: 'a', name: 'A', containerId: 'b' },
        { _id: 'b', name: 'B1', containerId: '' },
        { _id: 'b', name: 'B2', containerId: 'a' },
      ],
      [req('r1', 'a')],
    );
    expect(result.counts).toMatchObject({ requests: 1, folders: 2 });
    expect(result.report.warnings).toContain(
      'B1 / A / B2: it shares its id with another folder, so it was not imported again.',
    );
  });

  it('places folders whose parents point at each other, or at themselves, at the top level', () => {
    const result = exported(
      [
        { _id: 'a', name: 'A', containerId: 'b' },
        { _id: 'b', name: 'B', containerId: 'a' },
        { _id: 's', name: 'Self', containerId: 's' },
      ],
      [req('r1', 'a'), req('r2', 's'), req('r3', '')],
    );
    const api = result.collections[0]?.rest;
    expect(api?.folders.map((f) => f.name)).toEqual(['A', 'Self']);
    expect(api?.folders[0]?.folders.map((f) => f.name)).toEqual(['B']);
    expect(result.counts.requests).toBe(3);
    expect(result.report.warnings).toEqual([
      'A: its parent folders point at each other, so it was placed at the top level.',
      'Self: its parent folders point at each other, so it was placed at the top level.',
    ]);
  });

  it('cuts folders nested too deep, with a warning, instead of overflowing the stack', () => {
    const folders = Array.from({ length: 20_000 }, (_, i) => ({
      _id: `f${String(i)}`,
      name: `F${String(i)}`,
      containerId: i === 0 ? '' : `f${String(i - 1)}`,
    }));
    const result = exported(folders, [req('top', ''), req('deep', 'f19999')]);
    expect(result.counts).toMatchObject({ requests: 1, folders: 63 });
    expect(result.report.warnings.filter((line) => line.includes('levels deep'))).toHaveLength(1);
  });
});

describe('mapThunderClient: requests', () => {
  it('maps path and query params, disabled rows switched off', () => {
    const create = request('Create order');
    expect(create?.pathParams).toEqual([expect.objectContaining({ name: 'orderId', value: '42' })]);
    expect(create?.query).toEqual([expect.objectContaining({ name: 'dryRun', enabled: false })]);
  });

  it('copies collection and folder headers onto requests that do not set them', () => {
    const names = request('Create order')?.headers.map((h) => [h.name, h.enabled]);
    expect(names).toEqual([
      ['Accept', true],
      ['X-Debug', false],
      ['X-Scope', true],
      ['Content-Type', true],
    ]);
    expect(request('Upload picture')?.headers.map((h) => h.name)).toEqual(['Accept']);
  });

  it('rewrites the dynamic variables in a JSON body', () => {
    const body = request('Create order')?.body;
    expect(body).toMatchObject({ kind: 'raw', language: 'json' });
    expect(body?.kind === 'raw' ? body.text : '').toContain('"sku": "${$guid}"');
    expect(body?.kind === 'raw' ? body.text : '').toContain('${$randomInt(1,5)}');
  });

  it('maps form, multipart, GraphQL, binary and XML bodies', () => {
    expect(request('Token')?.body).toEqual({
      kind: 'form',
      fields: [
        { name: 'a', value: '1', enabled: true },
        { name: 'b', value: '2', enabled: false },
      ],
    });
    expect(request('Upload picture')?.body).toMatchObject({
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'caption', value: 'front view' },
        { kind: 'file', name: 'picture', source: { kind: 'path', path: '../assets/front.webp' } },
      ],
    });
    expect(request('Product by id')?.body).toMatchObject({ kind: 'graphql', variables: '{ "id": "${productId}" }' });
    expect(request('Bucket')?.body).toMatchObject({
      kind: 'binary',
      source: { kind: 'path', path: '../input/file.zip' },
    });
    expect(request('Odd auth')?.body).toEqual({ kind: 'raw', language: 'xml', text: '<a/>' });
  });

  it('maps bearer with its prefix, basic, OAuth 2 and AWS auth, without their credentials', () => {
    expect(shopApi().auth).toEqual({ type: 'bearer' });
    expect(request('Events')?.auth).toEqual({ type: 'bearer', scheme: 'Sanctum' });
    expect(request('Upload picture')?.auth).toEqual({ type: 'basic', username: 'svc' });
    expect(request('Token')?.auth).toMatchObject({ type: 'oauth2', grant: 'client-credentials', clientId: 'app' });
    expect(request('Bucket')?.auth).toMatchObject({ type: 'aws-sigv4', region: 'eu-west-1', service: 's3' });
    expect(JSON.stringify(shop())).not.toMatch(/basic-pass-123|oauth-secret-123|aws-secret-123|literal-bearer-123/);
  });

  it('sets an auth with no equivalent to none, with a warning', () => {
    expect(request('Odd auth')?.auth).toEqual({ type: 'none' });
    expect(warnings()).toContain(
      'lost / Odd auth: its "hawk" auth has no Wirebench equivalent, so it was set to "none".',
    );
  });
});

describe('mapThunderClient: tests and scripts', () => {
  it('attaches the tests of the request and of its folders as assertions', () => {
    expect(request('Create order')?.assertions).toEqual([
      { type: 'sla', maxMs: 800 },
      { type: 'status', equals: 201 },
      { type: 'match', language: 'jsonpath', expression: '$.items[0].id', equals: 7 },
    ]);
    expect(shop().counts.assertions).toBe(7);
  });

  it('keeps the assertions and order of two same-named requests in one folder apart', () => {
    const orders = shopApi().folders[1]?.folders[0];
    const lists = orders?.requests.filter((r) => r.name === 'List') ?? [];
    expect(lists.map((r) => r.url)).toEqual(['https://other.example.com/list', '/list']);
    expect(lists.map((r) => r.assertions.at(-1))).toEqual([
      { type: 'status', equals: 200 },
      { type: 'status', equals: 404 },
    ]);
  });

  it('reports a test with no equivalent once, under the owner that has it', () => {
    const lines = warnings();
    expect(lines.filter((line) => line.includes('Content-Type contains json'))).toEqual([
      'Shop API: the test "Content-Type contains json" has no Wirebench equivalent and was not imported.',
    ]);
    expect(lines).toContain(
      'admin / orders / Create order: the test "set-env-var json.id setto {{lastItemId}}" sets a variable from the response, which was not imported; use a capture or a script.',
    );
  });

  it('saves scripts as text under a path named after the request, and reports their dialect', () => {
    expect(shop().scripts).toEqual([
      {
        path: 'imported-scripts/shop api/product by id.post.js',
        source: 'var json = tc.response.json;\ntc.setVar("firstName", json.data.product.name);',
      },
    ]);
    expect(warnings().some((line) => line.includes('tc.'))).toBe(true);
  });

  it("reports the collection's run options without importing them", () => {
    const text = JSON.stringify({
      clientName: 'Thunder Client',
      collectionName: 'Runs',
      folders: [],
      requests: [{ _id: 'r1', name: 'Ping', url: 'https://a.test/ping', method: 'GET' }],
      settings: { runOptions: { delay: 100, iterations: 2 } },
    });
    expect(mapThunderClient(parseThunderExport(text)).report.notes).toContain(
      'Runs: its run options (delay, iterations, data file) were not imported.',
    );
  });

  it('reports request chaining without importing it', () => {
    expect(warnings()).toContain(
      'Product by id: it runs other requests first (request chaining), which was not imported; build the chain as a sequence.',
    );
  });
});

describe('mapThunderClient: environments', () => {
  it('imports an environment, a secret value kept out of the plain value', () => {
    expect(mapped('environment-1.0.json').variables.environments).toEqual([
      {
        name: 'Staging',
        variables: [
          { name: 'baseUrl', value: 'https://staging.example.com', enabled: true, secret: false },
          { name: 'client_id', value: '', enabled: true, secret: true, secretValue: 'env-secret-123' },
          { name: 'emptySecret', value: '', enabled: true, secret: true },
        ],
      },
    ]);
  });

  it('merges a global environment into Globals and never activates it', () => {
    const { variables } = mapped('environment-1.2-global.json');
    expect(variables.environments).toEqual([]);
    expect(variables.globals?.variables).toEqual([{ name: 'tenant', value: 'acme', enabled: true, secret: false }]);
    expect(variables.report.notes).toContain(
      'Globals: it was marked local in Thunder Client; an import never makes an environment active.',
    );
  });

  it('warns about an env file it does not read and an encrypted value it cannot', async () => {
    const result = await importThunderClient({ kind: 'folder', path: `${thunderFixtureDir}folder-v3` });
    expect(result.variables.environments[0]?.variables[1]).toEqual({
      name: 'color',
      value: '',
      enabled: true,
      secret: true,
    });
    expect(result.variables.report.warnings).toEqual([
      'Environment "Dev": its values come from the file ..\\server\\.env, which is not read; set them in Environments.',
      'Environment "Dev": color is encrypted and cannot be read, so it was imported with no value.',
    ]);
  });
});

describe('importThunderClient', () => {
  it('reads a file, text, and a legacy folder', async () => {
    const file = await importThunderClient({ kind: 'file', path: `${thunderFixtureDir}collection-1.0.json` });
    expect(file.collections.map((c) => c.name)).toEqual(['Legacy']);
    const text = await importThunderClient(
      { kind: 'text', text: thunderFixture('collection-1.0.json') },
      { name: 'Renamed' },
    );
    expect(text.collections.map((c) => c.name)).toEqual(['Renamed']);
    const legacy = await importThunderClient({ kind: 'folder', path: `${thunderFixtureDir}folder-legacy` });
    expect(legacy.collections.map((c) => c.name)).toEqual(['Legacy items', 'Legacy other']);
    expect(legacy.counts).toMatchObject({ collections: 2, requests: 3, folders: 1 });
  });

  it('refuses an export with nothing to bring across', () => {
    const empty = '{"clientName":"Thunder Client","collectionName":"Empty","folders":[],"requests":[]}';
    expect(() => mapThunderClient(parseThunderExport(empty))).toThrow(ThunderError);
  });
});
