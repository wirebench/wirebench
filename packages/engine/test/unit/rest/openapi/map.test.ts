/**
 * The mapping from a document onto an API, stated as goldens over the crafted fixtures.
 *
 * Ids come from a counter so a whole tree can be written out: what matters about an id here is only
 * that every entity got its own.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseOpenApi } from '../../../../src/rest/openapi/import.js';
import { apiFromDocument } from '../../../../src/rest/openapi/map.js';
import type { MapApiOptions, MappedApi } from '../../../../src/rest/openapi/map.js';
import type { FetchDocument } from '../../../../src/wsdl/resolver.js';

const craftedDir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/', import.meta.url));

const fetchDocument = ((location: string) => {
  const text = readFileSync(fileURLToPath(location), 'utf-8');
  return Promise.resolve({ location, bytes: new TextEncoder().encode(text), text });
}) as FetchDocument;

/** Maps the crafted fixture `name`, numbering ids so the tree can be asserted whole. */
async function mapped(name: string, options: MapApiOptions = {}): Promise<MappedApi> {
  const parsed = await parseOpenApi(
    { kind: 'file', path: pathToFileURL(`${craftedDir}${name}/openapi.yaml`).href },
    { fetchDocument },
  );
  let next = 0;
  return apiFromDocument(parsed.document, {
    newId: () => {
      next += 1;
      return `id-${String(next)}`;
    },
    ...options,
  });
}

describe('apiFromDocument', () => {
  it('names the API from its title and takes the first server as the base URL', async () => {
    const { api, summary } = await mapped('servers');

    expect(api.name).toBe('Servers');
    // Slugs keep their display case, as every other project slug does.
    expect(api.slug).toBe('Servers');
    // The first server's variables are substituted; the third has no default, so it stays a template
    // the user can see and fill in.
    expect(api.baseUrl).toBe('https://acme.api.test/v2');
    expect(api.servers).toEqual([
      { url: 'https://acme.api.test/v2', description: 'Tenanted' },
      { url: 'https://sandbox.api.test/v2', description: 'Sandbox' },
      { url: 'https://{region}.api.test', description: 'No default for its variable' },
    ]);
    expect(summary.apiVersion).toBe('2.1.0');
    expect(summary.declaredVersion).toBe('3.0.3');
  });

  it('lets the caller override the name, base URL and order', async () => {
    const { api, summary } = await mapped('servers', { name: '  Sandbox  ', baseUrl: 'https://mine.test', order: 4 });

    expect(api.name).toBe('Sandbox');
    expect(api.slug).toBe('Sandbox');
    expect(api.baseUrl).toBe('https://mine.test');
    expect(api.order).toBe(4);
    expect(summary.name).toBe('Sandbox');
    expect(summary.title).toBe('Servers');
  });

  it('builds one request per operation, with its parameters in their own tables', async () => {
    const { api, summary } = await mapped('parameters');

    expect(api.requests).toEqual([]);
    expect(api.folders).toHaveLength(1);
    const folder = api.folders[0];
    expect(folder?.name).toBe('Pets');
    const request = folder?.requests[0];
    expect(request?.name).toBe('Read one photo');
    expect(request?.method).toBe('GET');
    expect(request?.url).toBe('/pets/{petId}/photos/{photoId}');
    // The operation's own `petId` beat the path-level one; every path parameter is enabled.
    expect(request?.pathParams).toEqual([
      { name: 'petId', value: 'p-override', enabled: true },
      { name: 'photoId', value: '7', enabled: true },
    ]);
    // Required query rows arrive enabled, optional ones present and switched off.
    expect(request?.query).toEqual([
      { name: 'size', value: 'small', enabled: true },
      { name: 'tag', value: '', enabled: false, description: 'Optional, so the row arrives disabled' },
    ]);
    // Every header parameter arrives switched off: an import never changes what goes on the wire.
    expect(request?.headers).toEqual([
      { name: 'X-Shared', value: 'shared', enabled: false },
      { name: 'X-Trace', value: 'trace-1', enabled: false },
    ]);
    expect(summary.skipped).toContainEqual({
      kind: 'parameter',
      where: 'GET /pets/{petId}/photos/{photoId}',
      reason: 'Cookie parameter "session" is not imported',
    });
  });

  it('maps each body media type onto the body kind that edits it', async () => {
    const { api } = await mapped('bodies');
    const byName = new Map(api.folders.flatMap((folder) => folder.requests).map((request) => [request.name, request]));

    // An example on the media type is the body, verbatim where it is already text.
    expect(byName.get('JSON with an example')?.body).toEqual({
      kind: 'raw',
      language: 'json',
      text: '{\n  "name": "Fido"\n}',
    });
    // Named examples: the first, in document order.
    expect(byName.get('postJsonExamples')?.body).toEqual({
      kind: 'raw',
      language: 'json',
      text: '{\n  "pick": "me"\n}',
    });
    // No example at all: a sample from the schema, required properties only.
    expect(byName.get('postJsonSample')?.body).toEqual({
      kind: 'raw',
      language: 'json',
      text: '{\n  "id": 0\n}',
    });
    expect(byName.get('postXml')?.body).toEqual({ kind: 'raw', language: 'xml', text: '<pet/>' });
    expect(byName.get('postForm')?.body).toEqual({
      kind: 'form',
      fields: [
        { name: 'grant_type', value: 'password', enabled: false },
        { name: 'username', value: '', enabled: false },
      ],
    });
    expect(byName.get('postMultipart')?.body).toEqual({
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'note', value: '', enabled: false },
        { kind: 'file', name: 'file', source: { kind: 'path', path: '' }, enabled: false },
      ],
    });
    // A binary media type is an empty Binary body with the type already set.
    expect(byName.get('putBinary')?.body).toEqual({
      kind: 'binary',
      source: { kind: 'path', path: '' },
      contentType: 'application/octet-stream',
    });
  });

  it('prefers JSON over the other media types an operation offers, and says what it left', async () => {
    const { api, summary } = await mapped('bodies');
    const request = api.folders
      .flatMap((folder) => folder.requests)
      .find((candidate) => candidate.name === 'Offers several media types at once');

    expect(request?.body).toEqual({ kind: 'raw', language: 'json', text: '{}' });
    expect(summary.skipped).toContainEqual({
      kind: 'media-type',
      where: 'POST /prefers-json',
      reason: 'Offers "text/plain" as well; imported as "application/json"',
    });
  });

  it('takes a single global security requirement as the API’s own credentials', async () => {
    const { api, summary } = await mapped('security');

    expect(api.auth).toEqual({ type: 'bearer' });
    expect(summary.auth).toBe('bearer');
    const byName = new Map(api.folders.flatMap((folder) => folder.requests).map((one) => [one.name, one]));
    // Same as the document's default: nothing to say, so the request inherits.
    expect(byName.get('getInherits')?.auth).toEqual({ type: 'inherit' });
    expect(byName.get('getBasic')?.auth).toEqual({ type: 'basic' });
    expect(byName.get('getApiKey')?.auth).toEqual({ type: 'api-key', name: 'api_key', in: 'query' });
    // `security: []` is a statement, and `none` is how this client makes it.
    expect(byName.get('getOpen')?.auth).toEqual({ type: 'none' });
  });

  it('maps an OAuth2 authorization-code flow, scopes and all, when asked for that scheme', async () => {
    const { api } = await mapped('security', { securityScheme: 'oauthCode' });

    expect(api.auth).toEqual({
      type: 'oauth2',
      grant: 'authorization-code',
      authorizationUrl: 'https://secure.test/oauth/authorize',
      tokenUrl: 'https://secure.test/oauth/token',
      clientId: '',
      scopes: ['read', 'write'],
      clientAuth: 'basic',
      pkce: true,
    });
  });

  it('maps a client-credentials flow without PKCE, which it has no use for', async () => {
    const { api } = await mapped('security', { securityScheme: 'oauthClient' });

    expect(api.auth).toEqual({
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: 'https://secure.test/oauth/token',
      clientId: '',
      scopes: ['read'],
      clientAuth: 'basic',
      pkce: false,
    });
  });

  it('says so rather than guessing when a scheme has no equivalent here', async () => {
    const cookie = await mapped('security', { securityScheme: 'apiKeyCookie' });
    expect(cookie.api.auth).toBeUndefined();
    expect(cookie.summary.skipped).toContainEqual({
      kind: 'security-scheme',
      where: 'apiKeyCookie',
      reason: 'An API key in a cookie is not supported',
    });

    const openId = await mapped('security', { securityScheme: 'openId' });
    expect(openId.api.auth).toBeUndefined();
    expect(openId.summary.skipped).toContainEqual({
      kind: 'security-scheme',
      where: 'openId',
      reason: 'Security scheme type "openIdConnect" is not supported',
    });
  });

  it('files a deprecated operation under its tag, and an untagged one under Deprecated', async () => {
    const { api, summary } = await mapped('deprecated');

    expect(api.folders.map((folder) => [folder.name, folder.requests.map((request) => request.name)])).toEqual([
      ['Pets', ['listPets', 'listPetsOld']],
      ['Deprecated', ['untaggedOld']],
    ]);
    expect(api.folders[0]?.description).toBe('Everything about pets');
    expect(api.folders[0]?.requests[1]?.description).toBe('**Deprecated.**');
    expect(summary.deprecated).toBe(2);
    expect(summary.folders).toBe(2);
    expect(summary.requests).toBe(3);
  });

  it('gives every entity its own id, and a unique slug within its container', async () => {
    const { api } = await mapped('deprecated');

    const ids = [
      api.id,
      ...api.folders.map((folder) => folder.id),
      ...api.folders.flatMap((folder) => folder.requests.map((request) => request.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(api.folders.map((folder) => folder.slug)).toEqual(['Pets', 'Deprecated']);
    expect(api.folders[0]?.requests.map((request) => request.slug)).toEqual(['listPets', 'listPetsOld']);
  });

  it('names a request after its summary, its operation id, or what it does', async () => {
    const { api } = await mapped('v31');
    expect(api.folders[0]?.requests[0]?.name).toBe('createPet');

    const bodies = await mapped('bodies');
    const names = bodies.api.folders.flatMap((folder) => folder.requests.map((request) => request.name));
    expect(names).toContain('JSON with an example');
  });

  it('records the definition the caller cached, and the sample preferences it was given', async () => {
    const definition = { source: 'https://bodies.test/openapi.yaml', cache: true, version: '3.0.3' };
    const { api } = await mapped('bodies', { definition, includeOptional: true, sampleValues: true });

    expect(api.definition).toEqual(definition);
    const sample = api.folders
      .flatMap((folder) => folder.requests)
      .find((request) => request.name === 'postJsonSample');
    // `includeOptional` reaches the generated body: the optional `note` is there to be edited.
    expect(sample?.body).toEqual({ kind: 'raw', language: 'json', text: '{\n  "id": 0,\n  "note": ""\n}' });
  });
});
