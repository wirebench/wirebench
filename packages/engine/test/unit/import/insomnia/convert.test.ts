import { describe, expect, it } from 'vitest';
import type { KeptTags } from '../../../../src/import/insomnia/convert.js';
import { v21OfInsomnia } from '../../../../src/import/insomnia/convert.js';
import { parseInsomnia } from '../../../../src/import/insomnia/parse.js';
import { ReportBuilder } from '../../../../src/import/report.js';
import type { ImportReport } from '../../../../src/import/report.js';

type Json = Record<string, unknown>;

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

function convert(resources: Json[]): { doc: Json; report: ImportReport; kept: KeptTags } {
  const parsed = parseInsomnia(JSON.stringify({ _type: 'export', __export_format: 4, resources: [ws, ...resources] }));
  const report = new ReportBuilder();
  const kept: KeptTags = new Map();
  const doc = v21OfInsomnia(parsed.workspaces[0]!, 'W', report, kept);
  return { doc, report: report.build(), kept };
}

function items(doc: Json): Json[] {
  return doc['item'] as Json[];
}

/** The `request` of the first request item, depth first. */
function firstRequest(doc: Json): Json {
  const walk = (list: Json[]): Json | undefined => {
    for (const item of list) {
      if (item['request'] !== undefined) return item;
      const inner = walk((item['item'] as Json[] | undefined) ?? []);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  return walk(items(doc))!;
}

function requestOf(over: Json, more: Json[] = []): { item: Json; request: Json; report: ImportReport } {
  const { doc, report } = convert([req(over), ...more]);
  const item = firstRequest(doc);
  return { item, request: item['request'] as Json, report };
}

function bodyOf(body: Json, headers: Json[] = []): { body: Json | undefined; headers: Json[]; report: ImportReport } {
  const { request, report } = requestOf({ method: 'POST', body, headers });
  return { body: request['body'] as Json | undefined, headers: request['header'] as Json[], report };
}

function authOf(authentication: Json): { auth: Json | undefined; report: ImportReport } {
  const { request, report } = requestOf({ authentication });
  return { auth: request['auth'] as Json | undefined, report };
}

describe('v21OfInsomnia: the document', () => {
  it('is a v2.1 collection named as asked, with no event anywhere', () => {
    const { doc } = convert([
      req({ preRequestScript: 'insomnia.x()', afterResponseScript: 'insomnia.y()' }),
      { _id: 'fld_1', parentId: 'wrk_1', _type: 'request_group', name: 'F', preRequestScript: 'a()' },
      req({ _id: 'req_2', parentId: 'fld_1', name: 'In folder' }),
    ]);
    expect((doc['info'] as Json)['name']).toBe('W');
    expect(String((doc['info'] as Json)['schema'])).toContain('v2.1.0');
    expect(JSON.stringify(doc)).not.toContain('"event"');
  });
});

describe('v21OfInsomnia: URL and parameters', () => {
  it('keeps the URL query, appends parameters with disabled kept, and turns :id into {id}', () => {
    const { request } = requestOf({
      url: '{{ _.baseUrl }}/orders/:id?a=1',
      parameters: [
        { name: 'dryRun', value: 'true', disabled: true },
        { name: 'expand', value: 'items' },
      ],
      pathParameters: [{ name: 'id', value: '42' }],
    });
    const url = request['url'] as Json;
    expect(url['raw']).toBe('{{baseUrl}}/orders/{id}');
    expect(url['query']).toEqual([
      { key: 'a', value: '1' },
      { key: 'dryRun', value: 'true', disabled: true },
      { key: 'expand', value: 'items' },
    ]);
    expect(url['variable']).toEqual([{ key: 'id', value: '42' }]);
  });
});

describe('v21OfInsomnia: headers', () => {
  it('copies folder headers onto requests that lack the name, and notes it', () => {
    const { doc, report } = convert([
      {
        _id: 'fld_1',
        parentId: 'wrk_1',
        _type: 'request_group',
        name: 'Orders',
        headers: [
          { name: 'X-Tenant', value: '{{ _.tenant }}' },
          { name: 'Accept', value: 'text/plain' },
        ],
      },
      req({ _id: 'req_1', parentId: 'fld_1', headers: [{ name: 'accept', value: 'application/json' }] }),
    ]);
    const request = firstRequest(doc)['request'] as Json;
    expect(request['header']).toEqual([
      { key: 'accept', value: 'application/json' },
      { key: 'X-Tenant', value: '{{tenant}}' },
    ]);
    expect(report.notes).toContain(
      'Orders: its headers (X-Tenant, Accept) were copied onto each request below it that does not set them.',
    );
  });

  it('keeps disabled headers disabled', () => {
    const { request } = requestOf({ headers: [{ name: 'X-Debug', value: '1', disabled: true }] });
    expect(request['header']).toEqual([{ key: 'X-Debug', value: '1', disabled: true }]);
  });

  it('a request with Accept: text/event-stream stays a REST request with that header', () => {
    const { item, request } = requestOf({ headers: [{ name: 'Accept', value: 'text/event-stream' }] });
    expect(item['name']).toBe('R');
    expect(request['header']).toEqual([{ key: 'Accept', value: 'text/event-stream' }]);
  });
});

describe('v21OfInsomnia: bodies by mimeType', () => {
  it.each([
    ['application/json', '{"a":1}', 'json'],
    ['application/xml', '<a/>', 'xml'],
    ['application/yaml', 'a: 1', 'text'],
    ['application/edn', '{:a 1}', 'text'],
    ['text/plain', 'hello', 'text'],
  ])('%s is a raw body with that content type', (mimeType, text, language) => {
    const { body, headers } = bodyOf({ mimeType, text });
    expect(body).toEqual({ mode: 'raw', raw: text, options: { raw: { language } } });
    expect(headers).toEqual([{ key: 'Content-Type', value: mimeType }]);
  });

  it('does not add a Content-Type when the request sets one', () => {
    const { headers } = bodyOf({ mimeType: 'application/json', text: '{}' }, [
      { name: 'content-type', value: 'application/vnd.api+json' },
    ]);
    expect(headers).toEqual([{ key: 'content-type', value: 'application/vnd.api+json' }]);
  });

  it('urlencoded is a form from params', () => {
    const { body } = bodyOf({
      mimeType: 'application/x-www-form-urlencoded',
      params: [
        { name: 'a', value: '{{ _.x }}' },
        { name: 'b', value: '2', disabled: true },
      ],
    });
    expect(body).toEqual({
      mode: 'urlencoded',
      urlencoded: [
        { key: 'a', value: '{{x}}' },
        { key: 'b', value: '2', disabled: true },
      ],
    });
  });

  it('multipart keeps a text part, a string multiline as its content type, and a file part path with a note', () => {
    const { body, headers, report } = bodyOf({
      mimeType: 'multipart/form-data',
      params: [
        { name: 'note', value: 'scanned copy', multiline: 'text/plain', type: 'text' },
        { name: 'flag', value: 'x', multiline: true },
        { name: 'file', value: '', fileName: '/Users/dev/invoice.pdf', type: 'file' },
      ],
    });
    expect(body).toEqual({
      mode: 'formdata',
      formdata: [
        { key: 'note', type: 'text', value: 'scanned copy', contentType: 'text/plain' },
        { key: 'flag', type: 'text', value: 'x' },
        { key: 'file', type: 'file', src: '/Users/dev/invoice.pdf' },
      ],
    });
    // The boundary is chosen at send, so no fixed multipart Content-Type is written.
    expect(headers).toEqual([]);
    expect(report.notes).toContain(
      'R: the file part "file" points at /Users/dev/invoice.pdf, which is not in the export; check the path before sending.',
    );
  });

  it('GraphQL with object variables', () => {
    const { body, headers } = bodyOf({
      mimeType: 'application/graphql',
      text: JSON.stringify({ query: 'query Q { a }', variables: { id: '{{ _.id }}' }, operationName: 'Q' }),
    });
    expect(body).toEqual({
      mode: 'graphql',
      graphql: { query: 'query Q { a }', variables: '{\n  "id": "{{id}}"\n}', operationName: 'Q' },
    });
    expect(headers).toEqual([{ key: 'Content-Type', value: 'application/json' }]);
  });

  it('GraphQL with string variables parses them', () => {
    const { body } = bodyOf({
      mimeType: 'application/graphql',
      text: JSON.stringify({ query: '{ a }', variables: '{"id": 1}' }),
    });
    expect(body).toEqual({ mode: 'graphql', graphql: { query: '{ a }', variables: '{\n  "id": 1\n}' } });
  });

  it('GraphQL string variables that do not parse are kept as text, with a note', () => {
    const { body, report } = bodyOf({
      mimeType: 'application/graphql',
      text: JSON.stringify({ query: '{ a }', variables: '{"id": {{ _.id }}}' }),
    });
    expect(body).toEqual({ mode: 'graphql', graphql: { query: '{ a }', variables: '{"id": {{id}}}' } });
    expect(report.notes).toContain('R: its GraphQL variables are not JSON, so they were kept as text.');
  });

  it('octet-stream is a binary body from fileName', () => {
    const { body, headers } = bodyOf({ mimeType: 'application/octet-stream', fileName: '/tmp/blob.bin' });
    expect(body).toEqual({ mode: 'file', file: { src: '/tmp/blob.bin' } });
    expect(headers).toEqual([{ key: 'Content-Type', value: 'application/octet-stream' }]);
  });

  it('an absent body is none', () => {
    const { body, headers } = bodyOf({});
    expect(body).toBeUndefined();
    expect(headers).toEqual([]);
  });
});

describe('v21OfInsomnia: auth', () => {
  it('basic, digest and ntlm carry their user and password', () => {
    expect(authOf({ type: 'basic', username: 'u', password: '{{ _.pw }}' }).auth).toEqual({
      type: 'basic',
      basic: [
        { key: 'username', value: 'u' },
        { key: 'password', value: '{{pw}}' },
      ],
    });
    expect(authOf({ type: 'digest', username: 'u', password: 'p' }).auth).toEqual({
      type: 'digest',
      digest: [
        { key: 'username', value: 'u' },
        { key: 'password', value: 'p' },
      ],
    });
    expect(authOf({ type: 'ntlm', username: 'u', password: 'p' }).auth).toEqual({
      type: 'ntlm',
      ntlm: [
        { key: 'username', value: 'u' },
        { key: 'password', value: 'p' },
      ],
    });
  });

  it('bearer keeps its prefix as the scheme; an empty prefix is the default', () => {
    expect(authOf({ type: 'bearer', token: 't', prefix: 'Token' }).auth).toEqual({
      type: 'bearer',
      bearer: [
        { key: 'token', value: 't' },
        { key: 'scheme', value: 'Token' },
      ],
    });
    expect(authOf({ type: 'bearer', token: 't', prefix: '' }).auth).toEqual({
      type: 'bearer',
      bearer: [{ key: 'token', value: 't' }],
    });
  });

  it('bearer with NO_PREFIX sends the raw token in Authorization', () => {
    const { auth, report } = authOf({ type: 'bearer', token: 't', prefix: 'NO_PREFIX' });
    expect(auth).toEqual({
      type: 'apikey',
      apikey: [
        { key: 'key', value: 'Authorization' },
        { key: 'value', value: 't' },
        { key: 'in', value: 'header' },
      ],
    });
    expect(report.notes).toContain(
      'R: its bearer token is sent with no prefix, so it was imported as an API key in the Authorization header.',
    );
  });

  it('apikey in a header or the query maps; in a cookie is none with a warning', () => {
    expect(authOf({ type: 'apikey', key: 'X-Key', value: 'v', addTo: 'header' }).auth).toEqual({
      type: 'apikey',
      apikey: [
        { key: 'key', value: 'X-Key' },
        { key: 'value', value: 'v' },
        { key: 'in', value: 'header' },
      ],
    });
    expect(authOf({ type: 'apikey', key: 'k', value: 'v', addTo: 'queryParams' }).auth).toEqual({
      type: 'apikey',
      apikey: [
        { key: 'key', value: 'k' },
        { key: 'value', value: 'v' },
        { key: 'in', value: 'query' },
      ],
    });
    const cookie = authOf({ type: 'apikey', key: 'k', value: 'v', addTo: 'cookie' });
    expect(cookie.auth).toEqual({ type: 'noauth' });
    expect(cookie.report.warnings).toContain(
      'R: its API key is sent as a cookie, which Wirebench API-key auth cannot do; set to "none".',
    );
  });

  it('oauth2 carries its grant and fields', () => {
    const { auth } = authOf({
      type: 'oauth2',
      grantType: 'password',
      accessTokenUrl: 'https://auth.example.com/token',
      clientId: 'cid',
      clientSecret: 'cs',
      scope: 'a b',
      username: 'u',
      password: 'p',
      credentialsInBody: true,
    });
    expect(auth).toEqual({
      type: 'oauth2',
      oauth2: [
        { key: 'grant_type', value: 'password_credentials' },
        { key: 'accessTokenUrl', value: 'https://auth.example.com/token' },
        { key: 'clientId', value: 'cid' },
        { key: 'clientSecret', value: 'cs' },
        { key: 'scope', value: 'a b' },
        { key: 'username', value: 'u' },
        { key: 'password', value: 'p' },
        { key: 'client_authentication', value: 'body' },
      ],
    });
  });

  it('iam is AWS Signature', () => {
    const { auth } = authOf({
      type: 'iam',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      region: 'eu-west-1',
      service: 'execute-api',
    });
    expect(auth).toEqual({
      type: 'awsv4',
      awsv4: [
        { key: 'accessKey', value: 'AK' },
        { key: 'secretKey', value: 'SK' },
        { key: 'region', value: 'eu-west-1' },
        { key: 'service', value: 'execute-api' },
      ],
    });
  });

  it('{} and a disabled auth inherit; none stops inheritance', () => {
    expect(authOf({}).auth).toBeUndefined();
    expect(authOf({ type: 'basic', username: 'u', disabled: true }).auth).toBeUndefined();
    expect(authOf({ type: 'none' }).auth).toEqual({ type: 'noauth' });
  });

  it.each(['oauth1', 'hawk', 'asap', 'netrc', 'singleToken'])('%s is none with the type named', (type) => {
    const { auth, report } = authOf({ type, token: 'x' });
    expect(auth).toEqual({ type: 'noauth' });
    expect(report.warnings).toContain(`R: Insomnia auth type "${type}" is not supported; set to "none".`);
  });

  it('folder auth becomes folder auth', () => {
    const { doc } = convert([
      { _id: 'fld_1', parentId: 'wrk_1', _type: 'request_group', name: 'F', authentication: { type: 'none' } },
      req({ parentId: 'fld_1' }),
    ]);
    expect(items(doc)[0]!['auth']).toEqual({ type: 'noauth' });
  });
});

describe('v21OfInsomnia: settings', () => {
  it('followRedirects on and off map; global is the default', () => {
    expect(requestOf({ settingFollowRedirects: 'on' }).item['protocolProfileBehavior']).toEqual({
      followRedirects: true,
    });
    expect(requestOf({ settingFollowRedirects: 'off' }).item['protocolProfileBehavior']).toEqual({
      followRedirects: false,
    });
    expect(requestOf({ settingFollowRedirects: 'global' }).item['protocolProfileBehavior']).toBeUndefined();
  });

  it('encodeUrl off maps', () => {
    expect(requestOf({ settingEncodeUrl: false }).item['protocolProfileBehavior']).toEqual({
      disableUrlEncoding: true,
    });
  });

  it('cookie, render and rebuild-path settings are noted', () => {
    const { report } = requestOf({
      settingStoreCookies: false,
      settingSendCookies: false,
      settingDisableRenderRequestBody: true,
      settingRebuildPath: false,
    });
    expect(report.notes).toContain(
      'R: the "store cookies", "send cookies", "render request body", "rebuild path" settings have no Wirebench equivalent and were not imported.',
    );
  });
});

describe('v21OfInsomnia: template tags', () => {
  it('collects each kept tag with the requests using it', () => {
    const { kept } = convert([
      req({ headers: [{ name: 'X', value: "{% response 'body', 'req_2', '$.id' %}" }] }),
      req({ _id: 'req_2', name: 'Other', url: 'https://api.example.com/{% base64 "x" %}' }),
    ]);
    // Siblings with equal sort keys go by id, descending: req_2 first.
    expect([...kept.entries()].map(([tag, users]) => [tag, [...users]])).toEqual([
      ['base64', ['Other']],
      ['response', ['R']],
    ]);
  });
});
