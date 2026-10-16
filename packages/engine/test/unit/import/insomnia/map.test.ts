import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InsomniaError } from '../../../../src/errors.js';
import type { MappedClientImport } from '../../../../src/import/client-import.js';
import { flattenEnvironment, mapInsomnia } from '../../../../src/import/insomnia/map.js';
import { importInsomnia } from '../../../../src/import/insomnia/import.js';
import { MAX_INSOMNIA_BYTES } from '../../../../src/import/insomnia/model.js';
import { parseInsomnia } from '../../../../src/import/insomnia/parse.js';
import type { RestRequestDef } from '../../../../src/rest/model.js';
import { apiRequests } from '../../../../src/rest/model.js';
import { insomniaFixture } from './fixtures.js';

function mapText(text: string): MappedClientImport {
  let n = 0;
  return mapInsomnia(parseInsomnia(text), { newId: () => `id${String((n += 1))}` });
}

/** A v5 collection of `collection` items, mapped. */
function v5(collection: unknown[], extra: Record<string, unknown> = {}): MappedClientImport {
  return mapText(JSON.stringify({ type: 'collection.insomnia.rest/5.0', name: 'W', collection, ...extra }));
}

let ids = 0;
function req(over: Record<string, unknown>): Record<string, unknown> {
  ids += 1;
  return {
    name: `R${String(ids)}`,
    method: 'GET',
    url: 'https://a.example.com/x',
    meta: { id: `req_${String(ids)}` },
    ...over,
  };
}

function onlyRequest(mapped: MappedClientImport): RestRequestDef {
  const requests = apiRequests(mapped.collections[0]!.rest!);
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

const all = (mapped: MappedClientImport): string[] => [...mapped.report.warnings, ...mapped.report.notes];

describe('mapInsomnia: requests', () => {
  it('keeps the URL query, appends the parameters with disabled kept, and fills path parameters', () => {
    const request = onlyRequest(
      v5([
        req({
          url: '{{ _.base }}/users/:id?sort=asc',
          parameters: [
            { name: 'page', value: '2' },
            { name: 'debug', value: '1', disabled: true },
          ],
          pathParameters: [{ name: 'id', value: '42' }],
        }),
      ]),
    );
    expect(request.query).toEqual([
      { name: 'sort', value: 'asc', enabled: true },
      { name: 'page', value: '2', enabled: true },
      { name: 'debug', value: '1', enabled: false },
    ]);
    expect(request.pathParams).toEqual([{ name: 'id', value: '42', enabled: true }]);
    expect(request.url).toContain('{id}');
  });

  it('copies folder headers onto requests that do not set them, and says so', () => {
    const mapped = v5([
      {
        name: 'F',
        meta: { id: 'fld_1' },
        headers: [
          { name: 'X-Tenant', value: 'acme' },
          { name: 'Accept', value: 'text/plain' },
        ],
        children: [req({ headers: [{ name: 'accept', value: 'application/json' }] })],
      },
    ]);
    expect(onlyRequest(mapped).headers).toEqual([
      { name: 'accept', value: 'application/json', enabled: true },
      { name: 'X-Tenant', value: 'acme', enabled: true },
    ]);
    expect(mapped.report.notes).toContain(
      'F: its headers were copied onto the requests below it that do not set them.',
    );
  });

  it('maps each body kind and adds a Content-Type a raw body implies', () => {
    const mapped = v5([
      req({ name: 'json', method: 'POST', body: { mimeType: 'application/json', text: '{"a":1}' } }),
      req({ name: 'xml', method: 'POST', body: { mimeType: 'application/xml', text: '<a/>' } }),
      req({ name: 'edn', method: 'POST', body: { mimeType: 'application/edn', text: '{:a 1}' } }),
      req({
        name: 'form',
        method: 'POST',
        body: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'a', value: '1', disabled: true }] },
      }),
      req({
        name: 'multi',
        method: 'POST',
        body: {
          mimeType: 'multipart/form-data',
          params: [
            { name: 'note', value: 'hi', type: 'text', multiline: 'text/markdown' },
            { name: 'doc', value: '', type: 'file', fileName: '/tmp/a.pdf' },
          ],
        },
      }),
      req({ name: 'bin', method: 'PUT', body: { mimeType: 'application/octet-stream', fileName: '/tmp/b.bin' } }),
      req({ name: 'empty', body: {} }),
    ]);
    const byName = new Map(apiRequests(mapped.collections[0]!.rest!).map((r) => [r.name, r]));
    expect(byName.get('json')?.body).toMatchObject({ kind: 'raw', language: 'json', text: '{"a":1}' });
    expect(byName.get('json')?.headers).toContainEqual({
      name: 'Content-Type',
      value: 'application/json',
      enabled: true,
    });
    expect(byName.get('xml')?.body).toMatchObject({ kind: 'raw', language: 'xml' });
    expect(byName.get('edn')?.headers).toContainEqual({
      name: 'Content-Type',
      value: 'application/edn',
      enabled: true,
    });
    expect(byName.get('form')?.body).toEqual({ kind: 'form', fields: [{ name: 'a', value: '1', enabled: false }] });
    expect(byName.get('multi')?.body).toMatchObject({
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'note', value: 'hi', contentType: 'text/markdown' },
        { kind: 'file', name: 'doc' },
      ],
    });
    expect(byName.get('bin')?.body).toMatchObject({ kind: 'binary' });
    expect(byName.get('empty')?.body).toEqual({ kind: 'none' });
    expect(mapped.report.notes).toContain(
      'multi: the file part "doc" points at /tmp/a.pdf, which is not in the export.',
    );
    expect(mapped.report.notes).toContain('bin: its body is the file /tmp/b.bin, which is not in the export.');
  });

  it('reads a GraphQL body with object, string and unparseable variables', () => {
    const gql = (name: string, variables: unknown, operationName?: string): Record<string, unknown> =>
      req({
        name,
        method: 'POST',
        body: {
          mimeType: 'application/graphql',
          text: JSON.stringify({ query: 'query Q { a }', variables, ...(operationName ? { operationName } : {}) }),
        },
      });
    const mapped = v5([
      gql('object', { id: '1' }, 'Q'),
      gql('string', '{"id":"2"}'),
      gql('template', '{"id": {{ _.id }}}'),
    ]);
    const body = new Map(apiRequests(mapped.collections[0]!.rest!).map((r) => [r.name, r.body]));
    expect(body.get('object')).toEqual({
      kind: 'graphql',
      query: 'query Q { a }',
      variables: '{\n  "id": "1"\n}',
      operationName: 'Q',
    });
    expect(body.get('string')).toMatchObject({ kind: 'graphql', variables: '{\n  "id": "2"\n}' });
    expect(body.get('template')).toMatchObject({ kind: 'graphql', variables: '{"id": ${id}}' });
  });

  it('keeps a body that is not a GraphQL document as JSON text', () => {
    const mapped = v5([
      req({ name: 'G', method: 'POST', body: { mimeType: 'application/graphql', text: 'not json' } }),
    ]);
    expect(onlyRequest(mapped).body).toMatchObject({ kind: 'raw', language: 'json', text: 'not json' });
  });

  it('keeps an event-stream request as a REST request with its header', () => {
    const request = onlyRequest(v5([req({ headers: [{ name: 'Accept', value: 'text/event-stream' }] })]));
    expect(request.headers).toEqual([{ name: 'Accept', value: 'text/event-stream', enabled: true }]);
  });

  it('maps follow-redirects and URL encoding, and notes the settings it cannot keep', () => {
    const mapped = v5([
      req({
        name: 'S',
        settings: {
          followRedirects: 'off',
          encodeUrl: false,
          cookies: { send: false, store: true },
          rebuildPath: false,
        },
      }),
    ]);
    expect(onlyRequest(mapped).settings).toEqual({ followRedirects: false, encodeUrl: false });
    expect(mapped.report.notes).toContain(
      'S: Wirebench does not keep its settings for not sending cookies, not normalising the URL path.',
    );
  });
});

describe('mapInsomnia: auth', () => {
  const authOf = (authentication: unknown): { auth: unknown; mapped: MappedClientImport } => {
    const mapped = v5([req({ name: 'A', authentication })]);
    return { auth: onlyRequest(mapped).auth, mapped };
  };

  it.each([
    [
      { type: 'basic', username: 'u', password: '{{ _.pw }}' },
      { type: 'basic', username: 'u' },
    ],
    [{ type: 'bearer', token: 't', prefix: '' }, { type: 'bearer' }],
    [
      { type: 'bearer', token: 't', prefix: 'Token' },
      { type: 'bearer', scheme: 'Token' },
    ],
    [
      { type: 'bearer', token: 't', prefix: 'NO_PREFIX' },
      { type: 'api-key', name: 'Authorization', in: 'header' },
    ],
    [
      { type: 'digest', username: 'd', password: 'x' },
      { type: 'digest', username: 'd' },
    ],
    [
      { type: 'ntlm', username: 'n', password: 'x' },
      { type: 'ntlm', username: 'n' },
    ],
    [
      { type: 'apikey', key: 'k', value: 'v', addTo: 'queryParams' },
      { type: 'api-key', name: 'k', in: 'query' },
    ],
    [
      { type: 'apikey', key: 'k', value: 'v', addTo: 'header' },
      { type: 'api-key', name: 'k', in: 'header' },
    ],
    [
      { type: 'iam', accessKeyId: 'a', secretAccessKey: 's', region: 'eu-west-1', service: 'execute-api' },
      { type: 'aws-sigv4', region: 'eu-west-1', service: 'execute-api' },
    ],
    [
      { type: 'oauth2', grantType: 'client_credentials', accessTokenUrl: 'https://id/t', clientId: 'c', scope: 'a b' },
      { type: 'oauth2', grant: 'client-credentials', tokenUrl: 'https://id/t', clientId: 'c', scopes: ['a', 'b'] },
    ],
    [
      { type: 'oauth2', grantType: 'authorization_code', usePkce: true, accessTokenUrl: 'https://id/t' },
      { type: 'oauth2', grant: 'authorization-code', pkce: true },
    ],
    [{ type: 'none' }, { type: 'none' }],
    [{}, { type: 'inherit' }],
    [{ type: 'basic', username: 'u', disabled: true }, { type: 'inherit' }],
  ])('maps %j', (authentication, expected) => {
    expect(authOf(authentication).auth).toMatchObject(expected);
  });

  it.each(['oauth1', 'hawk', 'asap', 'netrc', 'singleToken'])('sets %s to none and names it', (type) => {
    const { auth, mapped } = authOf({ type });
    expect(auth).toEqual({ type: 'none' });
    expect(mapped.report.warnings.some((w) => w.includes(`"${type.toLowerCase()}"`))).toBe(true);
  });

  it('sets an API key sent in a cookie to none, with a warning', () => {
    const { auth, mapped } = authOf({ type: 'apikey', key: 'k', value: 'v', addTo: 'cookie' });
    expect(auth).toEqual({ type: 'none' });
    expect(mapped.report.warnings).toContain(
      'A: its API key goes in a cookie, which Wirebench API-key auth does not do; set to "none".',
    );
  });

  it('never keeps a literal credential', () => {
    const { mapped } = authOf({ type: 'basic', username: 'u', password: 'hunter2' });
    expect(JSON.stringify(mapped)).not.toContain('hunter2');
  });

  it('gives a folder its auth', () => {
    const mapped = v5([
      { name: 'F', meta: { id: 'fld_1' }, authentication: { type: 'bearer', token: 't' }, children: [req({})] },
    ]);
    expect(mapped.collections[0]!.rest!.folders[0]!.auth).toEqual({ type: 'bearer' });
  });
});

describe('mapInsomnia: gRPC and WebSocket', () => {
  it('maps a gRPC request with TLS, service and method, and notes it needs a definition in v5', () => {
    const mapped = v5([
      req({}),
      {
        name: 'Get',
        meta: { id: 'greq_1' },
        url: 'grpcs://grpc.example.com:8443',
        protoMethodName: '/orders.v1.Orders/Get',
        body: { text: '{"id": "{{ _.id }}"}' },
        metadata: [{ name: 'x-trace', value: '1', disabled: true }],
        reflectionApi: { enabled: true, url: 'https://buf.build' },
      },
    ]);
    const grpc = mapped.collections[0]!.grpc!;
    expect(grpc).toMatchObject({ name: 'W (gRPC)', target: 'grpc.example.com:8443', tls: true });
    expect(grpc.requests[0]).toMatchObject({
      service: 'orders.v1.Orders',
      method: 'Get',
      message: '{"id": "${id}"}',
      metadata: [{ name: 'x-trace', value: '1', enabled: false }],
    });
    expect(mapped.collections[0]!.grpcProtos).toBeUndefined();
    expect(all(mapped)).toContain(
      'W (gRPC): needs a definition: Insomnia does not export .proto files, so import its .proto or use server reflection.',
    );
    expect(all(mapped)).toContain(
      'Get: it used server reflection; turn reflection on in the gRPC API if the server offers it.',
    );
  });

  it('attaches the v4 proto files a gRPC request points at', () => {
    const entry = mapText(insomniaFixture('v4.json')).collections[0]!;
    expect(entry.grpcProtos?.roots).toEqual(['protos/orders.proto']);
    expect(entry.grpcProtos?.sources.get('protos/orders.proto')).toContain('service Orders');
    expect(entry.grpc?.folders[0]?.requests[0]).toMatchObject({ service: 'orders.v1.Orders', method: 'GetOrder' });
  });

  it('keeps the v4 WebSocket payload as a saved message', () => {
    const ws = mapText(insomniaFixture('v4.json')).collections[0]!.websocket!;
    expect(ws.requests[0]?.messages).toEqual([
      expect.objectContaining({ name: 'Payload', content: '{"hello":"world"}' }),
    ]);
  });

  it('notes that v5 exports no WebSocket messages', () => {
    const mapped = mapText(insomniaFixture('v5-collection.yaml'));
    expect(mapped.collections[0]!.websocket!.requests[0]?.messages).toEqual([]);
    expect(mapped.report.notes).toContain(
      'Insomnia does not export WebSocket messages, so the WebSocket requests have none.',
    );
  });
});

describe('mapInsomnia: environments', () => {
  it('turns the base environment into project properties, flattened in its property order', () => {
    const mapped = mapText(insomniaFixture('v5-collection.yaml'));
    expect(mapped.variables.projectProperties?.variables.map((v) => [v.name, v.value])).toEqual([
      ['baseUrl', 'https://api.example.com'],
      ['tenant', 'base'],
      ['db.host', 'localhost'],
      ['db.port', '5432'],
    ]);
  });

  it('lets the first definition of a folder variable win, and says so', () => {
    const mapped = mapText(insomniaFixture('v5-collection.yaml'));
    expect(mapped.variables.report.notes).toContain(
      'Project properties: "tenant" is defined more than once (folder "Orders"); the first value was kept.',
    );
  });

  it('turns a sub-environment into a workspace environment with its colour', () => {
    const [staging] = mapText(insomniaFixture('v5-collection.yaml')).variables.environments;
    expect(staging).toMatchObject({ name: 'Staging', color: '#ff8800' });
  });

  it('brings a vault secret as a named secret with no value, never a plain property', () => {
    const [staging] = mapText(insomniaFixture('v5-collection.yaml')).variables.environments;
    expect(staging?.variables).toContainEqual({
      name: 'svcPassword',
      value: '',
      enabled: true,
      secret: true,
      awaitsValue: true,
    });
    expect(staging?.variables.some((v) => v.name === '__insomnia_vault' || v.value.includes('••'))).toBe(false);
  });

  it('points a vault reference at its secret', () => {
    const mapped = v5([req({ headers: [{ name: 'X-Key', value: '{{ _.vault.apiKey }}' }] })], {
      environments: { name: 'Base', data: { __insomnia_vault: { apiKey: 'sealed' } } },
    });
    expect(onlyRequest(mapped).headers).toEqual([{ name: 'X-Key', value: '${apiKey}', enabled: true }]);
    expect(mapped.variables.projectProperties?.variables).toEqual([
      { name: 'apiKey', value: '', enabled: true, secret: true, awaitsValue: true },
    ]);
  });

  it('lists the vault secrets once, each with its environment', () => {
    const mapped = v5([req({})], {
      environments: {
        name: 'Base',
        data: { __insomnia_vault: { apiKey: 'sealed' } },
        subEnvironments: [{ name: 'Staging', meta: { id: 'env_s' }, data: { __insomnia_vault: { pw: 'sealed' } } }],
      },
    });
    const { warnings, notes } = mapped.variables.report;
    expect([...warnings, ...notes, ...all(mapped)].filter((line) => line.includes('Vault secrets'))).toEqual([
      'Vault secrets are not in the export; set a value for: apiKey (Base), pw (Staging)',
    ]);
  });

  it('merges an environment file into Globals, sub-environments as environments, a bad colour dropped', () => {
    const mapped = mapText(insomniaFixture('v5-environment.yaml'));
    expect(mapped.collections).toEqual([]);
    expect(mapped.variables.globals?.variables.map((v) => [v.name, v.value])).toEqual([
      ['region', 'eu-west-1'],
      ['retries', '3'],
    ]);
    expect(mapped.variables.environments.map((e) => [e.name, e.color])).toEqual([
      ['Development', undefined],
      ['Production', '#cc0000'],
    ]);
    expect(mapped.variables.report.notes).toContain(
      'Environment "Development": its colour "green" is not a #rrggbb value, so it was left out.',
    );
  });

  it('flattens nested values and arrays to dotted names', () => {
    expect(flattenEnvironment({ users: [{ id: 7 }], on: true, none: null })).toEqual([
      ['users.0.id', '7'],
      ['on', 'true'],
      ['none', ''],
    ]);
  });
});

describe('mapInsomnia: scripts and the report', () => {
  it('saves request and folder scripts as text and attaches none', () => {
    const mapped = mapText(insomniaFixture('v5-collection.yaml'));
    expect(mapped.scripts.map((s) => s.path)).toEqual([
      'imported-scripts/orders api/orders.pre.js',
      'imported-scripts/orders api/orders-create order.pre.js',
      'imported-scripts/orders api/orders-create order.post.js',
    ]);
    expect(apiRequests(mapped.collections[0]!.rest!).every((r) => r.scripts === undefined)).toBe(true);
    expect(mapped.counts.scripts).toBe(3);
    expect(mapped.report.warnings).toContain(
      'The saved scripts call insomnia.; Wirebench does not run them. Port what they do to Wirebench scripts by hand.',
    );
  });

  it('reports the cookie jar, test suites, Socket.IO and the request chaining tag', () => {
    const mapped = mapText(insomniaFixture('v4.json'));
    expect(all(mapped)).toEqual(
      expect.arrayContaining([
        "The cookie jar's 1 cookie was not imported: cookies are session state, and the jar fills on the first send.",
        'The unit test suite "Smoke" was not imported ("creates an order" on Orders / Create order); write its checks as assertions or scripts.',
        'Live feed: Socket.IO requests have no Wirebench equivalent, so it was not imported.',
        '{% response %} was kept as written in Orders / Latest order (chained); Wirebench does not run it. To pass a value from one response to the next request, use a sequence transfer.',
      ]),
    );
  });

  it('reports an embedded API spec', () => {
    expect(mapText(insomniaFixture('v5-spec.yaml')).report.notes).toContain(
      'The API spec in this workspace was not imported; import it on its own as OpenAPI.',
    );
  });

  it('keeps a filter as written and names it', () => {
    const mapped = v5([req({ name: 'F', url: '{{ _.base | upcase }}/x' })]);
    expect(onlyRequest(mapped).url).toContain('{{ _.base | upcase }}');
    expect(mapped.report.warnings).toContain(
      '{{ _.base | upcase }} was kept as written in F; Wirebench does not run it.',
    );
  });

  it('maps two workspaces to two entries, their report lines prefixed', () => {
    const mapped = mapText(insomniaFixture('v4-two-workspaces.json'));
    expect(mapped.collections.map((c) => c.name)).toEqual(['Billing', 'Shipping']);
    expect(mapped.counts).toMatchObject({ collections: 2, requests: 2 });
    expect(mapped.variables.projectProperties?.variables).toEqual([
      { name: 'region', value: 'eu', enabled: true, secret: false },
    ]);
  });

  it('refuses an export with nothing to import', () => {
    expect(() => v5([])).toThrow(InsomniaError);
    try {
      v5([]);
    } catch (error) {
      expect((error as InsomniaError).code).toBe('insomnia-nothing-to-import');
    }
  });
});

describe('mapInsomnia: credentials outside REST', () => {
  const socket = (over: Record<string, unknown>): Record<string, unknown> => ({
    name: 'Echo',
    meta: { id: 'ws-req_1' },
    url: 'wss://echo.example.com/ws',
    ...over,
  });
  const grpcCall = (over: Record<string, unknown>): Record<string, unknown> => ({
    name: 'Get',
    meta: { id: 'greq_1' },
    url: 'grpc.example.com:443',
    protoMethodName: '/pkg.Svc/M',
    reflectionApi: { enabled: false },
    ...over,
  });

  it('warns about a WebSocket bearer token beside REST requests, and copies no token', () => {
    const mapped = v5([req({}), socket({ authentication: { type: 'bearer', token: 's3cr3t-ws-token' } })]);
    expect(mapped.collections[0]!.rest).toBeDefined();
    expect(mapped.report.warnings).toContain(
      'Credentials are not copied from gRPC and WebSocket requests; re-enter them for 1 auth configuration',
    );
    expect(JSON.stringify(mapped)).not.toContain('s3cr3t-ws-token');
  });

  it('drops literal credential headers and metadata with the warning, and keeps references', () => {
    const mapped = v5([
      socket({
        headers: [
          { name: 'Authorization', value: 'Bearer LEAK-ws-auth' },
          { name: 'Cookie', value: 'session=LEAK-cookie' },
          { name: 'X-API-Key', value: '{{ _.key }}' },
          { name: 'X-Trace', value: 't' },
        ],
      }),
      grpcCall({
        metadata: [
          { name: 'authorization', value: 'Bearer LEAK-grpc-token' },
          { name: 'Proxy-Authorization', value: 'Basic LEAK-proxy' },
        ],
      }),
    ]);
    const entry = mapped.collections[0]!;
    expect(entry.websocket!.requests[0]!.headers.map((h) => [h.name, h.value])).toEqual([
      ['X-API-Key', '${key}'],
      ['X-Trace', 't'],
    ]);
    expect(entry.grpc!.requests[0]!.metadata).toEqual([]);
    expect(mapped.report.warnings).toContain(
      'Credentials are not copied from the export; re-enter them for 4 auth configurations',
    );
    expect(mapped.report.notes).toContain('Echo: the value of "Cookie" is a credential and was not imported.');
    expect(mapped.report.notes).toContain('Get: the value of "authorization" is a credential and was not imported.');
    expect(JSON.stringify(mapped)).not.toContain('LEAK');
  });

  it('drops a credential header a folder passes down to its WebSocket requests', () => {
    const mapped = v5([
      {
        name: 'F',
        meta: { id: 'fld_1' },
        headers: [{ name: 'Authorization', value: 'Bearer LEAK-folder' }],
        children: [socket({})],
      },
    ]);
    expect(JSON.stringify(mapped)).not.toContain('LEAK');
  });
});

describe('mapInsomnia: credential header values (R8)', () => {
  const kept = (value: string): boolean => {
    const mapped = v5([
      {
        name: 'Echo',
        meta: { id: 'ws-req_1' },
        url: 'wss://echo.example.com/ws',
        headers: [{ name: 'Authorization', value }],
      },
    ]);
    return mapped.collections[0]!.websocket!.requests[0]!.headers.length === 1;
  };

  it('keeps references alone, or one scheme word beside references, in any case', () => {
    expect(kept('{{ _.token }}')).toBe(true);
    expect(kept('Bearer {{ _.token }}')).toBe(true);
    expect(kept('basic {{ _.creds }}')).toBe(true);
    expect(kept('Bearer')).toBe(true);
  });

  it('drops a literal token after the scheme word', () => {
    expect(kept('Bearer abc')).toBe(false);
  });

  it('drops literal text joined to a reference', () => {
    expect(kept('{{ _.token }}x')).toBe(false);
  });
});

describe('importInsomnia: size', () => {
  it('refuses a file past the size cap with insomnia-too-large, before reading it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insomnia-'));
    const path = join(dir, 'big.json');
    writeFileSync(path, '');
    truncateSync(path, MAX_INSOMNIA_BYTES + 1);
    try {
      await expect(importInsomnia({ kind: 'file', path }, { newId: () => 'id' })).rejects.toMatchObject({
        code: 'insomnia-too-large',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mapInsomnia: .proto files at one path', () => {
  it('keeps the first file at a clashing path no request uses, and warns', () => {
    const mapped = mapText(
      JSON.stringify({
        __export_format: 4,
        resources: [
          { _id: 'wrk_1', parentId: null, name: 'W', scope: 'collection', _type: 'workspace' },
          {
            _id: 'pf_1',
            parentId: 'wrk_1',
            _type: 'proto_file',
            name: 'svc.proto',
            metaSortKey: 1,
            protoText: 'syntax = "proto3"; package a; service A {}',
          },
          {
            _id: 'pf_2',
            parentId: 'wrk_1',
            _type: 'proto_file',
            name: 'svc',
            metaSortKey: 2,
            protoText: 'syntax = "proto3"; package b; service B {}',
          },
          {
            _id: 'pf_3',
            parentId: 'wrk_1',
            _type: 'proto_file',
            name: 'other.proto',
            metaSortKey: 3,
            protoText: 'syntax = "proto3"; package c; service C {}',
          },
          {
            _id: 'greq_1',
            parentId: 'wrk_1',
            _type: 'grpc_request',
            name: 'G',
            url: 'grpc://h:1',
            protoFileId: 'pf_3',
            protoMethodName: '/b.B/M',
          },
        ],
      }),
    );
    const protos = mapped.collections[0]!.grpcProtos!;
    expect([...protos.sources.keys()]).toEqual(['svc.proto', 'other.proto']);
    expect(protos.sources.get('svc.proto')).toContain('package a');
    expect(mapped.report.warnings).toContain('W: two .proto files share the path svc.proto; the first was kept.');
  });
});

describe('mapInsomnia: credentials in WebSocket and gRPC URLs', () => {
  it('cuts WebSocket user info and blanks literal credential query values, counting each', () => {
    const mapped = v5([
      {
        name: 'Echo',
        meta: { id: 'ws-req_1' },
        url: 'wss://u:LEAK-userinfo@ws.example.com/p?access_token=LEAK-query&q=1&key={{ _.k }}',
        parameters: [
          { name: 'api_key', value: 'LEAK-param' },
          { name: 'page', value: '2' },
        ],
      },
    ]);
    const entry = mapped.collections[0]!;
    const request = entry.websocket!.requests[0]!;
    expect(request.url).toBe('wss://ws.example.com/p');
    expect(entry.websocket!.url).toBe('wss://ws.example.com/p');
    expect(request.query.map((q) => [q.name, q.value])).toEqual([
      ['access_token', ''],
      ['q', '1'],
      ['key', '${k}'],
      ['api_key', ''],
      ['page', '2'],
    ]);
    expect(JSON.stringify(mapped)).not.toContain('LEAK');
    expect(mapped.report.notes).toContain('Echo: the credential in the URL was not imported.');
    expect(mapped.report.notes).toContain('Echo: the value of "access_token" is a credential and was not imported.');
    expect(mapped.report.notes).toContain('Echo: the value of "api_key" is a credential and was not imported.');
    expect(mapped.report.warnings).toContain(
      'Credentials are not copied from the export; re-enter them for 3 auth configurations',
    );
  });

  it('cuts user info from a gRPC URL, with or without a scheme', () => {
    for (const url of ['grpcs://u:LEAK-grpc@grpc.example.com:8443', 'u:LEAK-grpc@grpc.example.com:8443']) {
      const mapped = v5([
        {
          name: 'Get',
          meta: { id: 'greq_1' },
          url,
          protoMethodName: '/pkg.Svc/M',
          reflectionApi: { enabled: false },
        },
      ]);
      expect(mapped.collections[0]!.grpc!.target).toBe('grpc.example.com:8443');
      expect(JSON.stringify(mapped)).not.toContain('LEAK');
      expect(mapped.report.notes).toContain('Get: the credential in the URL was not imported.');
    }
  });
});

describe('mapInsomnia: credential header names', () => {
  const headersOf = (name: string): string[] =>
    v5([
      {
        name: 'Echo',
        meta: { id: 'ws-req_1' },
        url: 'wss://echo.example.com/ws',
        headers: [
          { name, value: 'LEAK-literal' },
          { name: 'X-Trace', value: 't' },
        ],
      },
    ]).collections[0]!.websocket!.requests[0]!.headers.map((h) => h.name);

  it('drops any credential-looking name, as the other importers judge it', () => {
    for (const name of ['X-Auth-Token', 'Api-Key', 'Authorization '])
      expect(headersOf(name), name).toEqual(['X-Trace']);
  });
});

describe('mapInsomnia: .proto clash and a referenced file', () => {
  it('keeps the file a request references over the earlier one, and warns', () => {
    const mapped = mapText(
      JSON.stringify({
        __export_format: 4,
        resources: [
          { _id: 'wrk_1', parentId: null, name: 'W', scope: 'collection', _type: 'workspace' },
          {
            _id: 'pf_1',
            parentId: 'wrk_1',
            _type: 'proto_file',
            name: 'svc.proto',
            metaSortKey: 1,
            protoText: 'package a;',
          },
          { _id: 'pf_2', parentId: 'wrk_1', _type: 'proto_file', name: 'svc', metaSortKey: 2, protoText: 'package b;' },
          {
            _id: 'greq_1',
            parentId: 'wrk_1',
            _type: 'grpc_request',
            name: 'G',
            url: 'grpc://h:1',
            protoFileId: 'pf_2',
            protoMethodName: '/b.B/M',
          },
        ],
      }),
    );
    expect(mapped.collections[0]!.grpcProtos!.sources.get('svc.proto')).toBe('package b;');
    expect(mapped.report.warnings).toContain(
      'W: two .proto files share the path svc.proto; the one a request uses was kept.',
    );
  });
});

describe('mapInsomnia: hostile environment data', () => {
  it('refuses a self-referencing YAML anchor in environment data as insomnia-malformed', () => {
    const source = [
      'type: collection.insomnia.rest/5.0',
      'name: W',
      'collection: []',
      'environments:',
      '  name: Base',
      '  data: &d',
      '    a: 1',
      '    self: *d',
      '',
    ].join('\n');
    let code: string | undefined;
    try {
      mapText(source);
    } catch (error) {
      expect(error).toBeInstanceOf(InsomniaError);
      code = (error as InsomniaError).code;
    }
    expect(code).toBe('insomnia-malformed');
  }, 10000);
});
