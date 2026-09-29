import { describe, expect, it } from 'vitest';
import { evaluateRuntimeTemplate, parseRuntimeTemplate, resolveJsonPointer } from '../../../../src/index.js';
import type { RuntimeExchange } from '../../../../src/index.js';

const exchange: RuntimeExchange = {
  url: 'https://api.test/subscriptions/42?mode=push&email=a%40b.test',
  method: 'POST',
  pathTemplate: '/subscriptions/{id}',
  request: {
    headers: [
      ['X-Callback', 'https://cb.test/h'],
      ['Content-Type', 'application/json'],
    ],
    body: JSON.stringify({
      callbackUrl: 'https://my-app.dev/subs/cb-91',
      'a/b': { 'c~d': 'x' },
      list: ['zero', 'one'],
    }),
  },
  response: {
    status: 201,
    headers: [['Location', 'https://api.test/subscriptions/42']],
    body: JSON.stringify({ id: 'sub_1', hook: { url: 'https://resp.test/cb' } }),
  },
};

const value = (key: string) => {
  const result = evaluateRuntimeTemplate(key, exchange);
  return result.ok ? result.value : `!${result.reason}`;
};

describe('runtime expressions', () => {
  it('reads the fixed sources', () => {
    expect(value('{$url}')).toBe('https://api.test/subscriptions/42?mode=push&email=a%40b.test');
    expect(value('{$method}')).toBe('POST');
    expect(value('{$statusCode}')).toBe('201');
  });

  it('reads request and response headers, case-insensitively', () => {
    expect(value('{$request.header.x-callback}')).toBe('https://cb.test/h');
    expect(value('{$response.header.location}')).toBe('https://api.test/subscriptions/42');
  });

  it('reads query and path parameters of the request', () => {
    expect(value('{$request.query.email}')).toBe('a@b.test');
    expect(value('{$request.path.id}')).toBe('42');
  });

  it('answers no value for a path parameter that is not valid percent-encoding', () => {
    const result = evaluateRuntimeTemplate('{$request.path.id}', {
      ...exchange,
      url: 'https://api.test/subscriptions/%zz',
    });
    expect(result).toEqual({ ok: false, reason: '$request.path.id has no value' });
  });

  it('matches path parameters behind a base path and with literal text around them', () => {
    const at = (url: string, pathTemplate: string, key: string) => {
      const result = evaluateRuntimeTemplate(key, { ...exchange, url, pathTemplate });
      return result.ok ? result.value : undefined;
    };
    expect(at('https://api.test/v1/subscriptions/42', '/subscriptions/{id}', '{$request.path.id}')).toBe('42');
    expect(at('https://api.test/files/report.json', '/files/{name}.json', '{$request.path.name}')).toBe('report');
    expect(at('https://api.test/orders/42', '/subscriptions/{id}', '{$request.path.id}')).toBeUndefined();
    expect(at('https://api.test/a', '/a/{id}', '{$request.path.id}')).toBeUndefined();
  });

  it('answers quickly and with no value for a pathological template', () => {
    const started = Date.now();
    const result = evaluateRuntimeTemplate('{$request.path.id}', {
      ...exchange,
      pathTemplate: `/${'{'.repeat(50_000)}`,
    });
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reads bodies through a JSON pointer, with ~0 and ~1 escapes and array indexes', () => {
    expect(value('{$request.body#/callbackUrl}')).toBe('https://my-app.dev/subs/cb-91');
    expect(value('{$request.body#/a~1b/c~0d}')).toBe('x');
    expect(value('{$request.body#/list/1}')).toBe('one');
    expect(value('{$response.body#/hook/url}')).toBe('https://resp.test/cb');
  });

  it('fills templates that mix text and expressions', () => {
    expect(value('https://notify.test/cb?id={$response.body#/id}&m={$method}')).toBe(
      'https://notify.test/cb?id=sub_1&m=POST',
    );
  });

  it('says why a value is missing', () => {
    expect(value('{$request.body#/nope}')).toBe('!$request.body#/nope has no value');
    expect(value('{$request.header.missing}')).toBe('!$request.header.missing has no value');
    expect(evaluateRuntimeTemplate('{$response.body#/id}', { ...exchange, response: undefined }).ok).toBe(false);
  });

  it('does not parse what the grammar does not allow', () => {
    expect(parseRuntimeTemplate('{$response.query.x}')).toBeUndefined();
    expect(parseRuntimeTemplate('{$request.cookie.x}')).toBeUndefined();
    expect(parseRuntimeTemplate('{unclosed')).toBeUndefined();
    expect(parseRuntimeTemplate('plain text')).toEqual([{ kind: 'text', text: 'plain text' }]);
    expect(evaluateRuntimeTemplate('{nonsense}', exchange)).toEqual({ ok: false, reason: 'not a runtime expression' });
  });

  it('resolves pointers on plain values', () => {
    expect(resolveJsonPointer({ a: [{ b: 1 }] }, '/a/0/b')).toBe(1);
    expect(resolveJsonPointer({ a: 1 }, '')).toEqual({ a: 1 });
    expect(resolveJsonPointer({ a: 1 }, '/b')).toBeUndefined();
  });
});
