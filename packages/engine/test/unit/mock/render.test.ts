/**
 * Rendering a response template (ADR-0022): request values only, one pass, escaped once for where they
 * land, and a header that would carry a line break refused rather than sent.
 */
import { describe, expect, it } from 'vitest';
import type { MockRequest, MockRequestView } from '../../../src/mock/contract.js';
import { createMockResponse } from '../../../src/mock/model.js';
import type { CreateMockResponseInput } from '../../../src/mock/model.js';
import { renderResponse } from '../../../src/mock/render.js';

function request(over: Partial<MockRequest> = {}): MockRequest {
  const bodyText = over.bodyText ?? '';
  return {
    method: 'POST',
    path: '/orders/42',
    query: {},
    rawQuery: '',
    headers: [],
    body: Buffer.from(bodyText),
    bodyText,
    ...over,
  };
}

const view = (over: Partial<MockRequestView> = {}): MockRequestView => ({
  bodyKind: 'other',
  pathParams: {},
  ...over,
});

const response = (input: CreateMockResponseInput) => createMockResponse('R', { id: 'R1', ...input });

describe('renderResponse', () => {
  it('sends a response without values exactly as written', async () => {
    const plain = response({ body: 'text', bodyText: '{{id}}', headers: [{ name: 'X-A', value: '{{id}}' }] });
    const rendered = await renderResponse(plain, request({ query: { id: ['1'] } }), view());
    expect(rendered).toEqual({ ok: true, headers: plain.headers, bodyText: '{{id}}', problems: [] });
  });

  it('reads the query, a header, a path parameter and the body, and inserts each one', async () => {
    const echo = response({
      body: 'text',
      bodyText: '{{q}} {{h}} {{p}} {{sku}} [{{missing}}]',
      headers: [{ name: 'X-Correlation-Id', value: 'c-{{h}}' }],
      values: {
        q: { from: 'query', name: 'q' },
        h: { from: 'header', name: 'x-correlation-id' },
        p: { from: 'path', name: 'id' },
        sku: { from: 'body', language: 'xpath', expression: '//o:sku', namespaces: { o: 'urn:o' } },
        missing: { from: 'query', name: 'absent' },
      },
    });
    const rendered = await renderResponse(
      echo,
      request({
        query: { q: ['first', 'second'] },
        headers: [['X-Correlation-Id', 'abc']],
        bodyText: '<o:order xmlns:o="urn:o"><o:sku>SKU-1</o:sku></o:order>',
      }),
      view({ bodyKind: 'xml', pathParams: { id: '42' } }),
    );
    expect(rendered).toMatchObject({
      ok: true,
      bodyText: 'first abc 42 SKU-1 []',
      headers: [{ name: 'X-Correlation-Id', value: 'c-abc' }],
    });
  });

  it('never scans an inserted value again', async () => {
    const echo = response({
      body: 'text',
      bodyText: '{{a}}|{{b}}',
      values: { a: { from: 'query', name: 'a' }, b: { from: 'query', name: 'b' } },
    });
    const rendered = await renderResponse(echo, request({ query: { a: ['{{b}}'], b: ['x'] } }), view());
    expect(rendered).toMatchObject({ ok: true, bodyText: '{{b}}|x' });
  });

  it('escapes a value into XML with all five entities', async () => {
    const echo = response({
      body: 'xml',
      bodyText: '<r id="{{v}}">{{v}}</r>',
      values: { v: { from: 'query', name: 'v' } },
    });
    const rendered = await renderResponse(echo, request({ query: { v: [`"/><x a='1'>&`] } }), view());
    const escaped = '&quot;/&gt;&lt;x a=&apos;1&apos;&gt;&amp;';
    expect(rendered).toMatchObject({ ok: true, bodyText: `<r id="${escaped}">${escaped}</r>` });
  });

  it('escapes a value into a JSON string so it can never add a field', async () => {
    const echo = response({
      body: 'json',
      bodyText: '{"id":"{{v}}"}',
      values: { v: { from: 'query', name: 'v' } },
    });
    const hostile = '", "admin": true, "x": "\\\n ';
    const rendered = await renderResponse(echo, request({ query: { v: [hostile] } }), view());
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(JSON.parse(rendered.bodyText)).toEqual({ id: hostile });
    expect(rendered.bodyText).toContain('\\u2028');
  });

  it.each([
    ['CR LF', 'a\r\nX-Injected: 1'],
    ['NUL', 'a\u0000b'],
    ['a character above U+00FF', 'snow ☃'],
  ])('refuses a header value holding %s', async (_label, value) => {
    const echo = response({
      headers: [{ name: 'X-Echo', value: '{{v}}' }],
      values: { v: { from: 'query', name: 'v' } },
    });
    const rendered = await renderResponse(echo, request({ query: { v: [value] } }), view());
    expect(rendered).toMatchObject({ ok: false, code: 'mock-template-refused' });
  });

  it('reports a body expression that fails and inserts nothing for it', async () => {
    const echo = response({
      body: 'text',
      bodyText: '[{{v}}]',
      values: { v: { from: 'body', language: 'xpath', expression: '//[' } },
    });
    const rendered = await renderResponse(echo, request({ bodyText: '<a/>' }), view({ bodyKind: 'xml' }));
    expect(rendered).toMatchObject({ ok: true, bodyText: '[]' });
    expect(rendered.problems.map((p) => p.code)).toEqual(['mock-match-failed']);
  });
});
