/** A resolved REST or SOAP send as the request every code target renders. */
import { describe, expect, it } from 'vitest';
import { envMarker, generateCode, secretTokensToEnv } from '#core/http/codegen/index';
import { restCodeRequest } from '#protocol-rest/rest/codegen';
import { entry } from '#protocol-rest/rest/model';
import { soapCodeRequest } from '#protocol-soap/soap/codegen';
import type { RestBody, RestSendInput } from '../../../src/index.js';

function input(overrides: {
  readonly method?: RestSendInput['request']['method'];
  readonly url?: string;
  readonly query?: RestSendInput['request']['query'];
  readonly headers?: RestSendInput['request']['headers'];
  readonly body?: RestBody;
  readonly auth?: RestSendInput['auth'];
  readonly settings?: Partial<RestSendInput['settings']>;
  readonly tls?: RestSendInput['tls'];
}): RestSendInput {
  return {
    baseUrl: 'https://api.test',
    request: {
      method: overrides.method ?? 'GET',
      url: overrides.url ?? '/pets',
      pathParams: [],
      query: overrides.query ?? [],
      headers: overrides.headers ?? [],
      body: overrides.body ?? { kind: 'none' },
    },
    settings: { timeoutMs: 30_000, followRedirects: true, ...overrides.settings },
    ...(overrides.auth !== undefined ? { auth: overrides.auth } : {}),
    ...(overrides.tls !== undefined ? { tls: overrides.tls } : {}),
  };
}

describe('restCodeRequest', () => {
  it('leaves out the generated headers the request switched off, as the send does', () => {
    const request = restCodeRequest(
      input({
        method: 'POST',
        body: { kind: 'raw', language: 'json', text: '{}' },
        auth: { type: 'bearer', token: 't' },
        settings: { omitHeaders: ['Content-Type', 'authorization'] },
      }),
    );
    expect(request.headers).toEqual([]);
    const basic = restCodeRequest(
      input({
        auth: { type: 'basic', username: 'u', password: 'p', preemptive: true },
        settings: { omitHeaders: ['Authorization'] },
      }),
    );
    expect(basic.basic).toBeUndefined();
  });

  it('composes the URL, drops disabled rows and declares the body type as the send does', () => {
    const request = restCodeRequest(
      input({
        method: 'POST',
        query: [entry('status', 'open now'), entry('page', '2', { enabled: false })],
        headers: [entry('X-Trace', 'abc'), entry('X-Off', 'no', { enabled: false })],
        body: { kind: 'raw', language: 'json', text: '{}' },
      }),
    );
    expect(request).toEqual({
      method: 'POST',
      url: 'https://api.test/pets?status=open%20now',
      headers: [
        { name: 'X-Trace', value: 'abc' },
        { name: 'Content-Type', value: 'application/json' },
      ],
      body: { kind: 'raw', text: '{}' },
      followRedirects: true,
      timeoutMs: 30_000,
    });
  });

  it('lets a typed header win over a computed one', () => {
    const request = restCodeRequest(
      input({
        headers: [entry('content-type', 'application/vnd.api+json'), entry('Authorization', 'Custom x')],
        body: { kind: 'raw', language: 'json', text: '{}' },
        auth: { type: 'bearer', token: 't' },
      }),
    );
    expect(request.headers).toEqual([
      { name: 'content-type', value: 'application/vnd.api+json' },
      { name: 'Authorization', value: 'Custom x' },
    ]);
  });

  it('applies credentials where the send puts them', () => {
    const marker = envMarker('WIREBENCH_SECRET_KEY');
    const keyed = restCodeRequest(input({ auth: { type: 'api-key', name: 'key', value: marker, in: 'query' } }));
    expect(keyed.url).toBe(`https://api.test/pets?key=${marker}`);

    const basic = restCodeRequest(
      input({ auth: { type: 'basic', username: 'ada', password: 'pw', preemptive: true } }),
    );
    expect(basic.basic).toEqual({ username: 'ada', password: 'pw' });
    expect(basic.headers).toEqual([]);
  });

  it('carries the transport settings', () => {
    const request = restCodeRequest(
      input({ settings: { followRedirects: true, maxRedirects: 4, timeoutMs: 0 }, tls: { rejectUnauthorized: false } }),
    );
    expect(request).toMatchObject({ insecure: true, followRedirects: true, maxRedirects: 4 });
    expect(request.timeoutMs).toBeUndefined();
  });

  it('declares a form body and a binary body by their own types', () => {
    const form = restCodeRequest(input({ method: 'POST', body: { kind: 'form', fields: [entry('a', '1')] } }));
    expect(form.headers).toEqual([{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
    const binary = restCodeRequest(
      input({
        method: 'PUT',
        body: { kind: 'binary', source: { kind: 'path', path: 'a.png' }, contentType: 'image/png' },
      }),
    );
    expect(binary.headers).toEqual([{ name: 'Content-Type', value: 'image/png' }]);
    expect(binary.body).toEqual({ kind: 'binary', path: 'a.png' });
  });
});

describe('secretTokensToEnv', () => {
  it('turns a ${secret:name} token into a read of the variable the CLI reads', () => {
    const resolved = secretTokensToEnv(
      input({ url: '/pets/${secret:petId}', headers: [entry('X-Key', 'k-${secret:api_key}')] }),
    );
    const request = restCodeRequest(resolved);
    const { code } = generateCode('python-requests', request);
    expect(code).toContain("'https://api.test/pets/' + os.environ['WIREBENCH_SECRET_PETID']");
    expect(code).toContain("'X-Key': 'k-' + os.environ['WIREBENCH_SECRET_API_KEY'],");
  });

  it('keeps what is not plain data as it is', () => {
    const resolver = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array());
    const value = { resolveFile: resolver, bytes: new Uint8Array([1]), n: 3, flag: true, none: undefined };
    const mapped = secretTokensToEnv(value);
    expect(mapped.resolveFile).toBe(resolver);
    expect(mapped.bytes).toBe(value.bytes);
    expect(mapped).toMatchObject({ n: 3, flag: true });
  });
});

describe('soapCodeRequest', () => {
  it('posts the envelope with the headers the curl export writes, Basic kept apart', () => {
    const request = soapCodeRequest(
      {
        endpoint: 'http://soap.test/calc',
        envelopeXml: '<e/>',
        soapVersion: '1.1',
        soapAction: 'urn:Add',
        headers: { 'X-Trace': '1' },
        timeoutMs: 5000,
      },
      { username: 'ada', password: 'pw' },
    );
    expect(request).toEqual({
      method: 'POST',
      url: 'http://soap.test/calc',
      headers: [
        { name: 'Content-Type', value: 'text/xml;charset=UTF-8' },
        { name: 'SOAPAction', value: '"urn:Add"' },
        { name: 'X-Trace', value: '1' },
      ],
      body: { kind: 'raw', text: '<e/>' },
      basic: { username: 'ada', password: 'pw' },
      followRedirects: false,
      timeoutMs: 5000,
    });
  });

  it('puts a SOAP 1.2 action in the Content-Type', () => {
    const request = soapCodeRequest({
      endpoint: 'http://soap.test/calc',
      envelopeXml: '<e/>',
      soapVersion: '1.2',
      soapAction: 'urn:Add',
    });
    expect(request.headers).toEqual([
      { name: 'Content-Type', value: 'application/soap+xml;charset=UTF-8;action="urn:Add"' },
    ]);
  });
});
