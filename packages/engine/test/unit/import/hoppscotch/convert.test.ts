import { describe, expect, it } from 'vitest';
import type { MappedClientImport } from '../../../../src/import/client-import.js';
import { hoppscotchEnvironmentPlan, mapHoppscotch, urlencodedRows } from '../../../../src/import/hoppscotch/convert.js';
import { importHoppscotch, importHoppscotchEnvironments } from '../../../../src/import/hoppscotch/import.js';
import { parseHoppscotchCollections, parseHoppscotchEnvironments } from '../../../../src/import/hoppscotch/parse.js';
import type { RestApi, RestFolder, RestRequestDef } from '../../../../src/rest/model.js';
import { hoppscotchFixture, hoppscotchFixtureDir } from './fixtures.js';

function mapped(name: string, options: Parameters<typeof mapHoppscotch>[2] = {}): MappedClientImport {
  const { collections, report } = parseHoppscotchCollections(hoppscotchFixture(name));
  return mapHoppscotch(collections, report, options);
}

function find(container: RestApi | RestFolder, name: string): RestRequestDef | undefined {
  for (const request of container.requests) if (request.name === name) return request;
  for (const folder of container.folders) {
    const inner = find(folder, name);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

const shop = () => mapped('v12-r17.json');
const request = (name: string) => {
  const rest = shop().collections[0]?.rest;
  return rest !== undefined ? find(rest, name) : undefined;
};

describe('mapHoppscotch: requests', () => {
  it('rewrites <<name>> and keeps a param the endpoint query already has only once', () => {
    const create = request('Create order');
    expect(create?.url).toBe('/orders');
    expect(create?.query).toEqual([
      expect.objectContaining({ name: 'dry_run', value: 'true', enabled: true }),
      expect.objectContaining({ name: 'trace', value: '1', enabled: false }),
    ]);
    expect(shop().collections[0]?.rest?.baseUrl).toBe('${baseUrl}');
  });

  it('keeps inactive headers switched off, and copies collection and folder headers down', () => {
    expect(request('Create order')?.headers).toEqual([
      expect.objectContaining({ name: 'Content-Type', value: 'application/json', enabled: true }),
      expect.objectContaining({ name: 'X-Debug', enabled: false }),
      expect.objectContaining({ name: 'X-Team', value: 'web' }),
      expect.objectContaining({ name: 'X-Area', value: 'orders' }),
    ]);
  });

  it('maps each body: raw by content type, url-encoded text as a form, a multipart file part switched off', () => {
    expect(request('Create order')?.body).toMatchObject({ kind: 'raw', language: 'json' });
    expect(request('Digest')?.body).toMatchObject({ kind: 'raw', language: 'xml' });
    expect(request('Login form')?.body).toEqual({
      kind: 'form',
      fields: [
        expect.objectContaining({ name: 'user', value: 'alice', enabled: true }),
        expect.objectContaining({ name: 'debug', value: '1', enabled: false }),
        expect.objectContaining({ name: 'pass', value: '${password}', enabled: true }),
      ],
    });
    expect(request('Upload avatar')?.body).toMatchObject({
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'caption', value: 'me' },
        { kind: 'text', name: 'file', value: '', enabled: false },
      ],
    });
    expect(request('Signed')?.body).toEqual({ kind: 'none' });
    expect(shop().report.notes).toEqual(
      expect.arrayContaining([
        'Shop API / Upload avatar: the file part "file" has no file in the export, so it was kept switched off as a text part; pick its file on the Body tab.',
        'Shop API / Signed: its body is a file, which is not in the export, so it has no body; pick the file on the Body tab.',
      ]),
    );
  });

  it('reads url-encoded lines, a # line switched off', () => {
    expect(urlencodedRows('a: 1\n# b: 2\n\nc')).toEqual([
      { key: 'a', value: '1', active: true },
      { key: 'b', value: '2', active: false },
      { key: 'c', value: '', active: true },
    ]);
  });

  it('maps each auth type, ignoring keys left from another one', () => {
    expect(shop().collections[0]?.rest?.auth).toEqual({ type: 'bearer' });
    expect(request('Create order')?.auth).toEqual({ type: 'inherit' });
    expect(request('Login form')?.auth).toEqual({ type: 'none' });
    expect(request('Upload avatar')?.auth).toEqual({ type: 'api-key', name: 'X-API-Key', in: 'header' });
    expect(request('Token via client credentials')?.auth).toMatchObject({
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: 'https://auth.example.test/oauth/token',
      clientId: 'client-1',
      scopes: ['read', 'write'],
      clientAuth: 'body',
    });
    expect(request('Digest')?.auth).toEqual({ type: 'digest', username: 'admin' });
    expect(request('Signed')?.auth).toMatchObject({ type: 'jwt', algorithm: 'HS256', in: 'header', prefix: 'Bearer' });
    expect(request('AWS off')?.auth).toEqual({ type: 'none' });
  });

  it('sets Hawk to none with a warning naming the request', () => {
    expect(request('Hawk')?.auth).toEqual({ type: 'none' });
    expect(shop().report.warnings).toContain(
      'Shop API / Hawk: Hawk auth has no Wirebench equivalent, so it was set to "none".',
    );
  });

  it('never copies a literal credential', () => {
    const all = JSON.stringify(shop());
    for (const secret of ['oauth-secret-123', 'digest-pass-123', 'jwt-secret-123', 'hawk-key-123', 'aws-secret-123']) {
      expect(all).not.toContain(secret);
    }
    expect(JSON.stringify(mapped('legacy-v0.json'))).not.toContain('legacy-pass-123');
  });

  it('turns saved responses into examples, and reports request variables', () => {
    expect(request('Create order')?.examples).toHaveLength(1);
    expect(request('Create order')?.description).toBe('Creates an order');
    expect(shop().counts.examples).toBe(1);
    expect(shop().report.warnings).toContain(
      'Shop API / Orders / Create order: request-level variables (sku) were not imported; Wirebench has no request scope.',
    );
  });

  it('maps a GraphQL request to a POST with a GraphQL body', () => {
    expect(request('Get user (GraphQL)')).toMatchObject({
      method: 'POST',
      body: { kind: 'graphql', query: 'query User($id: ID!) { user(id: $id) { id name } }' },
    });
    const gql = mapped('gql.json').collections[0]?.rest;
    expect(gql?.requests[0]?.headers).toContainEqual(expect.objectContaining({ value: 'Bearer ${token}' }));
  });

  it('names the API after the collection, or the given name for a single one', () => {
    expect(mapped('gql.json', { name: 'Renamed' }).collections[0]?.name).toBe('Renamed');
    expect(shop().counts).toMatchObject({ collections: 1, requests: 9, folders: 1 });
  });
});

describe('mapHoppscotch: variables and scripts', () => {
  it('makes collection and folder variables project properties, a secret one with no value', () => {
    expect(shop().variables.projectProperties?.variables).toEqual([
      { name: 'baseUrl', value: 'https://api.example.test', enabled: true, secret: false },
      { name: 'apiKey', value: '', enabled: true, secret: true },
      { name: 'region', value: 'eu', enabled: true, secret: false },
    ]);
    expect(shop().variables.environments).toEqual([]);
  });

  it('saves every script as text and names the script APIs they call', () => {
    expect(shop().scripts.map((script) => script.path)).toEqual([
      'imported-scripts/shop api/shop api.pre.js',
      'imported-scripts/shop api/shop api-orders-create order.pre.js',
      'imported-scripts/shop api/shop api-orders-create order.tests.js',
      'imported-scripts/shop api/shop api-get user (graphql).tests.js',
    ]);
    expect(shop().report.warnings).toContain(
      'The saved scripts call pw., hopp.; Wirebench does not run them. Port what they do to Wirebench scripts by hand.',
    );
  });

  it('refuses an export with no request and no variable', () => {
    const { collections, report } = parseHoppscotchCollections('{"name":"Empty","folders":[],"requests":[]}');
    expect(() => mapHoppscotch(collections, report)).toThrow(
      expect.objectContaining({ code: 'hoppscotch-nothing-to-import' }),
    );
  });
});

describe('Hoppscotch environments', () => {
  it('makes each environment a workspace environment and merges Global into Globals', () => {
    const { environments, report } = parseHoppscotchEnvironments(hoppscotchFixture('environments-v2.json'));
    const plan = hoppscotchEnvironmentPlan(environments, report);
    expect(plan.environments.map((env) => env.name)).toEqual(['Staging', 'Old']);
    expect(plan.environments[0]?.variables).toEqual([
      { name: 'baseUrl', value: 'https://staging.example.test', enabled: true, secret: false },
      { name: 'region', value: 'us', enabled: true, secret: false },
      { name: 'apiKey', value: '', enabled: true, secret: true },
    ]);
    expect(plan.globals?.variables).toEqual([{ name: 'tenant', value: 'acme', enabled: true, secret: false }]);
  });

  it('rewrites <<name>> in a value', () => {
    const { environments, report } = parseHoppscotchEnvironments(hoppscotchFixture('environment-v0.json'));
    expect(hoppscotchEnvironmentPlan(environments, report).environments[0]?.variables[1]?.value).toBe('${baseUrl}/v1');
  });

  it('reads either kind of file from disk', async () => {
    expect((await importHoppscotch({ kind: 'file', path: `${hoppscotchFixtureDir}gql.json` })).counts.requests).toBe(1);
    const envs = await importHoppscotchEnvironments({
      kind: 'file',
      path: `${hoppscotchFixtureDir}environments-v2.json`,
    });
    expect(envs.collections).toEqual([]);
    expect(envs.variables.environments).toHaveLength(2);
  });
});
