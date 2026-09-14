/**
 * XPath 3.1 / XQuery 3.1 over a JSON response.
 *
 * No new dependency and no third expression language: XPath 3.1 already has maps, arrays and the `?`
 * lookup operator, so the same two languages that query an envelope query a JSON body. These tests
 * pin that the parsed document is the context item, which is what makes `?field` the natural start.
 */
import { describe, expect, it } from 'vitest';
import { evaluateJson } from '../../../src/xpath/evaluate.js';

const BODY = JSON.stringify({
  total: 3,
  open: true,
  items: [
    { id: 1, status: 'open', tags: ['a', 'b'] },
    { id: 2, status: 'shut', tags: [] },
    { id: 3, status: 'open', tags: ['c'] },
  ],
  meta: { page: 1, next: null },
});

/** The values one expression produced, as text. */
function values(expression: string, json = BODY): readonly string[] {
  const result = evaluateJson(json, expression, { language: 'xpath' });
  if (result.kind !== 'values') {
    throw new Error(`expected values, got ${result.kind}: ${JSON.stringify(result)}`);
  }
  return result.items.map((item) => item.text);
}

describe('evaluateJson', () => {
  it('makes the parsed document the context item, so a lookup starts at ?', () => {
    expect(values('?total')).toEqual(['3']);
    expect(values('?meta?page')).toEqual(['1']);
    expect(values('?open')).toEqual(['true']);
  });

  it('walks arrays with ?* and filters them with a predicate', () => {
    expect(values('?items?*?id')).toEqual(['1', '2', '3']);
    // The example §3.10 of the design gives, working with no new dependency.
    expect(values('?items?*[?status = "open"]?id')).toEqual(['1', '3']);
  });

  it('runs the functions a query needs over JSON, not only over XML', () => {
    expect(values('count(?items?*)')).toEqual(['3']);
    expect(values('sum(?items?*?id)')).toEqual(['6']);
    expect(values('string-join(?items?*?status, ",")')).toEqual(['open,shut,open']);
  });

  it('types what it returns, so the result list can label each item', () => {
    const result = evaluateJson(BODY, '?items?1', { language: 'xpath' });
    expect(result).toMatchObject({ kind: 'values', items: [{ type: 'map' }] });

    const ids = evaluateJson(BODY, '?items?*?id', { language: 'xpath' });
    expect(ids).toMatchObject({ kind: 'values', items: [{ type: 'xs:integer' }, {}, {}] });

    const tags = evaluateJson(BODY, '?items?1?tags', { language: 'xpath' });
    expect(tags).toMatchObject({ kind: 'values', items: [{ type: 'array' }] });
  });

  it('renders a map or array result as JSON, so it can be read and copied', () => {
    expect(values('?meta')).toEqual([JSON.stringify({ page: 1, next: null })]);
    expect(values('?items?1?tags')).toEqual(['["a","b"]']);
  });

  it('answers empty for a lookup that matches nothing', () => {
    expect(evaluateJson(BODY, '?missing', { language: 'xpath' })).toEqual({ kind: 'empty' });
    expect(evaluateJson(BODY, '?items?*[?status = "gone"]', { language: 'xpath' })).toEqual({ kind: 'empty' });
  });

  it('runs XQuery too, which is what a FLWOR over a response needs', () => {
    const result = evaluateJson(BODY, 'for $i in ?items?* where $i?status = "open" return $i?id', {
      language: 'xquery',
    });

    expect(result).toMatchObject({ kind: 'values' });
    expect(result.kind === 'values' ? result.items.map((item) => item.text) : []).toEqual(['1', '3']);
  });

  it('reports malformed JSON the same way a malformed document is reported', () => {
    const result = evaluateJson('{not json', '?a', { language: 'xpath' });

    expect(result.kind).toBe('error');
    expect(result.kind === 'error' ? result.message.length : 0).toBeGreaterThan(0);
  });

  it('reports a bad expression with its code and position', () => {
    const result = evaluateJson(BODY, '?items?*[', { language: 'xpath' });

    expect(result.kind).toBe('error');
    expect(result.kind === 'error' ? result.code : undefined).toBeDefined();
  });

  it('queries a top-level array, which a REST collection endpoint returns', () => {
    expect(values('?*?id', JSON.stringify([{ id: 'a' }, { id: 'b' }]))).toEqual(['a', 'b']);
  });

  it('queries a top-level scalar without ceremony', () => {
    expect(values('.', '42')).toEqual(['42']);
    expect(values('.', '"hello"')).toEqual(['hello']);
  });
});
