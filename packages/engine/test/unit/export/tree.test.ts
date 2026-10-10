import { describe, expect, it } from 'vitest';
import { exportCollection } from '../../../src/export/index.js';
import { mapOpenCollection } from '../../../src/import/opencollection/map.js';
import { parseOpenCollection } from '../../../src/import/opencollection/parse.js';
import type { AuthConfig } from '../../../src/project/model.js';
import { createProject } from '../../../src/project/model.js';
import { createInterface, createRequest } from '../../../src/soap/model.js';
import type { RestBody, RestRequestSettings } from '../../../src/rest/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { apiFromPostmanCollection } from '../../../src/rest/postman/map.js';
import { parsePostmanCollectionText } from '../../../src/rest/postman/parse.js';
import { newId } from './fixture.js';

function oneRequest(input: { auth?: AuthConfig; body?: RestBody; settings?: RestRequestSettings; url?: string }) {
  const request = createRestRequest('R', {
    newId,
    method: 'POST',
    url: input.url ?? '/r',
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.settings !== undefined ? { settings: input.settings } : {}),
  });
  const api = createApi('A', { newId, baseUrl: 'https://h.example.com/v1', requests: [request] });
  return { ...createProject('P', { newId }), containers: { rest: [api] } };
}

const both = (project: ReturnType<typeof oneRequest>) => {
  const postman = exportCollection('postman', { project, target: { kind: 'project' }, newId });
  const oc = exportCollection('opencollection', { project, target: { kind: 'project' } });
  return {
    postman,
    oc,
    viaPostman: apiFromPostmanCollection(parsePostmanCollectionText(postman.files[0]!.text), { newId }).api.folders[0]!
      .requests[0]!,
    viaOc: mapOpenCollection(parseOpenCollection(oc.files[0]!.text), { newId }).rest!.folders[0]!.requests[0]!,
  };
};

describe('auth', () => {
  it.each<[AuthConfig, AuthConfig]>([
    [{ type: 'none' }, { type: 'none' }],
    [
      { type: 'basic', username: 'u' },
      { type: 'basic', username: 'u' },
    ],
    [
      { type: 'api-key', name: 'X-Key', in: 'query', valueRef: 'r' },
      { type: 'api-key', name: 'X-Key', in: 'query' },
    ],
    [
      { type: 'ntlm', username: 'u', domain: 'd' },
      { type: 'ntlm', username: 'u', domain: 'd' },
    ],
  ])('keeps the shape of %j without its credential', (auth, expected) => {
    const { viaPostman, viaOc } = both(oneRequest({ auth }));
    expect(viaPostman.auth).toEqual(expected);
    expect(viaOc.auth).toEqual(expected);
  });

  it('keeps an OAuth 2 client-credentials configuration', () => {
    const expected: AuthConfig = {
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: 'https://id/token',
      clientId: 'c',
      scopes: ['a', 'b'],
      clientAuth: 'body',
      pkce: false,
    };
    const { viaPostman, viaOc, oc } = both(oneRequest({ auth: { ...expected, clientSecretRef: 'r' } }));
    expect(viaOc.auth).toEqual(expected);
    expect(viaPostman.auth).toMatchObject({
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: 'https://id/token',
      clientId: 'c',
      scopes: ['a', 'b'],
    });
    expect(oc.files[0]!.text).not.toContain('clientSecret');
  });

  it('writes Kerberos as no auth and says so', () => {
    const { viaOc, postman } = both(oneRequest({ auth: { type: 'kerberos' } }));
    expect(viaOc.auth).toEqual({ type: 'none' });
    expect(postman.report.warnings).toContain(
      'A / R: Kerberos authentication is not represented and was written as no auth.',
    );
  });
});

describe('bodies', () => {
  it.each<RestBody>([
    {
      kind: 'form',
      fields: [
        { name: 'a', value: '1', enabled: true },
        { name: 'b', value: '2', enabled: false },
      ],
    },
    { kind: 'raw', language: 'xml', text: '<a/>' },
    { kind: 'binary', source: { kind: 'path', path: '/tmp/x.bin' }, contentType: 'application/octet-stream' },
  ])('round-trips a %s body', (body) => {
    const { viaPostman, viaOc } = both(oneRequest({ body }));
    expect(viaPostman.body).toEqual(body);
    expect(viaOc.body).toEqual(body);
  });

  it('writes a body kept in the project with no file, and says so', () => {
    const body: RestBody = { kind: 'binary', source: { kind: 'cache', sha256: 'abc' }, contentType: 'image/png' };
    const { postman } = both(oneRequest({ body }));
    expect(postman.report.warnings).toContain(
      'A / R: a file kept inside the project was not exported; pick the file in the target tool.',
    );
  });

  it('writes an html body as text in OpenCollection, with its content type', () => {
    const { viaOc, oc } = both(oneRequest({ body: { kind: 'raw', language: 'html', text: '<p/>' } }));
    expect(viaOc.body).toEqual({ kind: 'raw', language: 'text', text: '<p/>' });
    expect(viaOc.headers).toEqual([{ name: 'Content-Type', value: 'text/html', enabled: true }]);
    expect(oc.report.notes).toContain('A / R: its html body was written as text.');
  });
});

describe('settings and URLs', () => {
  it('keeps what each format holds and reports the rest', () => {
    const settings: RestRequestSettings = {
      timeoutMs: 5000,
      followRedirects: false,
      encodeUrl: false,
      trustInvalid: true,
    };
    const { postman, oc, viaOc } = both(oneRequest({ settings }));
    expect(viaOc.settings).toEqual({ timeoutMs: 5000, followRedirects: false, encodeUrl: false });
    expect(oc.report.warnings).toContain('A / R: the settings trustInvalid are not represented.');
    expect(postman.report.warnings).toContain('A / R: the timeout is not represented.');
    const written = JSON.parse(postman.files[0]!.text) as { item: { item: { protocolProfileBehavior: unknown }[] }[] };
    expect(written.item[0]!.item[0]!.protocolProfileBehavior).toEqual({
      followRedirects: false,
      disableUrlEncoding: true,
    });
  });

  it('keeps an absolute request URL and joins a relative one to the base', () => {
    expect(both(oneRequest({ url: 'https://other.example.com/x' })).viaOc.url).toBe('https://other.example.com/x');
    expect(both(oneRequest({ url: 'r' })).viaOc.url).toBe('https://h.example.com/v1/r');
  });
});

describe('SOAP 1.2', () => {
  it('puts the action on the content type and uses the request URL override', () => {
    const request = {
      ...createRequest('Req', { newId, envelopeXml: '<e/>', soapVersion: '1.2', soapAction: 'urn:a' }),
      endpointUrl: 'https://override.example.com/s',
    };
    const iface = createInterface('I', {
      newId,
      definitionUrl: 'x',
      operations: [{ name: 'Op', bindingName: '{u}B', slug: 'op', order: 0, requests: [request] }],
    });
    const project = { ...createProject('P', { newId }), containers: { soap: [iface] } };
    const oc = exportCollection('opencollection', { project, target: { kind: 'container', id: iface.id } });
    const back = mapOpenCollection(parseOpenCollection(oc.files[0]!.text), { newId }).rest!;
    const soap = back.folders[0]!.requests[0]!;
    expect(soap.url).toBe('https://override.example.com/s');
    expect(soap.headers).toEqual([
      { name: 'Content-Type', value: 'application/soap+xml; charset=utf-8; action="urn:a"', enabled: true },
    ]);
  });
});

describe('review fixes', () => {
  it('rewrites references in assertion values', () => {
    const request = {
      ...createRestRequest('R', { newId, method: 'GET', url: '/r' }),
      assertions: [
        { type: 'match' as const, language: 'jsonpath' as const, expression: '$.id', equals: '${#Env#userId}' },
      ],
    };
    const api = createApi('A', { newId, baseUrl: 'https://h', requests: [request] });
    const project = { ...createProject('P', { newId }), containers: { rest: [api] } };
    const oc = exportCollection('opencollection', { project, target: { kind: 'project' } });
    const back = mapOpenCollection(parseOpenCollection(oc.files[0]!.text), { newId }).rest!.folders[0]!.requests[0]!;
    expect(back.assertions).toEqual([{ type: 'match', language: 'jsonpath', expression: '$.id', equals: '${userId}' }]);
  });

  it('keeps a URL query row a switched-off table row repeats', () => {
    const request = createRestRequest('R', {
      newId,
      method: 'GET',
      url: '/r?a=1',
      query: [{ name: 'a', value: '1', enabled: false }],
    });
    const api = createApi('A', { newId, baseUrl: 'https://h', requests: [request] });
    const project = { ...createProject('P', { newId }), containers: { rest: [api] } };
    const oc = exportCollection('opencollection', { project, target: { kind: 'project' } });
    const back = mapOpenCollection(parseOpenCollection(oc.files[0]!.text), { newId }).rest!.folders[0]!.requests[0]!;
    expect(back.query).toEqual([
      { name: 'a', value: '1', enabled: true },
      { name: 'a', value: '1', enabled: false },
    ]);
  });
});
