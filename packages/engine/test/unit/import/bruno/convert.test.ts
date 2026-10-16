import { describe, expect, it } from 'vitest';
import { ocOfBrunoFolder } from '../../../../src/import/bruno/convert.js';
import type { OcItem } from '../../../../src/import/opencollection/model.js';
import { mapOpenCollection } from '../../../../src/import/opencollection/map.js';
import { brunoFiles } from './fixtures.js';

const converted = () => ocOfBrunoFolder(brunoFiles(), 'basic');

function find(items: readonly OcItem[], name: string): OcItem {
  for (const item of items) {
    if (item.info.name === name) return item;
    const inner = item.items !== undefined ? findOrUndefined(item.items, name) : undefined;
    if (inner !== undefined) return inner;
  }
  throw new Error(`no item ${name}`);
}

function findOrUndefined(items: readonly OcItem[], name: string): OcItem | undefined {
  try {
    return find(items, name);
  } catch {
    return undefined;
  }
}

/** A single request file, converted inside a collection of its own. */
function one(text: string, path = 'req.bru') {
  const { collection, report } = ocOfBrunoFolder(
    new Map([
      ['bruno.json', '{"name":"c"}'],
      [path, text],
    ]),
    'c',
  );
  return { item: collection.items[0], report };
}

describe('ocOfBrunoFolder: layout', () => {
  it('names the collection from bruno.json and reads collection.bru defaults', () => {
    const { collection } = converted();
    expect(collection.info.name).toBe('demo-collection');
    expect(collection.request).toMatchObject({
      headers: [{ name: 'X-Client', value: 'wirebench-demo' }],
      auth: { type: 'bearer', token: '{{#System#TOKEN}}' },
      variables: [
        { name: 'tenant', value: 'acme' },
        { name: 'legacy', value: 'on', disabled: true },
      ],
      scripts: [{ type: 'before-request', code: 'bru.setVar("startedAt", Date.now());' }],
    });
  });

  it('orders siblings by seq then name, a missing seq counting as 1', () => {
    const { collection } = converted();
    expect(collection.items.map((item) => item.info.name)).toEqual([
      'grpc',
      'lib.js',
      'misc',
      'ws',
      'Users',
      'Dashboard',
    ]);
    expect(find(collection.items, 'Users').items?.map((item) => item.info.name)).toEqual([
      'Create user',
      'Upload avatar',
      'User via GraphQL',
      'Get user',
    ]);
    expect(find(collection.items, 'misc').items?.map((item) => item.info.name)).toEqual(['Alpha', 'Purge cache']);
  });

  it("takes a folder's name and defaults from folder.bru, and names a folder without one after its directory", () => {
    const { collection } = converted();
    expect(find(collection.items, 'Users')).toMatchObject({
      info: { type: 'folder', seq: 2 },
      request: { headers: [{ name: 'X-Area', value: 'users' }], auth: 'inherit' },
    });
    expect(find(collection.items, 'misc').request).toBeUndefined();
  });

  it('reads environments/ as environments, never as requests, and drops bruno.json ignore paths', () => {
    const { collection } = converted();
    expect(collection.environments.map((env) => env.name)).toEqual(['Local', 'Prod']);
    expect(findOrUndefined(collection.items, 'Ignored')).toBeUndefined();
    expect(findOrUndefined(collection.items, 'environments')).toBeUndefined();
  });

  it("reports bruno.json's proxy, and never copies its password", () => {
    const { collection, report } = converted();
    expect(collection.configExtras).toEqual(['proxy']);
    expect(JSON.stringify({ collection, report })).not.toContain('proxy-pass-123');
  });

  it('reports a broken .bru file with its line, and the rest imports', () => {
    const { collection, report } = converted();
    expect(report.warnings).toContain(
      'broken.bru, line 7: expected "key: value"; the format has no comments. The file was skipped.',
    );
    expect(findOrUndefined(collection.items, 'Broken')).toBeUndefined();
    expect(find(collection.items, 'Create user').http).toBeDefined();
  });

  it('keeps a .js file as a script item', () => {
    expect(find(converted().collection.items, 'lib.js').script).toContain('module.exports');
  });
});

describe('ocOfBrunoFolder: HTTP requests', () => {
  it('takes the method from the verb block, and a custom one from http { method }', () => {
    const { collection } = converted();
    expect(find(collection.items, 'Create user').http?.['method']).toBe('POST');
    expect(find(collection.items, 'Purge cache').http?.['method']).toBe('PURGE');
  });

  it('takes the query from params:query only, never also from the URL, and :id values from params:path', () => {
    const http = find(converted().collection.items, 'Get user').http ?? {};
    expect(http['url']).toBe('{{baseUrl}}/users/:id');
    expect(http['params']).toEqual([
      { name: 'verbose', value: 'true', type: 'query' },
      { name: 'trace', value: '1', disabled: true, type: 'query' },
      { name: 'id', value: '{{userId}}', type: 'path' },
    ]);
  });

  it('uses only the body mode the verb block names, and notes another body block left in the file', () => {
    const { collection, report } = converted();
    expect(find(collection.items, 'Create user').http?.['body']).toEqual({
      type: 'json',
      data: '{\n  "name": "Ada",\n  "email": "ada@example.com"\n}',
    });
    expect(report.notes).toContain('Create user: its body:text block was left out; the request sends its json body.');
  });

  it('reads multipart text and file parts with their content types', () => {
    expect(find(converted().collection.items, 'Upload avatar').http?.['body']).toEqual({
      type: 'multipart-form',
      data: [
        { name: 'caption', type: 'text', value: 'Profile photo', contentType: 'text/plain' },
        { name: 'avatar', type: 'file', value: ['assets/avatar.png'], contentType: 'image/png' },
        { name: 'backup', type: 'file', value: ['assets/a.png', 'assets/b.png'], disabled: true },
      ],
    });
  });

  it.each([
    ['text', 'body:text {\n  hello\n}', { type: 'text', data: 'hello' }],
    ['xml', 'body:xml {\n  <a/>\n}', { type: 'xml', data: '<a/>' }],
    ['sparql', 'body:sparql {\n  SELECT 1\n}', { type: 'sparql', data: 'SELECT 1' }],
    [
      'formUrlEncoded',
      'body:form-urlencoded {\n  a: 1\n  ~b: 2\n}',
      {
        type: 'form-urlencoded',
        data: [
          { name: 'a', value: '1' },
          { name: 'b', value: '2', disabled: true },
        ],
      },
    ],
    [
      'file',
      'body:file {\n  file: @file(a.bin) @contentType(application/pdf)\n  ~file: @file(b.bin)\n}',
      {
        type: 'file',
        data: [
          { filePath: 'a.bin', contentType: 'application/pdf', selected: true },
          { filePath: 'b.bin', selected: false },
        ],
      },
    ],
  ])('reads a %s body', (mode, bodyBlock, expected) => {
    const { item } = one(`post {\n  url: http://h\n  body: ${mode}\n}\n\n${bodyBlock}\n`);
    expect(item?.http?.['body']).toEqual(expected);
  });

  it('reads a legacy body block as JSON', () => {
    const { item } = one('post {\n  url: http://h\n}\n\nbody {\n  {"a":1}\n}\n');
    expect(item?.http?.['body']).toEqual({ type: 'json', data: '{"a":1}' });
  });

  it('reads a GraphQL request with its variables', () => {
    const item = find(converted().collection.items, 'User via GraphQL');
    expect(item.info.type).toBe('graphql');
    expect(item.graphql?.['body']).toEqual({
      query: 'query User($id: ID!) {\n  user(id: $id) {\n    id\n  }\n}',
      variables: '{\n  "id": "{{userId}}"\n}',
    });
  });

  it('keeps the docs as the description, and the settings with omitHeaders', () => {
    const { collection } = converted();
    expect(find(collection.items, 'Create user').info.description).toBe('Creates a user in the given org.');
    const users = mapOpenCollection(collection).rest?.folders.find((f) => f.name === 'Users');
    expect(users?.requests[0]?.description).toBe('Creates a user in the given org.');
    expect(users?.requests.find((r) => r.name === 'Get user')?.settings.omitHeaders).toEqual(['User-Agent']);
    expect(find(collection.items, 'Get user').settings).toEqual({
      encodeUrl: false,
      timeout: 5000,
      followRedirects: false,
      maxRedirects: 3,
      omitHeaders: ['User-Agent'],
    });
  });

  it('reports request vars:pre-request through the mapper, and vars:post-response as needing a script or capture', () => {
    const { report } = converted();
    expect(report.warnings).toContain(
      'Create user: the post-response variables userId were not imported; they are read from the response, so set them with a script or a capture.',
    );
    const { item } = one('meta {\n  name: R\n}\nget {\n  url: http://h\n}\nvars:pre-request {\n  page: 2\n}\n');
    expect(item?.runtime?.variables).toEqual([{ name: 'page', value: '2' }]);
  });

  it('saves scripts and tests as runtime scripts', () => {
    expect(find(converted().collection.items, 'Create user').runtime?.scripts?.map((s) => s.type)).toEqual([
      'after-response',
      'tests',
    ]);
  });

  it('keeps a prompt variable as written and reports it', () => {
    const { collection, report } = converted();
    expect(String(find(collection.items, 'Purge cache').http?.['url'])).not.toContain('{{?');
    expect(report.warnings).toContain(
      'The prompt variables {{?Which key}} were kept as written; Wirebench does not ask for a value when it sends.',
    );
  });
});

describe('ocOfBrunoFolder: auth', () => {
  it('maps request auth with its block, digest included', () => {
    expect(find(converted().collection.items, 'Get user').http?.['auth']).toEqual({
      type: 'digest',
      username: 'admin',
      password: 'literal-digest-pass',
    });
  });

  it.each([
    ['basic', 'auth:basic {\n  username: u\n  password: p\n}', { type: 'basic', username: 'u', password: 'p' }],
    ['bearer', 'auth:bearer {\n  token: {{t}}\n}', { type: 'bearer', token: '{{t}}' }],
    [
      'apikey',
      'auth:apikey {\n  key: k\n  value: v\n  placement: queryparams\n}',
      { type: 'apikey', key: 'k', value: 'v', placement: 'query' },
    ],
    [
      'awsv4',
      'auth:awsv4 {\n  accessKeyId: a\n  secretAccessKey: s\n  service: s3\n  region: eu-west-1\n}',
      { type: 'awsv4', accessKeyId: 'a', secretAccessKey: 's', sessionToken: '', service: 's3', region: 'eu-west-1' },
    ],
    ['inherit', '', 'inherit'],
    ['none', '', 'none'],
    ['wsse', 'auth:wsse {\n  username: u\n}', { type: 'wsse' }],
    ['oauth1', '', { type: 'oauth1' }],
    ['akamai-edgegrid', '', { type: 'akamai-edgegrid' }],
  ])('maps %s auth', (mode, authBlock, expected) => {
    const { item } = one(`get {\n  url: http://h\n  auth: ${mode}\n}\n\n${authBlock}\n`);
    expect(item?.http?.['auth']).toEqual(expected);
  });

  it('maps OAuth 2 grants to their flows', () => {
    const { item } = one(
      'get {\n  url: http://h\n  auth: oauth2\n}\n\nauth:oauth2 {\n  grant_type: client_credentials\n  access_token_url: https://idp/token\n  client_id: app\n  client_secret: s3cr3t\n  scope: read write\n}\n',
    );
    expect(item?.http?.['auth']).toMatchObject({
      type: 'oauth2',
      flow: 'client_credentials',
      accessTokenUrl: 'https://idp/token',
      credentials: { clientId: 'app', clientSecret: 's3cr3t' },
      scope: 'read write',
    });
  });

  it('names the unsupported types through the mapper, and never copies a password', () => {
    const { collection } = converted();
    const mapped = mapOpenCollection(collection);
    expect(mapped.report.warnings).toContain(
      'Purge cache: wsse authentication is not supported and was imported as none.',
    );
    expect(JSON.stringify([mapped.rest, mapped.grpc, mapped.websocket])).not.toContain('literal-digest-pass');
  });
});

describe('ocOfBrunoFolder: assertions', () => {
  it('reads each line as expression, operator and value, a bare value meaning eq', () => {
    expect(find(converted().collection.items, 'Create user').runtime?.assertions).toEqual([
      { expression: 'res.status', operator: 'eq', value: '201' },
      { expression: 'res.body.name', operator: 'eq', value: 'Ada' },
      { expression: 'res.body.id', operator: 'isDefined', disabled: true },
      { expression: 'res.body.age', operator: 'between', value: '1, 10' },
    ]);
  });

  it('maps what fits and reports an operator Wirebench lacks', () => {
    const mapped = mapOpenCollection(converted().collection);
    const create = mapped.rest?.folders.find((f) => f.name === 'Users')?.requests[0];
    expect(create?.assertions).toEqual([
      { type: 'status', equals: 201 },
      { type: 'match', language: 'jsonpath', expression: '$.name', equals: 'Ada' },
    ]);
    expect(mapped.report.warnings).toContain(
      'Create user: the assertion "res.body.age between 1, 10" has no Wirebench equivalent and was not imported.',
    );
  });
});

describe('ocOfBrunoFolder: gRPC, WebSocket and app items', () => {
  it('reads gRPC with its metadata and first message, noting the others', () => {
    const { collection, report } = converted();
    expect(find(collection.items, 'SayHello').grpc).toEqual({
      url: '{{grpcHost}}',
      method: '/hello.HelloService/SayHello',
      methodType: 'unary',
      metadata: [{ name: 'x-request-id', value: '7' }],
      message: '{ "greeting": "hi" }',
      auth: 'inherit',
      protoFilePath: 'protos/hello.proto',
    });
    expect(report.notes).toContain('SayHello: only the first of its 2 gRPC messages was imported.');
  });

  it('reads WebSocket with each body:ws block a saved message', () => {
    const mapped = mapOpenCollection(converted().collection);
    const echo = mapped.websocket?.folders[0]?.requests[0];
    expect(echo?.url).toBe('wss://echo.example.com/socket');
    expect(echo?.messages.map((m) => [m.name, m.content])).toEqual([
      ['hello', '{"say": "hello"}'],
      ['bye', 'bye'],
    ]);
  });

  it('skips an app item and reports it', () => {
    const mapped = mapOpenCollection(converted().collection);
    expect(mapped.report.warnings).toContain('Dashboard: app items are not supported and were skipped.');
  });
});

describe('ocOfBrunoFolder: environments', () => {
  it('keeps ~ disabled vars, lists vars:secret names as secrets with no value, and rewrites process.env', () => {
    const local = converted().collection.environments[0];
    expect(local?.variables).toEqual([
      { name: 'baseUrl', value: 'http://localhost:8080' },
      { name: 'debugFlag', value: 'true', disabled: true },
      { name: 'apiToken', value: '{{#System#TOKEN}}' },
      { name: 'clientSecret', secret: true },
    ]);
  });

  it('reports extends and color', () => {
    expect(converted().collection.environments[1]?.extras).toEqual(['color', 'extends']);
  });
});
