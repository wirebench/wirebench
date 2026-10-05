import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ReportBuilder } from '../../../../src/import/report.js';
import { mapOcAuth } from '../../../../src/import/opencollection/auth.js';
import { mapOpenCollection } from '../../../../src/import/opencollection/map.js';
import { parseOpenCollection } from '../../../../src/import/opencollection/parse.js';
import type { RestBody, RestRequestDef } from '../../../../src/rest/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../../../../../fixtures');

function readFixture(rel: string): string {
  return readFileSync(resolve(fixtureDir, rel), 'utf8');
}

/** A one-off collection: `items` YAML indented under `items:`, optional root `request` YAML. */
function collection(items: string, request = ''): string {
  return `opencollection: "1.0.0"\ninfo:\n  name: Crafted\n${request}items:\n${items}`;
}

function mapText(text: string, rootDir?: string) {
  return mapOpenCollection(parseOpenCollection(text), rootDir !== undefined ? { rootDir } : {});
}

function only(text: string, rootDir?: string): { request: RestRequestDef; mapped: ReturnType<typeof mapText> } {
  const mapped = mapText(text, rootDir);
  const request = mapped.rest?.requests[0];
  if (request === undefined) throw new Error('no request');
  return { request, mapped };
}

function rawText(body: RestBody): string {
  if (body.kind !== 'raw') throw new Error(`not raw: ${body.kind}`);
  return body.text;
}

describe('mapOpenCollection — HTTP', () => {
  const mapped = mapOpenCollection(parseOpenCollection(readFixture('opencollection/crafted/single/collection.yml')));
  const users = mapped.rest!.folders[0]!;

  it('rebuilds folders and seq order', () => {
    expect(users.name).toBe('Users');
    expect(users.requests.map((r) => r.name)).toEqual(['Create User', 'Get User']);
  });

  it('maps url, path params and folder default headers', () => {
    const get = users.requests[1]!;
    expect(get.url).toBe('${baseUrl}/users/{id}');
    expect(get.pathParams.map((p) => p.name)).toEqual(['id']);
    expect(get.headers).toContainEqual(expect.objectContaining({ name: 'X-Team', value: 'core' }));
    expect(mapped.report.notes).toContain('Get User: folder and collection default headers were added.');
  });

  it('keeps a bearer token that is a reference as an Authorization header under folder bearer auth', () => {
    expect(users.auth).toEqual({ type: 'bearer' });
    expect(users.requests[1]?.headers).toContainEqual(
      expect.objectContaining({ name: 'Authorization', value: 'Bearer ${token}' }),
    );
    expect(users.requests[1]?.auth).toEqual({ type: 'inherit' });
    expect(mapped.report.notes).toContain(
      'Users: the credential reference was added as Authorization on each request below it.',
    );
  });

  it('uses the selected body variant and notes the others', () => {
    expect(users.requests[0]?.body).toMatchObject({ kind: 'raw', language: 'json', text: '{"name":"Rex"}' });
    expect(mapped.report.notes).toEqual(expect.arrayContaining([expect.stringContaining('empty')]));
  });

  it('turns a GraphQL item into a JSON POST with a note', () => {
    const graph = mapped.rest!.requests.find((r) => r.name === 'Graph')!;
    expect(graph.method).toBe('POST');
    expect(graph.url).toBe('${baseUrl}/graphql');
    expect(graph.body).toMatchObject({ kind: 'raw', language: 'json', contentType: 'application/json' });
    expect(JSON.parse(rawText(graph.body))).toEqual({ query: '{ pets { id } }', variables: {} });
    expect(mapped.report.notes).toEqual(expect.arrayContaining([expect.stringContaining('#77')]));
  });

  it('maps examples to response examples', () => {
    expect(users.requests[0]?.examples?.[0]).toMatchObject({
      name: 'created',
      status: 201,
      statusText: 'Created',
      contentType: 'application/json',
      body: '{"id":1}',
    });
  });

  it('names the API after the collection and counts requests and folders', () => {
    expect(mapped.rest).toMatchObject({ name: 'Pets', baseUrl: '', servers: [] });
    expect(mapped.counts).toEqual({ requests: 3, folders: 1, assertions: 0, assertionsSkipped: 0 });
    expect(mapped.variables).toEqual({ environments: [], report: { warnings: [], notes: [] } });
  });

  it('maps the directory form the same way', () => {
    const root = resolve(fixtureDir, 'opencollection/crafted/tree');
    const files = new Map<string, string>();
    for (const rel of [
      'Users/folder.yml',
      'Users/create-user.yml',
      'Users/get-user.yml',
      'graph.yml',
      'shared/helpers.yml',
    ]) {
      files.set(rel, readFileSync(resolve(root, rel), 'utf8'));
    }
    const tree = mapOpenCollection(
      parseOpenCollection(readFileSync(resolve(root, 'opencollection.yml'), 'utf8'), files),
    );
    expect(tree.rest?.folders.map((f) => f.name)).toEqual(['Users']);
    expect(tree.rest?.folders[0]?.requests.map((r) => r.url)).toEqual(['${baseUrl}/users', '${baseUrl}/users/{id}']);
  });

  it('builds no REST folder for a folder without REST items, and no API without REST items', () => {
    const m = mapText(
      collection(`  - info: { name: Only gRPC, type: folder }
    items:
      - info: { name: Ping, type: grpc }
        grpc: { url: "grpc://h:1", method: /a.B/C }
  - info: { name: Get, type: http }
    http: { method: get, url: "https://h/x" }
`),
    );
    expect(m.rest?.folders).toEqual([]);
    expect(m.rest?.requests[0]?.method).toBe('GET');
    expect(mapText(collection('  - info: { name: App, type: app }\n')).rest).toBeUndefined();
  });

  it('maps unsupported auth to none with a warning', () => {
    const report = new ReportBuilder();
    expect(mapOcAuth({ type: 'digest', username: 'u' }, 'X', report).auth).toEqual({ type: 'none' });
    expect(report.build().warnings).toEqual(['X: digest authentication is not supported and was imported as none.']);
  });
});

describe('mapOcAuth', () => {
  it('maps inherit, none and the supported types, dropping literal secrets with a warning', () => {
    const report = new ReportBuilder();
    expect(mapOcAuth(undefined, 'R', report).auth).toEqual({ type: 'inherit' });
    expect(mapOcAuth('inherit', 'R', report).auth).toEqual({ type: 'inherit' });
    expect(mapOcAuth({ type: 'none' }, 'R', report).auth).toEqual({ type: 'none' });
    expect(mapOcAuth({ type: 'basic', username: '{{user}}', password: 'hunter2' }, 'B', report).auth).toEqual({
      type: 'basic',
      username: '${user}',
    });
    expect(mapOcAuth({ type: 'bearer', token: 'abc123' }, 'T', report)).toEqual({ auth: { type: 'bearer' } });
    expect(mapOcAuth({ type: 'ntlm', username: 'u', password: 'p', domain: 'D' }, 'N', report).auth).toEqual({
      type: 'ntlm',
      username: 'u',
      domain: 'D',
    });
    expect(report.build().warnings).toEqual([
      'B: the basic credential was not imported; set it on the request or API.',
      'T: the bearer credential was not imported; set it on the request or API.',
      'N: the ntlm credential was not imported; set it on the request or API.',
    ]);
    expect(JSON.stringify(report.build())).not.toMatch(/hunter2|abc123/);
  });

  it('keeps a references-only API key as a header or query row', () => {
    const report = new ReportBuilder();
    expect(mapOcAuth({ type: 'apikey', key: 'X-Key', value: '{{key}}', placement: 'header' }, 'A', report)).toEqual({
      auth: { type: 'api-key', name: 'X-Key', in: 'header' },
      header: { name: 'X-Key', value: '${key}', enabled: true },
    });
    expect(mapOcAuth({ type: 'apikey', key: 'k', value: '{{key}}', placement: 'query' }, 'A', report).query).toEqual({
      name: 'k',
      value: '${key}',
      enabled: true,
    });
    expect(mapOcAuth({ type: 'apikey', key: 'k', value: 'literal' }, 'L', report)).toEqual({
      auth: { type: 'api-key', name: 'k', in: 'header' },
    });
    expect(report.build().warnings).toEqual([
      'L: the apikey credential was not imported; set it on the request or API.',
    ]);
  });

  it('maps OAuth 2 client credentials and authorization code, without the client secret', () => {
    const report = new ReportBuilder();
    expect(
      mapOcAuth(
        {
          type: 'oauth2',
          flow: 'client_credentials',
          accessTokenUrl: '{{idp}}/token',
          credentials: { clientId: 'app', clientSecret: 's3cret', placement: 'body' },
          scope: 'read write',
        },
        'O',
        report,
      ).auth,
    ).toEqual({
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: '${idp}/token',
      clientId: 'app',
      scopes: ['read', 'write'],
      clientAuth: 'body',
      pkce: false,
    });
    expect(
      mapOcAuth(
        {
          type: 'oauth2',
          flow: 'authorization_code',
          authorizationUrl: 'https://idp/authorize',
          accessTokenUrl: 'https://idp/token',
          credentials: { clientId: 'app' },
          pkce: { disabled: true },
        },
        'C',
        report,
      ).auth,
    ).toEqual({
      type: 'oauth2',
      grant: 'authorization-code',
      tokenUrl: 'https://idp/token',
      authorizationUrl: 'https://idp/authorize',
      clientId: 'app',
      scopes: [],
      clientAuth: 'basic',
      pkce: false,
    });
    expect(
      mapOcAuth(
        { type: 'oauth2', flow: 'resource_owner_password_credentials', resourceOwner: { password: 'p' } },
        'P',
        report,
      ).auth,
    ).toEqual({ type: 'none' });
    expect(report.build().warnings).toEqual([
      'O: the oauth2 credential was not imported; set it on the request or API.',
      'P: the oauth2 credential was not imported; set it on the request or API.',
      'P: OAuth 2 with the "resource_owner_password_credentials" flow is not supported and was imported as none.',
    ]);
    expect(JSON.stringify(report.build())).not.toContain('s3cret');
  });
});

describe('mapOpenCollection — credentials', () => {
  it('drops literal credential headers and blanks literal credential query, form and JSON values', () => {
    const { request, mapped } = only(
      collection(`  - info: { name: Login, type: http }
    http:
      method: POST
      url: "https://api.example.com/login?api_key=abc&page=2"
      headers:
        - { name: X-Api-Key, value: sk-live-1 }
        - { name: X-Session, value: "{{session}}" }
        - { name: Accept, value: application/json }
      params:
        - { name: page, value: "3", type: query }
      body:
        type: json
        data: '{"user":"rex","password":"hunter2"}'
`),
    );
    expect(request.url).toBe('https://api.example.com/login');
    expect(request.query).toEqual([
      { name: 'page', value: '3', enabled: true },
      { name: 'api_key', value: '', enabled: true },
    ]);
    expect(request.headers.map((h) => [h.name, h.value])).toEqual([
      ['X-Session', '${session}'],
      ['Accept', 'application/json'],
    ]);
    expect(JSON.parse(rawText(request.body))).toEqual({ user: 'rex', password: '' });
    expect(mapped.report.warnings).toContain(
      'Login: the recorded value of api_key, X-Api-Key, password was not imported; set it on the request.',
    );
    expect(JSON.stringify(mapped)).not.toMatch(/hunter2|sk-live-1|abc&/);
  });

  it('drops a literal Authorization header and takes bearer auth from it', () => {
    const { request, mapped } = only(
      collection(`  - info: { name: Me, type: http }
    http:
      method: GET
      url: "https://h/me"
      headers:
        - { name: Authorization, value: "Bearer eyJ.literal" }
`),
    );
    expect(request.headers).toEqual([]);
    expect(request.auth).toEqual({ type: 'bearer' });
    expect(mapped.report.warnings).toContain(
      'Me: the Authorization credential was not imported; set it on the request or API.',
    );
  });

  it('drops literal credentials from collection default headers on each request', () => {
    const { request, mapped } = only(
      collection(
        `  - info: { name: Ping, type: http }
    http: { method: GET, url: "https://h/ping" }
`,
        `request:\n  headers:\n    - { name: X-Auth-Token, value: literal }\n    - { name: X-Trace, value: "1" }\n    - { name: X-Off, value: "1", disabled: true }\n`,
      ),
    );
    expect(request.headers.map((h) => h.name)).toEqual(['X-Trace']);
    expect(mapped.report.warnings).toContain(
      'Ping: the recorded value of X-Auth-Token was not imported; set it on the request.',
    );
  });

  it('strips literal user info from the URL and keeps its user name as Basic auth', () => {
    const { request, mapped } = only(
      collection(`  - info: { name: Old, type: http }
    http: { method: GET, url: "https://rex:pw@h/x" }
`),
    );
    expect(request.url).toBe('https://h/x');
    expect(request.auth).toEqual({ type: 'basic', username: 'rex' });
    expect(mapped.report.warnings).toContain('Old: the credential in the URL was not imported; set it on the request.');
  });

  it('blanks literal credential form and multipart text values, keeping references', () => {
    const m = mapText(
      collection(`  - info: { name: Form, type: http }
    http:
      method: POST
      url: "https://h/f"
      body:
        type: form-urlencoded
        data:
          - { name: client_secret, value: literal }
          - { name: token, value: "{{token}}" }
          - { name: grant, value: x, disabled: true }
  - info: { name: Multi, type: http }
    http:
      method: POST
      url: "https://h/m"
      body:
        type: multipart-form
        data:
          - { name: password, type: text, value: literal }
          - { name: note, type: text, value: hi }
`),
    );
    const [form, multi] = m.rest!.requests;
    expect(form?.body).toEqual({
      kind: 'form',
      fields: [
        { name: 'client_secret', value: '', enabled: true },
        { name: 'token', value: '${token}', enabled: true },
        { name: 'grant', value: 'x', enabled: false },
      ],
    });
    expect(multi?.body).toEqual({
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'password', value: '', enabled: true },
        { kind: 'text', name: 'note', value: 'hi', enabled: true },
      ],
    });
  });

  it('adds a references-only API key query row to each request below the folder', () => {
    const m = mapText(
      collection(`  - info: { name: Keyed, type: folder }
    request:
      auth: { type: apikey, key: api_key, value: "{{key}}", placement: query }
    items:
      - info: { name: List, type: http }
        http: { method: GET, url: "https://h/l" }
      - info: { name: Own, type: http }
        http: { method: GET, url: "https://h/o", auth: { type: none } }
`),
    );
    const [list, own] = m.rest!.folders[0]!.requests;
    expect(list?.query).toEqual([{ name: 'api_key', value: '${key}', enabled: true }]);
    expect(own?.query).toEqual([]);
    expect(own?.auth).toEqual({ type: 'none' });
    expect(m.rest!.folders[0]!.auth).toEqual({ type: 'api-key', name: 'api_key', in: 'query' });
  });

  it('masks credentials in examples and drops their cookies', () => {
    const { request, mapped } = only(
      collection(`  - info: { name: Token, type: http }
    http: { method: POST, url: "https://h/t" }
    examples:
      - response:
          status: 200
          headers:
            - { name: Set-Cookie, value: sid=1 }
            - { name: X-Auth-Token, value: tok }
          body: { type: json, data: '{"access_token":"tok-123","ok":true}' }
      - name: no status
`),
    );
    const example = request.examples?.[0];
    expect(example?.name).toBe('200');
    expect(example?.contentType).toBe('application/json');
    expect(example?.headers.map((h) => h.name)).toEqual(['X-Auth-Token']);
    expect(example?.headers[0]?.value).not.toBe('tok');
    expect(example?.body).not.toContain('tok-123');
    expect(request.examples).toHaveLength(1);
    expect(mapped.report.notes).toEqual(
      expect.arrayContaining([
        'Token: credentials in a recorded response were masked in its example.',
        'Token: 1 example(s) without a response status were skipped.',
      ]),
    );
  });

  it('reports dynamic variables once, kept as written', () => {
    const m = mapText(
      collection(`  - info: { name: A, type: http }
    http:
      method: GET
      url: "https://h/{{$guid}}"
      headers: [{ name: X-Id, value: "{{$guid}}" }, { name: X-Ts, value: "{{$timestamp}}" }]
`),
    );
    expect(m.rest?.requests[0]?.url).toBe('https://h/{{$guid}}');
    expect(m.report.warnings.filter((w) => w.startsWith('Dynamic'))).toEqual([
      'Dynamic variables are kept as written and not expanded: $guid, $timestamp',
    ]);
  });
});

describe('mapOpenCollection — bodies and settings', () => {
  const files = collection(`  - info: { name: Upload, type: http }
    http:
      method: POST
      url: "https://h/u"
      body:
        type: multipart-form
        data:
          - { name: doc, type: file, value: [files/a.pdf, files/b.pdf], contentType: application/pdf }
  - info: { name: Binary, type: http }
    http:
      method: PUT
      url: "https://h/b"
      body:
        type: file
        data:
          - { filePath: files/one.bin, contentType: application/x-one, selected: false }
          - { filePath: /abs/two.bin, contentType: application/x-two, selected: true }
  - info: { name: Rel, type: http }
    http:
      method: PUT
      url: "https://h/r"
      body:
        type: file
        data:
          - { filePath: files/one.bin, contentType: application/x-one, selected: true }
`);

  it('resolves body file paths against the collection folder', () => {
    const m = mapText(files, '/work/pets');
    const [upload, binary, rel] = m.rest!.requests;
    expect(upload?.body).toEqual({
      kind: 'multipart',
      parts: [
        {
          kind: 'file',
          name: 'doc',
          source: { kind: 'path', path: '/work/pets/files/a.pdf' },
          enabled: true,
          contentType: 'application/pdf',
        },
      ],
    });
    expect(binary?.body).toEqual({
      kind: 'binary',
      source: { kind: 'path', path: '/abs/two.bin' },
      contentType: 'application/x-two',
    });
    expect(rel?.body).toMatchObject({ source: { kind: 'path', path: '/work/pets/files/one.bin' } });
    expect(m.report.notes).toContain('Upload: the file part "doc" lists 2 files; only the first was imported.');
    expect(m.report.warnings).toEqual([]);
  });

  it('keeps a relative body path and warns when there is no collection folder', () => {
    const m = mapText(files);
    expect(m.rest!.requests[2]?.body).toMatchObject({ source: { kind: 'path', path: 'files/one.bin' } });
    expect(m.report.warnings).toContain(
      'Rel: the body file files/one.bin is relative to the collection; check its path on the request.',
    );
  });

  it('maps xml, text and sparql bodies', () => {
    const m = mapText(
      collection(`  - info: { name: X, type: http }
    http: { method: POST, url: "https://h", body: { type: xml, data: "<a>{{v}}</a>" } }
  - info: { name: T, type: http }
    http: { method: POST, url: "https://h", body: { type: text, data: "hello" } }
  - info: { name: S, type: http }
    http: { method: POST, url: "https://h", body: { type: sparql, data: "SELECT * WHERE {}" } }
`),
    );
    expect(m.rest!.requests.map((r) => r.body)).toEqual([
      { kind: 'raw', language: 'xml', text: '<a>${v}</a>' },
      { kind: 'raw', language: 'text', text: 'hello' },
      { kind: 'raw', language: 'text', contentType: 'application/sparql-query', text: 'SELECT * WHERE {}' },
    ]);
  });

  it('maps the REST settings and notes the others', () => {
    const { request, mapped } = only(
      collection(`  - info: { name: Slow, type: http }
    http: { method: GET, url: "https://h" }
    settings: { timeout: 5000, followRedirects: false, maxRedirects: inherit, encodeUrl: true, omitHeaders: [X] }
`),
    );
    expect(request.settings).toEqual({ timeoutMs: 5000, followRedirects: false, encodeUrl: true });
    expect(mapped.report.notes).toContain(
      'Slow: the settings omitHeaders have no Wirebench equivalent and were ignored.',
    );
  });

  it('keeps unparsable GraphQL variables as a string and blanks credential variables', () => {
    const m = mapText(
      collection(`  - info: { name: G1, type: graphql }
    graphql: { url: "https://h/q", body: { query: "{ a }", variables: "not json" } }
  - info: { name: G2, type: graphql }
    graphql: { url: "https://h/q", body: { query: "{ a }", variables: '{"password":"pw","id":"{{id}}"}' } }
`),
    );
    const [g1, g2] = m.rest!.requests;
    expect(JSON.parse(rawText(g1!.body))).toEqual({ query: '{ a }', variables: 'not json' });
    expect(JSON.parse(rawText(g2!.body))).toEqual({ query: '{ a }', variables: { password: '', id: '${id}' } });
  });
});
