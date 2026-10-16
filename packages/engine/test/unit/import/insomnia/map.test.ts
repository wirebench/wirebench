import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MappedClientImport } from '../../../../src/import/client-import.js';
import { mapInsomnia } from '../../../../src/import/insomnia/map.js';
import { MAX_INSOMNIA_BYTES } from '../../../../src/import/insomnia/model.js';
import { parseInsomnia } from '../../../../src/import/insomnia/parse.js';
import { importInsomnia } from '../../../../src/import/insomnia/import.js';
import { folderRequests } from '../../../../src/rest/model.js';
import type { RestRequestDef } from '../../../../src/rest/model.js';

type Json = Record<string, unknown>;

function counter(): () => string {
  let n = 0;
  return () => `id-${String((n += 1))}`;
}

const ws = { _id: 'wrk_1', parentId: null, name: 'W', scope: 'collection', _type: 'workspace' };

function req(over: Json): Json {
  return {
    _id: 'req_1',
    parentId: 'wrk_1',
    _type: 'request',
    name: 'R',
    method: 'GET',
    url: 'https://api.example.com/x',
    ...over,
  };
}

function v4(resources: Json[], workspace: Json = ws): string {
  return JSON.stringify({ _type: 'export', __export_format: 4, resources: [workspace, ...resources] });
}

function mapV4(resources: Json[], workspace: Json = ws): MappedClientImport {
  return mapInsomnia(parseInsomnia(v4(resources, workspace)), { newId: counter() });
}

function mapV5(yaml: string): MappedClientImport {
  return mapInsomnia(parseInsomnia(yaml), { newId: counter() });
}

function restRequests(mapped: MappedClientImport): RestRequestDef[] {
  return folderRequests(mapped.collections[0]!.rest!);
}

function onlyRequest(over: Json, more: Json[] = []): RestRequestDef {
  return restRequests(mapV4([req(over), ...more]))[0]!;
}

function allLines(mapped: MappedClientImport): string[] {
  return [
    ...mapped.report.warnings,
    ...mapped.report.notes,
    ...mapped.variables.report.warnings,
    ...mapped.variables.report.notes,
  ];
}

const V5_HEAD = `type: collection.insomnia.rest/5.0
schema_version: "5.1"
name: Five
meta:
  id: wrk_5
`;

describe('mapInsomnia: requests through the v2.1 mapper', () => {
  it('maps the URL, its query, appended parameters and path parameters', () => {
    const request = onlyRequest({
      url: 'https://api.example.com/orders/:id?a=1',
      parameters: [
        { name: 'dryRun', value: 'true', disabled: true },
        { name: 'expand', value: 'items' },
      ],
      pathParameters: [{ name: 'id', value: '42' }],
    });
    expect(request.url).toBe('/orders/{id}');
    expect(request.query.map((q) => [q.name, q.value, q.enabled])).toEqual([
      ['a', '1', true],
      ['dryRun', 'true', false],
      ['expand', 'items', true],
    ]);
    expect(request.pathParams.map((p) => [p.name, p.value])).toEqual([['id', '42']]);
  });

  it('a multipart file part keeps its path and a text part its content type', () => {
    const request = onlyRequest({
      method: 'POST',
      body: {
        mimeType: 'multipart/form-data',
        params: [
          { name: 'note', value: 'n', multiline: 'text/plain', type: 'text' },
          { name: 'file', value: '', fileName: '/Users/dev/invoice.pdf', type: 'file' },
        ],
      },
    });
    expect(request.body).toEqual({
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'note', value: 'n', enabled: true, contentType: 'text/plain' },
        { kind: 'file', name: 'file', source: { kind: 'path', path: '/Users/dev/invoice.pdf' }, enabled: true },
      ],
    });
  });

  it('a GraphQL body keeps query, variables and operation name', () => {
    const request = onlyRequest({
      method: 'POST',
      body: {
        mimeType: 'application/graphql',
        text: JSON.stringify({ query: 'query Q { a }', variables: { id: '{{ _.id }}' }, operationName: 'Q' }),
      },
    });
    expect(request.body).toEqual({
      kind: 'graphql',
      query: 'query Q { a }',
      variables: '{\n  "id": "${id}"\n}',
      operationName: 'Q',
    });
  });

  it('templates become Wirebench references', () => {
    const request = onlyRequest({ headers: [{ name: 'X-Id', value: '{{ _.db.host }} {% uuid %}' }] });
    expect(request.headers.map((h) => h.value)).toEqual(['${db.host} ${$guid}']);
  });

  it('settings: redirects and URL encoding map', () => {
    expect(onlyRequest({ settingFollowRedirects: 'off' }).settings.followRedirects).toBe(false);
    expect(onlyRequest({ settingFollowRedirects: 'on' }).settings.followRedirects).toBe(true);
    expect(onlyRequest({ settingFollowRedirects: 'global' }).settings.followRedirects).toBeUndefined();
    expect(onlyRequest({ settingEncodeUrl: false }).settings.encodeUrl).toBe(false);
  });

  it('a text/event-stream request stays a REST request', () => {
    const mapped = mapV4([req({ headers: [{ name: 'Accept', value: 'text/event-stream' }] })]);
    expect(mapped.collections[0]!.rest).toBeDefined();
    expect(restRequests(mapped)[0]!.headers.map((h) => [h.name, h.value])).toEqual([['Accept', 'text/event-stream']]);
  });
});

describe('mapInsomnia: auth', () => {
  const auth = (authentication: Json): RestRequestDef['auth'] => onlyRequest({ authentication }).auth;

  it('maps each supported type', () => {
    expect(auth({ type: 'basic', username: 'u', password: 'p' })).toEqual({ type: 'basic', username: 'u' });
    expect(auth({ type: 'bearer', token: 't' })).toEqual({ type: 'bearer' });
    expect(auth({ type: 'bearer', token: 't', prefix: 'Token' })).toEqual({ type: 'bearer', scheme: 'Token' });
    expect(auth({ type: 'digest', username: 'u', password: 'p' })).toEqual({ type: 'digest', username: 'u' });
    expect(auth({ type: 'ntlm', username: 'u', password: 'p' })).toEqual({ type: 'ntlm', username: 'u' });
    expect(auth({ type: 'apikey', key: 'X-Key', value: 'v', addTo: 'header' })).toEqual({
      type: 'api-key',
      name: 'X-Key',
      in: 'header',
    });
    expect(auth({ type: 'apikey', key: 'k', value: 'v', addTo: 'queryParams' })).toEqual({
      type: 'api-key',
      name: 'k',
      in: 'query',
    });
    expect(
      auth({
        type: 'oauth2',
        grantType: 'client_credentials',
        accessTokenUrl: 'https://auth.example.com/token',
        clientId: 'cid',
        clientSecret: 'cs',
        scope: 'a b',
      }),
    ).toEqual({
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid',
      scopes: ['a', 'b'],
      clientAuth: 'basic',
      pkce: false,
    });
    expect(auth({ type: 'iam', accessKeyId: 'AK', secretAccessKey: 'SK', region: 'eu-west-1', service: 's3' })).toEqual(
      { type: 'aws-sigv4', region: 'eu-west-1', service: 's3' },
    );
  });

  it('bearer NO_PREFIX keeps the raw token: an API key in Authorization', () => {
    expect(auth({ type: 'bearer', token: 't', prefix: 'NO_PREFIX' })).toEqual({
      type: 'api-key',
      name: 'Authorization',
      in: 'header',
    });
  });

  it('{} and disabled inherit; none stops inheritance', () => {
    expect(auth({})).toEqual({ type: 'inherit' });
    expect(auth({ type: 'basic', username: 'u', disabled: true })).toEqual({ type: 'inherit' });
    expect(auth({ type: 'none' })).toEqual({ type: 'none' });
  });

  it('oauth1, hawk, asap, netrc and singleToken are none with the type named', () => {
    for (const type of ['oauth1', 'hawk', 'asap', 'netrc', 'singleToken']) {
      const mapped = mapV4([req({ authentication: { type } })]);
      expect(restRequests(mapped)[0]!.auth).toEqual({ type: 'none' });
      expect(mapped.report.warnings).toContain(`R: Insomnia auth type "${type}" is not supported; set to "none".`);
    }
  });

  it('no credential value is copied', () => {
    const mapped = mapV4([req({ authentication: { type: 'basic', username: 'u', password: 'hunter2' } })]);
    expect(JSON.stringify(mapped.collections)).not.toContain('hunter2');
    expect(mapped.report.warnings.some((w) => w.includes('Credentials are not copied'))).toBe(true);
  });
});

describe('mapInsomnia: gRPC', () => {
  const grpc = (over: Json): Json => ({
    _id: 'greq_1',
    parentId: 'wrk_1',
    _type: 'grpc_request',
    name: 'Get',
    url: 'grpcs://grpc.example.com:8443',
    protoMethodName: '/orders.v1.Orders/GetOrder',
    body: { text: '{"id": "{{ _.id }}"}' },
    metadata: [
      { name: 'x-a', value: '1' },
      { name: 'x-b', value: '2', disabled: true },
    ],
    ...over,
  });

  it('grpcs:// sets TLS, the method path gives service and method, metadata maps with disabled', () => {
    const mapped = mapV4([grpc({})]);
    const api = mapped.collections[0]!.grpc!;
    expect(api.name).toBe('W');
    expect(api.target).toBe('grpc.example.com:8443');
    expect(api.tls).toBe(true);
    const request = api.requests[0]!;
    expect([request.service, request.method, request.message]).toEqual([
      'orders.v1.Orders',
      'GetOrder',
      '{"id": "${id}"}',
    ]);
    expect(request.metadata.map((m) => [m.name, m.enabled])).toEqual([
      ['x-a', true],
      ['x-b', false],
    ]);
  });

  it('a v4 proto file is attached through protos, with its directory siblings', () => {
    const mapped = mapV4([
      { _id: 'pd_1', parentId: 'wrk_1', _type: 'proto_directory', name: 'protos' },
      { _id: 'pf_1', parentId: 'pd_1', _type: 'proto_file', name: 'orders.proto', protoText: 'syntax = "proto3";' },
      {
        _id: 'pf_2',
        parentId: 'pd_1',
        _type: 'proto_file',
        name: 'common.proto',
        protoText: 'syntax = "proto3"; // c',
      },
      { _id: 'pf_3', parentId: 'wrk_1', _type: 'proto_file', name: 'other.proto', protoText: 'unused' },
      grpc({ protoFileId: 'pf_1' }),
    ]);
    expect(mapped.protos).toEqual([
      { name: 'orders.proto', text: 'syntax = "proto3";' },
      { name: 'common.proto', text: 'syntax = "proto3"; // c' },
    ]);
    expect(allLines(mapped).some((l) => l.includes('needs a definition'))).toBe(false);
  });

  it('a v5 gRPC request reports that the API has no definition', () => {
    const mapped = mapV5(`${V5_HEAD}collection:
  - url: grpc.example.com:443
    name: Get
    meta: { id: greq_1 }
    protoFileId: pf_1
    protoMethodName: /pkg.Svc/M
    reflectionApi: { enabled: false }
`);
    expect(mapped.protos).toEqual([]);
    expect(mapped.report.notes).toContain(
      'Five: Insomnia v5 exports hold no .proto files, so the API has no definition: import its .proto or use server reflection.',
    );
  });

  it('server reflection is noted', () => {
    const mapped = mapV4([grpc({ reflectionApi: { enabled: true, url: 'https://reflect.example.com' } })]);
    expect(mapped.report.notes).toContain(
      'Get: it read its definition by server reflection; turn reflection on for the API or import its .proto.',
    );
  });

  it('a folder auth is not given to its gRPC requests, whose metadata carries theirs', () => {
    const mapped = mapV4([
      {
        _id: 'fld_1',
        parentId: 'wrk_1',
        _type: 'request_group',
        name: 'F',
        authentication: { type: 'bearer', token: 't' },
      },
      grpc({ parentId: 'fld_1' }),
    ]);
    expect(mapped.collections[0]!.grpc!.folders[0]!.auth).toBeUndefined();
  });

  it('several kinds suffix the API names', () => {
    const mapped = mapV4([req({}), grpc({})]);
    expect(mapped.collections[0]!.rest!.name).toBe('W');
    expect(mapped.collections[0]!.grpc!.name).toBe('W (gRPC)');
  });
});

describe('mapInsomnia: WebSocket', () => {
  const socket = {
    _id: 'ws-req_1',
    parentId: 'wrk_1',
    _type: 'websocket_request',
    name: 'Echo',
    url: 'wss://echo.example.com/ws?room=1',
    headers: [{ name: 'X-Token', value: '{{ _.token }}' }],
    parameters: [{ name: 'v', value: '2' }],
  };

  it('a v4 payload becomes one saved message; URL, headers and params map', () => {
    const mapped = mapV4([
      socket,
      { _id: 'ws-payload_1', parentId: 'ws-req_1', _type: 'websocket_payload', name: 'P', value: '{"hello":"world"}' },
    ]);
    const api = mapped.collections[0]!.websocket!;
    const request = api.requests[0]!;
    expect(request.url).toBe('wss://echo.example.com/ws');
    expect(request.query.map((q) => [q.name, q.value])).toEqual([
      ['room', '1'],
      ['v', '2'],
    ]);
    expect(request.headers.map((h) => [h.name, h.value])).toEqual([['X-Token', '${token}']]);
    expect(request.messages.map((m) => m.content)).toEqual(['{"hello":"world"}']);
  });

  it('v5 notes that payloads are not exported', () => {
    const mapped = mapV5(`${V5_HEAD}collection:
  - url: wss://echo.example.com/ws
    name: Echo
    meta: { id: ws-req_1 }
`);
    expect(mapped.collections[0]!.websocket!.requests[0]!.messages).toEqual([]);
    expect(mapped.report.notes).toContain(
      'Five: Insomnia v5 exports hold no WebSocket messages, so none were imported.',
    );
  });
});

describe('mapInsomnia: environments', () => {
  const base = (data: Json, more: Json = {}): Json => ({
    _id: 'env_1',
    parentId: 'wrk_1',
    _type: 'environment',
    name: 'Base Environment',
    data,
    ...more,
  });
  const sub = (id: string, name: string, data: Json, more: Json = {}): Json => ({
    _id: id,
    parentId: 'env_1',
    _type: 'environment',
    name,
    data,
    ...more,
  });
  const plain = (name: string, value: string) => ({ name, value, enabled: true, secret: false });

  it('the base environment becomes project properties, nested values flattened', () => {
    const mapped = mapV4([
      req({}),
      base({ baseUrl: 'https://api.example.com', db: { host: 'h', port: 5432 }, on: true, ids: [1] }),
    ]);
    expect(mapped.variables.projectProperties?.variables).toEqual([
      plain('baseUrl', 'https://api.example.com'),
      plain('db.host', 'h'),
      plain('db.port', '5432'),
      plain('on', 'true'),
      plain('ids.0', '1'),
    ]);
  });

  it('dataPropertyOrder sets the order', () => {
    const mapped = mapV4([
      req({}),
      base(
        { b: '2', a: '1', db: { port: 1, host: 'h' } },
        { dataPropertyOrder: { '&': ['db', 'a', 'b'], '&~|db': ['host', 'port'] } },
      ),
    ]);
    expect(mapped.variables.projectProperties?.variables.map((v) => v.name)).toEqual(['db.host', 'db.port', 'a', 'b']);
  });

  it('sub-environments become workspace environments with a #rrggbb colour kept and another dropped', () => {
    const mapped = mapV4([
      req({}),
      base({}),
      sub('env_2', 'Staging', { baseUrl: 'https://staging.example.com' }, { color: '#ff8800', metaSortKey: 1 }),
      sub('env_3', 'Prod', { baseUrl: '{{ _.host }}' }, { color: 'red', metaSortKey: 2 }),
    ]);
    expect(mapped.variables.environments).toEqual([
      { name: 'Staging', color: '#ff8800', variables: [plain('baseUrl', 'https://staging.example.com')] },
      { name: 'Prod', variables: [plain('baseUrl', '${host}')] },
    ]);
    expect(mapped.variables.report.notes).toContain('Prod: its colour "red" is not a #rrggbb value and was not kept.');
  });

  it('folder environments are project properties, outermost first, the first definition winning', () => {
    const mapped = mapV4([
      base({ tenant: 'base' }),
      {
        _id: 'fld_1',
        parentId: 'wrk_1',
        _type: 'request_group',
        name: 'Outer',
        environment: { tenant: 'outer', a: '1' },
      },
      { _id: 'fld_2', parentId: 'fld_1', _type: 'request_group', name: 'Inner', environment: { a: '2', b: '3' } },
      req({ parentId: 'fld_2' }),
    ]);
    expect(mapped.variables.projectProperties?.variables).toEqual([
      plain('tenant', 'base'),
      plain('a', '1'),
      plain('b', '3'),
    ]);
    expect(mapped.variables.report.notes).toContain(
      'Project properties: "tenant" is defined more than once (folder "Outer"); the first value was kept.',
    );
  });

  it('a vault secret arrives as a named secret with no value, never a plain property', () => {
    const mapped = mapV4([
      req({ authentication: { type: 'basic', username: 'u', password: '{{ _.vault.svcPassword }}' } }),
      base({}),
      sub('env_2', 'Staging', { __insomnia_vault: { svcPassword: 'c2VhbGVk' } }),
    ]);
    const staging = mapped.variables.environments[0]!;
    expect(staging.variables).toEqual([{ name: 'svcPassword', value: '', enabled: true, secret: true }]);
    expect(JSON.stringify(mapped)).not.toContain('c2VhbGVk');
    expect(mapped.variables.report.warnings).toContain(
      'Vault secrets cannot be read from an export: svcPassword (Staging). Each was imported as a secret with no value; set it in Environments.',
    );
    // `{{ _.vault.svcPassword }}` points at that secret by name.
    const text = JSON.stringify(mapped.collections[0]!.rest);
    expect(text).not.toContain('_.vault');
  });

  it('a vault reference in a header points at the secret by name', () => {
    const request = onlyRequest({ headers: [{ name: 'X-Key', value: '{{ _.vault.apiKey }}' }] });
    expect(request.headers.map((h) => h.value)).toEqual(['${apiKey}']);
  });

  it('an environment file merges its base into Globals and keeps sub-environments', () => {
    const mapped = mapV5(`type: environment.insomnia.rest/5.0
schema_version: "5.1"
name: Shared
meta: { id: wrk_e }
environments:
  name: Base
  meta: { id: env_1 }
  data: { region: eu }
  subEnvironments:
    - name: Dev
      meta: { id: env_2, sortKey: 1 }
      data: { host: dev.example.com }
`);
    expect(mapped.collections).toEqual([]);
    expect(mapped.variables.globals).toEqual({ name: 'Globals', variables: [plain('region', 'eu')] });
    expect(mapped.variables.environments).toEqual([{ name: 'Dev', variables: [plain('host', 'dev.example.com')] }]);
    expect(mapped.variables.projectProperties).toBeUndefined();
  });
});

describe('mapInsomnia: scripts', () => {
  it('request and folder scripts are saved as text, none attached, and the dialect is named', () => {
    const mapped = mapV4([
      {
        _id: 'fld_1',
        parentId: 'wrk_1',
        _type: 'request_group',
        name: 'Orders',
        preRequestScript: "console.log('folder')",
      },
      req({
        parentId: 'fld_1',
        name: 'Create order',
        preRequestScript: "insomnia.variables.set('a', 1)",
        afterResponseScript: 'insomnia.test("ok", () => {})',
      }),
    ]);
    expect(mapped.scripts.map((s) => [s.path, s.source])).toEqual([
      ['imported-scripts/w/orders.pre.js', "console.log('folder')"],
      ['imported-scripts/w/create order.pre.js', "insomnia.variables.set('a', 1)"],
      ['imported-scripts/w/create order.post.js', 'insomnia.test("ok", () => {})'],
    ]);
    expect(mapped.counts.scripts).toBe(3);
    const rest = mapped.collections[0]!.rest!;
    expect(folderRequests(rest)[0]!.scripts).toBeUndefined();
    expect(rest.folders[0]!.scripts).toBeUndefined();
    expect(mapped.report.warnings.some((w) => w.includes('insomnia.'))).toBe(true);
  });
});

describe('mapInsomnia: reported, not mapped', () => {
  it('reports the cookie jar, unit test suites with request names, and the API spec', () => {
    const mapped = mapV4([
      req({ _id: 'req_1', name: 'Create order' }),
      { _id: 'jar_1', parentId: 'wrk_1', _type: 'cookie_jar', name: 'Default Jar', cookies: [] },
      { _id: 'uts_1', parentId: 'wrk_1', _type: 'unit_test_suite', name: 'Smoke' },
      { _id: 'ut_1', parentId: 'uts_1', _type: 'unit_test', name: 't1', requestId: 'req_1', code: 'expect(1)' },
      { _id: 'ut_2', parentId: 'uts_1', _type: 'unit_test', name: 't2', requestId: 'req_1', code: 'expect(2)' },
      { _id: 'spc_1', parentId: 'wrk_1', _type: 'api_spec', contents: 'openapi: 3.0.0' },
    ]);
    const lines = allLines(mapped);
    expect(lines).toContain('W: its cookie jar was not imported; the jar fills on the first send.');
    expect(lines).toContain('W: the unit test suite "Smoke" was not imported; its tests check: Create order.');
    expect(lines.filter((l) => l.includes('unit test'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('API spec') && l.includes('OpenAPI'))).toBe(true);
  });

  it('reports a mock, a Socket.IO request and an MCP request', () => {
    const mapped = mapInsomnia(
      parseInsomnia(
        JSON.stringify({
          _type: 'export',
          __export_format: 4,
          resources: [
            ws,
            { _id: 'wrk_m', parentId: null, name: 'Mocks', scope: 'mock-server', _type: 'workspace' },
            req({}),
            { _id: 'socketio-req_1', parentId: 'wrk_1', _type: 'socketio_request', name: 'Chat', url: 'ws://x' },
            { _id: 'mcp-req_1', parentId: 'wrk_1', _type: 'mcp_request', name: 'Tools', url: 'http://x' },
          ],
        }),
      ),
    );
    const lines = allLines(mapped);
    expect(lines.some((l) => l.includes('mock server'))).toBe(true);
    expect(lines.some((l) => l.includes('Socket.IO') && l.includes('Chat'))).toBe(true);
    expect(lines.some((l) => l.includes('MCP') && l.includes('Tools'))).toBe(true);
  });

  it('reports each kept template tag with the requests using it', () => {
    const mapped = mapV4([
      req({ _id: 'req_1', name: 'A', headers: [{ name: 'X', value: "{% response 'body', 'req_2', '$.id' %}" }] }),
      req({ _id: 'req_2', name: 'B', url: "https://api.example.com/{% response 'body', 'req_1', '$.x' %}" }),
    ]);
    expect(mapped.report.warnings).toContain(
      'Kept as written, with no Wirebench equivalent: the template tag "response" in B, A.',
    );
  });
});

describe('mapInsomnia: credentials outside REST', () => {
  const socket = (over: Json): Json => ({
    _id: 'ws-req_1',
    parentId: 'wrk_1',
    _type: 'websocket_request',
    name: 'Echo',
    url: 'wss://echo.example.com/ws',
    ...over,
  });

  it('a WebSocket bearer token is warned about beside REST requests, and not copied', () => {
    const mapped = mapV4([req({}), socket({ authentication: { type: 'bearer', token: 's3cr3t-ws-token' } })]);
    expect(mapped.collections[0]!.websocket!.requests[0]!.auth).toEqual({ type: 'bearer' });
    expect(mapped.report.warnings).toContain(
      'Credentials are not copied from gRPC and WebSocket requests; re-enter them for 1 auth configuration',
    );
    expect(JSON.stringify(mapped)).not.toContain('s3cr3t-ws-token');
  });

  it('literal credential headers and metadata are dropped with the warning; references are kept', () => {
    const mapped = mapV4([
      socket({
        headers: [
          { name: 'Cookie', value: 'session=abc123' },
          { name: 'X-API-Key', value: '{{ _.key }}' },
          { name: 'X-Trace', value: 't' },
        ],
      }),
      {
        _id: 'greq_1',
        parentId: 'wrk_1',
        _type: 'grpc_request',
        name: 'Get',
        url: 'grpc.example.com:443',
        protoMethodName: '/pkg.Svc/M',
        metadata: [
          { name: 'authorization', value: 'Bearer lit3ral-grpc-token' },
          { name: 'Proxy-Authorization', value: 'Basic xyz' },
        ],
      },
    ]);
    const entry = mapped.collections[0]!;
    expect(entry.websocket!.requests[0]!.headers.map((h) => [h.name, h.value])).toEqual([
      ['X-API-Key', '${key}'],
      ['X-Trace', 't'],
    ]);
    expect(entry.grpc!.requests[0]!.metadata).toEqual([]);
    expect(mapped.report.warnings).toContain(
      'Credentials are not copied from the collection; re-enter them for 3 auth configurations',
    );
    expect(mapped.report.notes).toContain('Echo: the value of "Cookie" is a credential and was not imported.');
    const text = JSON.stringify(mapped);
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('lit3ral-grpc-token');
  });
});

describe('mapInsomnia: credential header values', () => {
  const kept = (value: string): boolean => {
    const mapped = mapV4([
      {
        _id: 'ws-req_1',
        parentId: 'wrk_1',
        _type: 'websocket_request',
        name: 'Echo',
        url: 'wss://echo.example.com/ws',
        headers: [{ name: 'Authorization', value }],
      },
    ]);
    return mapped.collections[0]!.websocket!.requests[0]!.headers.length === 1;
  };

  it('keeps a scheme word beside references', () => {
    expect(kept('Bearer {{ _.token }}')).toBe(true);
    expect(kept('basic {{ _.creds }}')).toBe(true);
  });

  it('drops a literal token after the scheme', () => {
    expect(kept('Bearer abc')).toBe(false);
  });

  it('drops literal text joined to a reference', () => {
    expect(kept('{{ _.token }}x')).toBe(false);
  });
});

describe('mapInsomnia: several workspaces', () => {
  it('prefixes request-labelled lines with the workspace name', () => {
    const mapped = mapInsomnia(
      parseInsomnia(
        JSON.stringify({
          _type: 'export',
          __export_format: 4,
          resources: [
            ws,
            { _id: 'wrk_2', parentId: null, name: 'Second', scope: 'collection', _type: 'workspace' },
            req({ authentication: { type: 'hawk' } }),
            req({
              _id: 'req_2',
              parentId: 'wrk_2',
              name: 'Other',
              headers: [{ name: 'X', value: '{% base64 "x" %}' }],
            }),
          ],
        }),
      ),
    );
    expect(mapped.report.warnings).toContain('W: R: Insomnia auth type "hawk" is not supported; set to "none".');
    expect(mapped.report.warnings).toContain(
      'Kept as written, with no Wirebench equivalent: the template tag "base64" in Second: Other.',
    );
  });
});

describe('importInsomnia', () => {
  it('reads text and maps it', async () => {
    const mapped = await importInsomnia({ kind: 'text', text: v4([req({})]) }, { newId: counter() });
    expect(mapped.counts.requests).toBe(1);
  });

  it('refuses a file past the size cap with insomnia-too-large', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insomnia-'));
    const path = join(dir, 'big.json');
    writeFileSync(path, '');
    truncateSync(path, MAX_INSOMNIA_BYTES + 1);
    try {
      await expect(importInsomnia({ kind: 'file', path })).rejects.toMatchObject({ code: 'insomnia-too-large' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file it cannot read with insomnia-read-failed', async () => {
    await expect(importInsomnia({ kind: 'file', path: '/nonexistent/insomnia.json' })).rejects.toMatchObject({
      code: 'insomnia-read-failed',
    });
  });
});
