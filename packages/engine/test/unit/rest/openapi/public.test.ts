/**
 * Import goldens over the two public fixtures (`fixtures/openapi/SOURCES.md`).
 *
 * The crafted fixtures prove each mapping rule on its own; these prove the rules survive contact
 * with documents nobody wrote for this client — an untagged operation in a tagged document, an
 * OAuth2 flow this client cannot complete named by many operations at once, a body offered in two
 * media types. Every value here was checked against the source document, not copied from output.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseOpenApi } from '../../../../src/rest/openapi/import.js';
import { apiFromDocument } from '../../../../src/rest/openapi/map.js';
import type { MappedApi } from '../../../../src/rest/openapi/map.js';
import type { RestRequestDef } from '../../../../src/rest/model.js';
import type { FetchDocument } from '../../../../src/wsdl/resolver.js';

const publicDir = fileURLToPath(new URL('../../../../../../fixtures/openapi/public/', import.meta.url));

const fetchDocument = ((location: string) => {
  const text = readFileSync(fileURLToPath(location), 'utf-8');
  return Promise.resolve({ location, bytes: new TextEncoder().encode(text), text });
}) as FetchDocument;

interface Manifest {
  readonly files: readonly { readonly file: string; readonly sha256: string }[];
}

/** Maps the public fixture `name`, numbering ids so the tree can be asserted whole. */
async function mapped(name: string): Promise<MappedApi> {
  const parsed = await parseOpenApi(
    { kind: 'file', path: pathToFileURL(`${publicDir}${name}/openapi.json`).href },
    { fetchDocument },
  );
  let next = 0;
  return apiFromDocument(parsed.document, {
    newId: () => {
      next += 1;
      return `id-${String(next)}`;
    },
  });
}

/** Every request of the API keyed by `METHOD /path`, which a document keeps unique. */
function byRoute(api: MappedApi['api']): Map<string, RestRequestDef> {
  return new Map(
    [...api.requests, ...api.folders.flatMap((folder) => folder.requests)].map((request) => [
      `${request.method} ${request.url}`,
      request,
    ]),
  );
}

describe('the vendored fixtures', () => {
  it.each(['petstore-3.0', 'security-3.1'])('%s is the bytes its manifest records', (name) => {
    const manifest = JSON.parse(readFileSync(`${publicDir}${name}/manifest.json`, 'utf-8')) as Manifest;
    const entry = manifest.files[0];
    const bytes = readFileSync(`${publicDir}${name}/${entry?.file ?? ''}`);

    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry?.sha256);
  });
});

describe('Swagger Petstore (3.0)', () => {
  it('maps the whole tree: three tag folders, twenty requests, one deprecated among them', async () => {
    const { api, summary } = await mapped('petstore-3.0');

    expect(api.name).toBe('Swagger Petstore');
    expect(api.baseUrl).toBe('http://petstore.swagger.io/v2');
    expect(api.servers).toEqual([{ url: 'http://petstore.swagger.io/v2' }]);
    expect(api.requests).toEqual([]);
    expect(api.folders.map((folder) => [folder.name, folder.requests.length])).toEqual([
      ['pet', 8],
      ['store', 4],
      ['user', 8],
    ]);
    expect(summary).toMatchObject({
      declaredVersion: '3.0.0',
      apiVersion: '1.0.0',
      folders: 3,
      requests: 20,
      deprecated: 1,
    });
    // `findByTags` is deprecated and tagged, so it stays with its live siblings.
    const findByTags = byRoute(api).get('GET /pet/findByTags');
    expect(findByTags?.description?.startsWith('**Deprecated.**')).toBe(true);
    expect(api.folders[0]?.requests).toContain(findByTags);
  });

  it('names requests from their summaries and maps every parameter location', async () => {
    const routes = byRoute((await mapped('petstore-3.0')).api);

    expect(routes.get('POST /pet')?.name).toBe('Add a new pet to the store');
    expect(routes.get('POST /pet/{petId}')?.pathParams).toEqual([
      { name: 'petId', value: '0', enabled: true, description: 'ID of pet that needs to be updated' },
    ]);
    // Both login parameters are required, so both rows arrive enabled.
    expect(routes.get('GET /user/login')?.query).toEqual([
      { name: 'username', value: '', enabled: true, description: 'The user name for login' },
      { name: 'password', value: '', enabled: true, description: 'The password for login in clear text' },
    ]);
    // The `api_key` header parameter arrives as a switched-off header row.
    expect(routes.get('DELETE /pet/{petId}')?.headers).toEqual([{ name: 'api_key', value: '', enabled: false }]);
  });

  it('builds each body from the media type it prefers', async () => {
    const { api, summary } = await mapped('petstore-3.0');
    const routes = byRoute(api);

    // JSON wins over XML, with a sample built from the Pet schema's own examples.
    expect(routes.get('POST /pet')?.body).toEqual({
      kind: 'raw',
      language: 'json',
      text: '{\n  "name": "doggie",\n  "photoUrls": [\n    "https://example.com/photo.png"\n  ]\n}',
    });
    expect(summary.skipped).toContainEqual({
      kind: 'media-type',
      where: 'POST /pet',
      reason: 'Offers "application/xml" as well; imported as "application/json"',
    });
    expect(routes.get('POST /pet/{petId}')?.body).toEqual({
      kind: 'form',
      fields: [
        { name: 'name', value: '', enabled: false, description: 'Updated name of the pet' },
        { name: 'status', value: '', enabled: false, description: 'Updated status of the pet' },
      ],
    });
    expect(routes.get('POST /pet/{petId}/uploadImage')?.body).toEqual({
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'additionalMetadata', value: '', enabled: false },
        { kind: 'file', name: 'file', source: { kind: 'path', path: '' }, enabled: false },
      ],
    });
  });

  it('maps the api_key scheme per operation and says once that the implicit flow is not supported', async () => {
    const { api, summary } = await mapped('petstore-3.0');
    const routes = byRoute(api);

    // No document-level requirement, so the API itself has no credentials.
    expect(api.auth).toBeUndefined();
    expect(routes.get('GET /pet/{petId}')?.auth).toEqual({ type: 'api-key', name: 'api_key', in: 'header' });
    expect(routes.get('GET /store/inventory')?.auth).toEqual({ type: 'api-key', name: 'api_key', in: 'header' });
    // `petstore_auth` is an implicit flow, which a desktop client cannot complete: the request is
    // left inheriting, and the summary says why — once, not once per operation.
    expect(routes.get('POST /pet')?.auth).toEqual({ type: 'inherit' });
    const notes = summary.skipped.filter((entry) => entry.where === 'petstore_auth');
    expect(notes).toEqual([
      {
        kind: 'security-scheme',
        where: 'petstore_auth',
        reason: 'Only the client-credentials and authorization-code flows are supported',
      },
    ]);
  });
});

describe('Support for different security types (3.1)', () => {
  it('files operations by tag, and an untagged one by its first path segment', async () => {
    const { api, summary } = await mapped('security-3.1');

    expect(api.name).toBe('Support for different security types');
    expect(api.baseUrl).toBe('https://httpbin.org');
    expect(summary).toMatchObject({ declaredVersion: '3.1.0', folders: 7, requests: 15, deprecated: 0 });
    // `PUT /anything/bearer` is the one operation the document forgot to tag.
    expect(api.folders.map((folder) => [folder.name, folder.requests.length])).toEqual([
      ['API Key', 3],
      ['HTTP', 2],
      ['anything', 1],
      ['Mutual TLS', 1],
      ['OAuth 2', 5],
      ['OpenID Connect', 1],
      ['Other', 2],
    ]);
  });

  it('maps every scheme type it can, one operation each', async () => {
    const routes = byRoute((await mapped('security-3.1')).api);

    expect(routes.get('GET /anything/apiKey')?.auth).toEqual({ type: 'api-key', name: 'apiKey', in: 'query' });
    expect(routes.get('PUT /anything/apiKey')?.auth).toEqual({ type: 'api-key', name: 'X-API-KEY', in: 'header' });
    expect(routes.get('POST /anything/basic')?.auth).toEqual({ type: 'basic' });
    expect(routes.get('POST /anything/bearer')?.auth).toEqual({ type: 'bearer' });
    expect(routes.get('PUT /anything/bearer')?.auth).toEqual({ type: 'bearer' });
    expect(routes.get('GET /anything/oauth2')?.auth).toEqual({
      type: 'oauth2',
      grant: 'authorization-code',
      authorizationUrl: 'http://alt.example.com/oauth/dialog',
      tokenUrl: 'http://alt.example.com/oauth/token',
      clientId: '',
      scopes: ['write:things'],
      clientAuth: 'basic',
      pkce: true,
    });
    expect(routes.get('PUT /anything/oauth2')?.auth).toEqual({
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: 'http://alt.example.com/oauth/token',
      clientId: '',
      scopes: ['write:things'],
      clientAuth: 'basic',
      pkce: false,
    });
    // A scheme offering every flow: client credentials is the one a desktop client can always run.
    expect(routes.get('POST /anything/oauth2')?.auth).toMatchObject({ type: 'oauth2', grant: 'client-credentials' });
  });

  it('leaves what it cannot map inheriting, and names each scheme once in the summary', async () => {
    const { api, summary } = await mapped('security-3.1');
    const routes = byRoute(api);

    for (const route of [
      'POST /anything/apiKey',
      'POST /anything/mutualTLS',
      'PATCH /anything/oauth2',
      'DELETE /anything/oauth2',
      'POST /anything/openIdConnect',
    ]) {
      expect(routes.get(route)?.auth, route).toEqual({ type: 'inherit' });
    }
    // The document declares no `security` on `/anything/no-auth` at all — not an empty one — so
    // there is nothing to say and the request inherits.
    expect(routes.get('POST /anything/no-auth')?.auth).toEqual({ type: 'inherit' });
    expect(summary.skipped).toEqual([
      { kind: 'security-scheme', where: 'apiKey_cookie', reason: 'An API key in a cookie is not supported' },
      { kind: 'security-scheme', where: 'mutualTLS', reason: 'Security scheme type "mutualTLS" is not supported' },
      {
        kind: 'security-scheme',
        where: 'oauth2_implicit',
        reason: 'Only the client-credentials and authorization-code flows are supported',
      },
      {
        kind: 'security-scheme',
        where: 'oauth2_password',
        reason: 'Only the client-credentials and authorization-code flows are supported',
      },
      {
        kind: 'security-scheme',
        where: 'openIdConnect',
        reason: 'Security scheme type "openIdConnect" is not supported',
      },
    ]);
  });
});
