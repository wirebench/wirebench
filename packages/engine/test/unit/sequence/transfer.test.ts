import { describe, expect, it } from 'vitest';
import type { AssertionSubject } from '../../../src/assert/model.js';
import { extractTransfer } from '../../../src/sequence/transfer.js';

const jsonSubject: AssertionSubject = {
  protocol: 'rest',
  status: 200,
  durationMs: 1,
  bodyText: '{"items":[{"id":"a"},{"id":"b"}]}',
  bodyKind: 'json',
};
const textSubject: AssertionSubject = { ...jsonSubject, bodyText: 'plain', bodyKind: 'other' };

describe('extractTransfer', () => {
  it('takes the first result of an expression that finds several', async () => {
    expect(
      await extractTransfer(jsonSubject, {
        name: 'id',
        from: 'body',
        language: 'jsonpath',
        expression: '$.items[*].id',
      }),
    ).toEqual({ kind: 'value', value: 'a' });
  });

  it('reads JSON with XPath too, as the Query view does', async () => {
    expect(
      await extractTransfer(jsonSubject, { name: 'n', from: 'body', language: 'xpath', expression: 'count(?items?*)' }),
    ).toEqual({ kind: 'value', value: '2' });
  });

  it('errors when the body cannot hold what the language reads', async () => {
    expect(
      await extractTransfer(textSubject, { name: 'x', from: 'body', language: 'jsonpath', expression: '$.a' }),
    ).toMatchObject({ kind: 'error', code: 'sequence-transfer-failed' });
    expect(
      await extractTransfer(textSubject, { name: 'x', from: 'body', language: 'xpath', expression: '/a' }),
    ).toMatchObject({ kind: 'error', code: 'sequence-transfer-failed' });
  });

  it('errors, rather than throwing, for an expression that does not compile', async () => {
    expect(
      await extractTransfer(jsonSubject, { name: 'x', from: 'body', language: 'xpath', expression: '((' }),
    ).toMatchObject({ kind: 'error' });
  });

  it('reports missing for an empty result, a missing header and no headers at all', async () => {
    expect(
      await extractTransfer(jsonSubject, { name: 'x', from: 'body', language: 'jsonpath', expression: '$.none' }),
    ).toEqual({ kind: 'missing' });
    expect(await extractTransfer(jsonSubject, { name: 'x', from: 'header', header: 'X-A' })).toEqual({
      kind: 'missing',
    });
  });
});

describe('a cookie transfer', () => {
  const withCookies: AssertionSubject = {
    ...jsonSubject,
    headers: [
      ['Set-Cookie', 'sid=first; Path=/'],
      ['Content-Type', 'application/json'],
      ['set-cookie', 'theme=dark'],
      ['Set-Cookie', 'sid=second; Path=/; HttpOnly; Secure'],
    ],
  };

  it('takes the value alone, from the last Set-Cookie of that name', async () => {
    expect(await extractTransfer(withCookies, { name: 'sid', from: 'cookie', cookie: 'sid' })).toEqual({
      kind: 'value',
      value: 'second',
    });
  });

  it('is missing when no such cookie was set', async () => {
    expect(await extractTransfer(withCookies, { name: 'x', from: 'cookie', cookie: 'none' })).toEqual({
      kind: 'missing',
    });
    expect(await extractTransfer(jsonSubject, { name: 'x', from: 'cookie', cookie: 'sid' })).toEqual({
      kind: 'missing',
    });
  });
});
