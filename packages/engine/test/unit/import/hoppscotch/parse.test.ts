import { describe, expect, it } from 'vitest';
import { HoppscotchError } from '../../../../src/errors.js';
import type { HopRestRequest } from '../../../../src/import/hoppscotch/model.js';
import { parseHoppscotchCollections, parseHoppscotchEnvironments } from '../../../../src/import/hoppscotch/parse.js';
import { hoppscotchFixture } from './fixtures.js';

const collections = (name: string) => parseHoppscotchCollections(hoppscotchFixture(name));

describe('parseHoppscotchCollections', () => {
  it('reads an array of collections and a single collection object', () => {
    expect(collections('v12-r17.json').collections.map((c) => c.name)).toEqual(['Shop API']);
    expect(collections('legacy-v0.json').collections.map((c) => c.name)).toEqual(['Legacy API']);
  });

  it('reads a legacy collection with no version as one that inherits, with no headers or variables', () => {
    const [legacy] = collections('legacy-v0.json').collections;
    expect(legacy).toMatchObject({ auth: { authType: 'inherit' }, headers: [], variables: [], pre: '', test: '' });
  });

  it("reads a v0 REST request as Hoppscotch's own migration does", () => {
    const request = collections('legacy-v0.json').collections[0]?.requests[0] as HopRestRequest;
    expect(request).toMatchObject({
      kind: 'rest',
      method: 'GET',
      endpoint: 'https://echo.example.test/get',
      body: { contentType: 'application/json', body: '{"a":1}' },
      auth: { authType: 'basic', username: 'alice' },
      params: [{ key: 'q', value: 'x', active: true }],
    });
    expect(request.headers[0]).toEqual({ key: 'X-Old', value: '1', active: false });
  });

  it('reads a REST request with a string version and a GraphQL request with a number one', () => {
    const shop = collections('v12-r17.json').collections[0];
    expect(shop?.requests.map((r) => r.kind)).toEqual(['rest', 'rest', 'rest', 'rest', 'rest', 'rest', 'graphql']);
    expect(shop?.requests[6]).toMatchObject({
      kind: 'graphql',
      url: '<<baseUrl>>/graphql',
      variables: '{\n  "id": "1"\n}',
    });
  });

  it('migrates a folder at an older version than its parent on its own', () => {
    const folder = collections('mixed-versions.json').collections[0]?.folders[0];
    expect(folder?.auth).toEqual({ authType: 'inherit', authActive: true });
    expect(folder?.requests[0]?.auth).toMatchObject({
      authType: 'oauth-2',
      grantTypeInfo: {
        grantType: 'AUTHORIZATION_CODE',
        authEndpoint: 'https://auth.example.test/authorize',
        tokenEndpoint: 'https://auth.example.test/token',
        clientID: 'old-client',
      },
    });
    expect(folder?.requests[1]?.auth).toMatchObject({ authType: 'api-key', addTo: 'QUERY_PARAMS' });
  });

  it('reads a version above the newest known as the newest, and names it', () => {
    const { collections: read, report } = collections('mixed-versions.json');
    expect(read[0]?.requests[0]).toMatchObject({ name: 'Future', method: 'PATCH' });
    expect(report.notes).toEqual([
      'The export holds a collection at version 13, newer than the 12 this build knows; it was read as that.',
      'The export holds a REST request at version 18, newer than the 17 this build knows; it was read as that.',
    ]);
  });

  it('takes a variable value from currentValue, else initialValue, else value; a secret has none', () => {
    const text = JSON.stringify({
      v: 12,
      name: 'V',
      folders: [],
      requests: [],
      variables: [
        { key: 'a', initialValue: 'init', currentValue: 'cur', secret: false },
        { key: 'b', initialValue: 'init', currentValue: '', secret: false },
        { key: 'c', value: 'old' },
        { key: 'd', initialValue: 'leaked', currentValue: 'leaked', secret: true },
      ],
    });
    expect(parseHoppscotchCollections(text).collections[0]?.variables).toEqual([
      { key: 'a', value: 'cur', secret: false },
      { key: 'b', value: 'init', secret: false },
      { key: 'c', value: 'old', secret: false },
      { key: 'd', value: '', secret: true },
    ]);
  });

  it('keeps saved responses as a list', () => {
    const create = collections('v12-r17.json').collections[0]?.folders[0]?.requests[0];
    expect(create?.responses).toEqual([
      {
        name: 'Created',
        code: 201,
        status: 'Created',
        headers: [{ key: 'content-type', value: 'application/json' }],
        body: '{"id":42}',
      },
    ]);
  });

  it('refuses text that is not JSON, an environments file, and other JSON', () => {
    expect(() => parseHoppscotchCollections('{')).toThrow(expect.objectContaining({ code: 'hoppscotch-malformed' }));
    expect(() => parseHoppscotchCollections(hoppscotchFixture('environments-v2.json'))).toThrow(
      expect.objectContaining({
        code: 'hoppscotch-not-collection',
        message: expect.stringContaining('environments') as unknown,
      }),
    );
    expect(() => parseHoppscotchCollections('[]')).toThrow(HoppscotchError);
  });
});

describe('parseHoppscotchEnvironments', () => {
  it('reads v0, v1 and v2 environments', () => {
    const { environments } = parseHoppscotchEnvironments(hoppscotchFixture('environments-v2.json'));
    expect(environments.map((env) => env.name)).toEqual(['Staging', 'Global', 'Old']);
    expect(environments[0]?.variables).toEqual([
      { key: 'baseUrl', value: 'https://staging.example.test', secret: false },
      { key: 'region', value: 'us', secret: false },
      { key: 'apiKey', value: '', secret: true },
    ]);
    expect(environments[2]?.variables).toEqual([
      { key: 'a', value: '1', secret: false },
      { key: 's', value: '', secret: true },
    ]);
    expect(parseHoppscotchEnvironments(hoppscotchFixture('environment-v0.json')).environments).toEqual([
      {
        name: 'Older',
        variables: [
          { key: 'a', value: '1', secret: false },
          { key: 'host', value: '<<baseUrl>>/v1', secret: false },
        ],
      },
    ]);
  });

  it('refuses a collections file', () => {
    expect(() => parseHoppscotchEnvironments(hoppscotchFixture('gql.json'))).toThrow(
      expect.objectContaining({ code: 'hoppscotch-not-environments' }),
    );
  });
});
