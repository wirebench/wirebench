/**
 * Property expansion for a REST send. Two things matter beyond substitution: a reference nobody
 * could resolve is reported rather than silently left on the wire, and escaping applies to values
 * substituted into the body only — escaping a URL or a header would change the request.
 */
import { describe, expect, it } from 'vitest';
import type { PropertyScopes } from '../../../src/project/properties.js';
import { expandRestSendInput } from '../../../src/rest/expand.js';
import { entry } from '../../../src/rest/model.js';
import type { RestSendInput } from '../../../src/rest/send.js';

const scopes: PropertyScopes = {
  project: { tier: 'gold', quote: 'a"b', markup: '<b>&</b>' },
  env: { base: 'https://uat.test/api', petId: '42' },
  global: { team: 'integration' },
  system: {},
};

function input(overrides: Partial<RestSendInput['request']> = {}, baseUrl = '${#Env#base}'): RestSendInput {
  return {
    baseUrl,
    request: {
      method: 'GET',
      url: '/pet/{petId}',
      pathParams: [entry('petId', '${#Env#petId}')],
      query: [],
      headers: [],
      body: { kind: 'none' },
      ...overrides,
    },
    settings: { timeoutMs: 1_000, followRedirects: true },
  };
}

describe('expandRestSendInput', () => {
  it('expands the base URL and a path parameter value', () => {
    const { input: expanded, unresolved } = expandRestSendInput(input(), scopes);

    expect(expanded.baseUrl).toBe('https://uat.test/api');
    expect(expanded.request.pathParams).toEqual([{ name: 'petId', value: '42', enabled: true }]);
    expect(unresolved).toEqual([]);
  });

  it('expands query and header names as well as values', () => {
    const { input: expanded } = expandRestSendInput(
      input({ query: [entry('${#Global#team}', '${tier}')], headers: [entry('X-${tier}', '${#Global#team}')] }),
      scopes,
    );

    expect(expanded.request.query).toEqual([{ name: 'integration', value: 'gold', enabled: true }]);
    expect(expanded.request.headers).toEqual([{ name: 'X-gold', value: 'integration', enabled: true }]);
  });

  it('reports a reference nothing resolved, and leaves it verbatim', () => {
    const { input: expanded, unresolved } = expandRestSendInput(input({ url: '/x/${#Env#missing}' }), scopes);

    expect(expanded.request.url).toBe('/x/${#Env#missing}');
    expect(unresolved.map((ref) => ref.name)).toContain('missing');
  });

  it('expands a raw body without escaping by default', () => {
    const { input: expanded } = expandRestSendInput(
      input({ body: { kind: 'raw', language: 'json', text: '{"q":"${quote}"}' } }),
      scopes,
    );

    expect(expanded.request.body).toEqual({ kind: 'raw', language: 'json', text: '{"q":"a"b"}' });
  });

  it('escapes a substituted value for JSON when the request asks to', () => {
    const { input: expanded } = expandRestSendInput(
      input({ body: { kind: 'raw', language: 'json', text: '{"q":"${quote}"}' } }),
      scopes,
      { escape: true },
    );

    const body = expanded.request.body;
    expect(body.kind === 'raw' && body.text).toBe('{"q":"a\\"b"}');
  });

  it('escapes for XML too, and leaves the body own punctuation alone', () => {
    const { input: expanded } = expandRestSendInput(
      input({ body: { kind: 'raw', language: 'xml', text: '<p>${markup}</p>' } }),
      scopes,
      { escape: true },
    );

    const body = expanded.request.body;
    expect(body.kind === 'raw' && body.text).toBe('<p>&lt;b&gt;&amp;&lt;/b&gt;</p>');
  });

  it('never escapes a URL or a header, even with escaping on', () => {
    const { input: expanded } = expandRestSendInput(
      input({ url: '/x/${markup}', headers: [entry('X-Note', '${markup}')] }),
      scopes,
      { escape: true },
    );

    expect(expanded.request.url).toBe('/x/<b>&</b>');
    expect(expanded.request.headers[0]!.value).toBe('<b>&</b>');
  });

  it('expands form fields and multipart text parts and file paths', () => {
    const { input: form } = expandRestSendInput(
      input({ body: { kind: 'form', fields: [entry('tier', '${tier}')] } }),
      scopes,
    );
    expect(form.request.body).toEqual({ kind: 'form', fields: [{ name: 'tier', value: 'gold', enabled: true }] });

    const { input: multipart } = expandRestSendInput(
      input({
        body: {
          kind: 'multipart',
          parts: [
            { kind: 'text', name: 'tier', value: '${tier}', enabled: true },
            { kind: 'file', name: 'f', source: { kind: 'path', path: '/data/${tier}.png' }, enabled: true },
          ],
        },
      }),
      scopes,
    );
    const body = multipart.request.body;
    expect(body.kind === 'multipart' && body.parts[0]).toMatchObject({ value: 'gold' });
    expect(body.kind === 'multipart' && body.parts[1]).toMatchObject({ source: { path: '/data/gold.png' } });
  });

  it('expands a binary body path but never a content hash', () => {
    const { input: byPath } = expandRestSendInput(
      input({
        body: { kind: 'binary', source: { kind: 'path', path: '${tier}.pdf' }, contentType: 'application/pdf' },
      }),
      scopes,
    );
    expect(byPath.request.body).toMatchObject({ source: { kind: 'path', path: 'gold.pdf' } });

    const { input: byHash } = expandRestSendInput(
      input({ body: { kind: 'binary', source: { kind: 'cache', sha256: 'abc' }, contentType: 'x' } }),
      scopes,
    );
    expect(byHash.request.body).toMatchObject({ source: { kind: 'cache', sha256: 'abc' } });
  });

  it('leaves the method and the settings alone', () => {
    const { input: expanded } = expandRestSendInput(input({ method: 'PURGE' }), scopes);
    expect(expanded.request.method).toBe('PURGE');
    expect(expanded.settings).toEqual({ timeoutMs: 1_000, followRedirects: true });
  });
});
