/**
 * ADR-0015 at the three expanders a sequence step goes through: a value a response supplied is escaped
 * into a body whatever the request's own setting, never decides where the request goes, and never
 * carries a line break into a URL, a header or metadata.
 */
import { describe, expect, it } from 'vitest';
import { SequenceError } from '../../../src/errors.js';
import { expandGrpcInput } from '../../../src/grpc/expand.js';
import { expand } from '../../../src/project/properties.js';
import { expandSendInput } from '../../../src/soap/expand.js';
import type { PropertyScopes } from '../../../src/project/properties.js';
import { expandWithSequenceEscaped, urlOrigin } from '../../../src/project/sequence-guards.js';
import { expandRestSendInput } from '../../../src/rest/expand.js';
import { entry } from '../../../src/rest/model.js';
import type { RestBody } from '../../../src/rest/model.js';
import type { RestSendInput } from '../../../src/rest/send.js';
import type { SoapSendInput } from '../../../src/soap/types.js';

function scopes(sequence: Record<string, string>, env: Record<string, string> = {}): PropertyScopes {
  return {
    project: {},
    env: { base: 'https://api.example.test/v1', host: 'api.example.test', ...env },
    global: {},
    system: {},
    sequence,
  };
}

function rest(overrides: Partial<RestSendInput['request']> = {}, baseUrl = '${#Env#base}'): RestSendInput {
  return {
    baseUrl,
    request: {
      method: 'POST',
      url: '/carts',
      pathParams: [],
      query: [],
      headers: [],
      body: { kind: 'none' },
      ...overrides,
    },
    settings: { timeoutMs: 1_000, followRedirects: true },
  };
}

function rawBody(language: 'json' | 'xml' | 'text', text: string): RestBody {
  return { kind: 'raw', language, text, contentType: undefined } as unknown as RestBody;
}

function soap(overrides: Partial<SoapSendInput> = {}): SoapSendInput {
  return {
    endpoint: 'https://${#Env#host}/soap',
    envelopeXml: '<Envelope><Note>${#Sequence#note}</Note></Envelope>',
    soapVersion: '1.1',
    ...overrides,
  };
}

function grpc(overrides: Partial<{ target: string; metadata: ReturnType<typeof entry>[]; messageText: string }> = {}) {
  return { target: 'api.example.test:443', metadata: [], messageText: '{"note":"${#Sequence#note}"}', ...overrides };
}

const JSON_BREAKOUT = 'x", "admin": true, "y": "';
const XML_BREAKOUT = '</Note><Admin>true</Admin><Note a="1" b=\'2\'>&amp;';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(SequenceError);
    return (error as SequenceError).code;
  }
}

describe('Rule 2: a Sequence value is escaped where it lands', () => {
  it.each([false, true])('keeps a JSON body one string field (request escape %s)', (escape) => {
    const { input } = expandRestSendInput(
      rest({ body: rawBody('json', '{"note": "${#Sequence#note}"}') }),
      scopes({ note: JSON_BREAKOUT }),
      { escape },
    );
    const body = (input.request.body as { text: string }).text;
    expect(JSON.parse(body)).toEqual({ note: JSON_BREAKOUT });
  });

  it('escapes a Sequence value exactly once through a chained Env value, escape on or off', () => {
    for (const escape of [false, true]) {
      const { input } = expandRestSendInput(
        rest({ body: rawBody('json', '{"note": "${#Env#chain}"}') }),
        scopes({ note: 'a"b' }, { chain: 'n=${#Sequence#note}' }),
        { escape },
      );
      expect(JSON.parse((input.request.body as { text: string }).text)).toEqual({ note: 'n=a"b' });
    }
  });

  it('leaves the user’s own values unescaped when the request did not ask', () => {
    const { input } = expandRestSendInput(
      rest({ body: rawBody('json', '{"raw": ${#Env#obj}, "note": "${#Sequence#note}"}') }),
      scopes({ note: 'q"' }, { obj: '{"a":1}' }),
    );
    expect(JSON.parse((input.request.body as { text: string }).text)).toEqual({ raw: { a: 1 }, note: 'q"' });
  });

  it('escapes an XML body, quotes included', () => {
    const { input } = expandRestSendInput(
      rest({ body: rawBody('xml', '<Note a="${#Sequence#note}">${#Sequence#note}</Note>') }),
      scopes({ note: XML_BREAKOUT }),
    );
    const text = (input.request.body as { text: string }).text;
    expect(text).not.toContain('<Admin>');
    expect(text).toContain('&lt;/Note&gt;&lt;Admin&gt;');
    expect(text).toContain('&quot;1&quot;');
    expect(text).toContain('&amp;amp;');
  });

  it('does not escape a text body', () => {
    const { input } = expandRestSendInput(
      rest({ body: rawBody('text', 'n=${#Sequence#note}') }),
      scopes({ note: '<a>"' }),
    );
    expect((input.request.body as { text: string }).text).toBe('n=<a>"');
  });

  it.each([false, true])('escapes a SOAP envelope once, quotes included (entitize %s)', (entitize) => {
    const { input } = expandSendInput(soap({ entitize }), scopes({ note: XML_BREAKOUT }));
    expect(input.envelopeXml).not.toContain('<Admin>');
    expect(input.envelopeXml).toBe(
      '<Envelope><Note>&lt;/Note&gt;&lt;Admin&gt;true&lt;/Admin&gt;&lt;Note a=&quot;1&quot; b=&apos;2&apos;&gt;&amp;amp;</Note></Envelope>',
    );
  });

  it.each([false, true])('keeps a gRPC message one string field (request escape %s)', (escape) => {
    const { input } = expandGrpcInput(grpc(), scopes({ note: JSON_BREAKOUT }), { escape });
    expect(JSON.parse(input.messageText)).toEqual({ note: JSON_BREAKOUT });
  });
});

describe('Rule 3: a Sequence value never decides where the request goes', () => {
  const hostile = ['https://evil.example', 'evil.example', ':8443', '.evil.example', '@evil.example'];

  it.each(hostile)('refuses %s in the REST URL before the path', (value) => {
    for (const request of [
      { url: 'https://api.example.test${#Sequence#v}/carts', baseUrl: '' },
      { url: '/carts', baseUrl: 'https://${#Sequence#v}' },
    ]) {
      expect(codeOf(() => expandRestSendInput(rest({ url: request.url }, request.baseUrl), scopes({ v: value })))).toBe(
        'sequence-origin-from-response',
      );
    }
  });

  it('refuses a whole URL from a response, and allows a relative one that sendRest refuses anyway', () => {
    const input = rest({ url: '${#Sequence#v}/carts' }, '');
    expect(codeOf(() => expandRestSendInput(input, scopes({ v: 'https://evil.example' })))).toBe(
      'sequence-origin-from-response',
    );
    // Neither expansion is absolute, so the destination is not the response's to choose: the send
    // itself stops with `no-host`.
    expect(codeOf(() => expandRestSendInput(input, scopes({ v: 'evil.example' })))).toBeUndefined();
  });

  it('refuses a host reached through a chained Env base URL', () => {
    expect(
      codeOf(() =>
        expandRestSendInput(
          rest({}, '${#Env#chained}'),
          scopes({ h: 'evil.example' }, { chained: 'https://${#Sequence#h}/v1' }),
        ),
      ),
    ).toBe('sequence-origin-from-response');
  });

  it('refuses a host from a path parameter placed in the host', () => {
    const input = rest({ url: 'https://{h}/carts', pathParams: [entry('h', '${#Sequence#h}')] }, '');
    expect(codeOf(() => expandRestSendInput(input, scopes({ h: 'evil.example' })))).toBe(
      'sequence-origin-from-response',
    );
  });

  it('allows a Sequence value in the path, query and fragment', () => {
    const input = rest({
      url: '/carts/${#Sequence#id}?next=${#Sequence#next}#${#Sequence#id}',
      pathParams: [],
      query: [entry('token', '${#Sequence#next}')],
    });
    const { input: out } = expandRestSendInput(input, scopes({ id: '42', next: 'https://evil.example/@x' }));
    expect(out.request.url).toBe('/carts/42?next=https://evil.example/@x#42');
  });

  it.each(hostile)('refuses %s in a SOAP endpoint host', (value) => {
    expect(
      codeOf(() =>
        expandSendInput(soap({ endpoint: 'https://api.example.test${#Sequence#v}/soap' }), scopes({ v: value })),
      ),
    ).toBe('sequence-origin-from-response');
  });

  it('allows a Sequence value in a SOAP endpoint path', () => {
    expect(
      expandSendInput(soap({ endpoint: 'https://${#Env#host}/soap/${#Sequence#v}' }), scopes({ v: 'a' })).input
        .endpoint,
    ).toBe('https://api.example.test/soap/a');
  });

  it('refuses any Sequence value in a gRPC target', () => {
    expect(codeOf(() => expandGrpcInput(grpc({ target: '${#Sequence#t}' }), scopes({ t: 'evil.example:443' })))).toBe(
      'sequence-origin-from-response',
    );
    expect(
      codeOf(() => expandGrpcInput(grpc({ target: 'api.example.test:${#Sequence#p}' }), scopes({ p: '444' }))),
    ).toBe('sequence-origin-from-response');
  });

  it('does nothing when there are no Sequence values', () => {
    expect(() => expandRestSendInput(rest({ url: 'https://${#Env#host}/x' }, ''), scopes({}))).not.toThrow();
  });
});

describe('Rule 4: no line break or NUL from a response in a URL, header or metadata', () => {
  const broken = ['a\r\nX-Injected: 1', 'a\nb', 'a\0b'];

  it.each(broken)('refuses %j in a REST header value and name', (value) => {
    expect(
      codeOf(() => expandRestSendInput(rest({ headers: [entry('X-Id', '${#Sequence#v}')] }), scopes({ v: value }))),
    ).toBe('sequence-value-invalid');
    expect(
      codeOf(() => expandRestSendInput(rest({ headers: [entry('${#Sequence#v}', '1')] }), scopes({ v: value }))),
    ).toBe('sequence-value-invalid');
  });

  it.each(broken)('refuses %j in a REST URL and query', (value) => {
    expect(codeOf(() => expandRestSendInput(rest({ url: '/c/${#Sequence#v}' }), scopes({ v: value })))).toBe(
      'sequence-value-invalid',
    );
    expect(
      codeOf(() => expandRestSendInput(rest({ query: [entry('q', '${#Sequence#v}')] }), scopes({ v: value }))),
    ).toBe('sequence-value-invalid');
  });

  it('refuses one in a SOAP action, a SOAP header and gRPC metadata', () => {
    const s = scopes({ v: 'a\r\nb' });
    expect(codeOf(() => expandSendInput(soap({ soapAction: 'urn:${#Sequence#v}' }), s))).toBe('sequence-value-invalid');
    expect(codeOf(() => expandSendInput(soap({ headers: { 'X-A': '${#Sequence#v}' } }), s))).toBe(
      'sequence-value-invalid',
    );
    expect(codeOf(() => expandGrpcInput(grpc({ metadata: [entry('x-a', '${#Sequence#v}')] }), s))).toBe(
      'sequence-value-invalid',
    );
  });

  it('refuses one reached through a chained Env header value', () => {
    expect(
      codeOf(() =>
        expandRestSendInput(
          rest({ headers: [entry('X-A', '${#Env#h}')] }),
          scopes({ v: 'a\nb' }, { h: 'p ${#Sequence#v}' }),
        ),
      ),
    ).toBe('sequence-value-invalid');
  });

  it('allows one in a body', () => {
    const { input } = expandRestSendInput(rest({ body: rawBody('text', '${#Sequence#v}') }), scopes({ v: 'a\r\nb' }));
    expect((input.request.body as { text: string }).text).toBe('a\r\nb');
  });
});

describe('the helpers', () => {
  it('urlOrigin keeps the host and port of a non-special scheme', () => {
    expect(urlOrigin('https://a.test:8443/x')).toBe('https://a.test:8443');
    expect(urlOrigin('grpc://a.test:50051')).toBe('grpc://a.test:50051');
    expect(urlOrigin('not a url')).toBeUndefined();
  });

  it('expandWithSequenceEscaped never reads placeholder 1 followed by a digit as placeholder 15', () => {
    const values: Record<string, string> = {};
    for (let i = 0; i < 20; i++) values[`v${i}`] = `<${i}>`;
    const text = expandWithSequenceEscaped(
      (s) => expand('${#Sequence#v1}5 ${#Sequence#v15}', s).text,
      scopes(values),
      (v) => v.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    );
    expect(text).toBe('&lt;1&gt;5 &lt;15&gt;');
  });

  it('expandWithSequenceEscaped leaves text that merely looks like a placeholder alone', () => {
    const text = expandWithSequenceEscaped(
      (s) => expand('wbseq0z ${#Sequence#a}', s).text,
      scopes({ a: '"' }),
      () => 'ESC',
    );
    expect(text).toBe('wbseq0z ESC');
  });
});
