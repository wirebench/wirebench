/**
 * JSONPath over a JSON response — the Query view's third language.
 *
 * The document and most of the expressions are RFC 9535's own examples (the bookstore), so these
 * tests pin conformance to the specification rather than to `jsonpath-plus`'s particular spelling of
 * it. What is deliberately *not* RFC 9535 is `eval: false`: script expressions that would reach a
 * real `eval` are refused, and the last describe block pins that.
 */
import { describe, expect, it } from 'vitest';
import { evaluateJsonPath } from '../../../src/xpath/jsonpath.js';
import { evaluateJson } from '../../../src/xpath/evaluate.js';
import type { QueryResult } from '../../../src/xpath/evaluate.js';

/** RFC 9535 §1.5's example document, verbatim. */
const STORE = JSON.stringify({
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95 },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 },
      {
        category: 'fiction',
        author: 'J. R. R. Tolkien',
        title: 'The Lord of the Rings',
        isbn: '0-395-19395-8',
        price: 22.99,
      },
    ],
    bicycle: { color: 'red', price: 399 },
  },
});

/** The values one expression produced, as text. */
function values(expression: string, json = STORE): readonly string[] {
  const result = evaluateJsonPath(json, expression);
  if (result.kind !== 'values') {
    throw new Error(`expected values, got ${result.kind}: ${JSON.stringify(result)}`);
  }
  return result.items.map((item) => item.text);
}

/** The normalised paths one expression produced. */
function paths(expression: string, json = STORE): readonly (string | undefined)[] {
  const result = evaluateJsonPath(json, expression);
  if (result.kind !== 'values') {
    throw new Error(`expected values, got ${result.kind}`);
  }
  return result.items.map((item) => item.path);
}

describe('RFC 9535 examples', () => {
  it('selects the authors of all books', () => {
    expect(values('$.store.book[*].author')).toEqual([
      'Nigel Rees',
      'Evelyn Waugh',
      'Herman Melville',
      'J. R. R. Tolkien',
    ]);
  });

  it('selects all authors anywhere in the document', () => {
    expect(values('$..author')).toHaveLength(4);
  });

  it('selects everything the store holds', () => {
    const result = values('$.store.*');
    expect(result).toHaveLength(2);
    expect(result[1]).toBe(JSON.stringify({ color: 'red', price: 399 }));
  });

  it('selects every price in the store, the bicycle included', () => {
    expect(values('$.store..price')).toEqual(['8.95', '12.99', '8.99', '22.99', '399']);
  });

  it('selects the third book by index', () => {
    expect(values('$..book[2].title')).toEqual(['Moby Dick']);
  });

  it('selects the last book with a negative slice', () => {
    expect(values('$..book[-1:].title')).toEqual(['The Lord of the Rings']);
  });

  it('does not implement a bare negative index, and says nothing matched', () => {
    // RFC 9535 §2.3.1 gives `[-1]` the last element; `jsonpath-plus` implements negative bounds on a
    // *slice* (`[-1:]`, above) but not a bare negative index, which selects nothing. Pinned as the
    // one divergence from the RFC a user is likely to hit, so an upgrade that fixes it is visible
    // here rather than as a surprise.
    expect(evaluateJsonPath(STORE, '$..book[-1].title')).toEqual({ kind: 'empty' });
  });

  it('selects the first two books by union and by slice alike', () => {
    expect(values('$..book[0,1].title')).toEqual(['Sayings of the Century', 'Sword of Honour']);
    expect(values('$..book[:2].title')).toEqual(['Sayings of the Century', 'Sword of Honour']);
  });

  it('filters on the existence of a member', () => {
    expect(values('$..book[?(@.isbn)].title')).toEqual(['Moby Dick', 'The Lord of the Rings']);
  });

  it('filters on a comparison', () => {
    expect(values('$..book[?(@.price<10)].title')).toEqual(['Sayings of the Century', 'Moby Dick']);
  });

  it('filters on a logical conjunction', () => {
    expect(values('$..book[?(@.category=="fiction" && @.price<10)].title')).toEqual(['Moby Dick']);
  });

  it('selects every member of the whole document with a descendant wildcard', () => {
    // `$..*` walks every value below the root; the count is what pins that it descends into both the
    // array and the objects inside it rather than stopping at the first level.
    expect(values('$..*').length).toBeGreaterThan(20);
  });

  it('evaluates a script expression as an index', () => {
    // `(...)` is the other half of what `eval: 'safe'` keeps working: arithmetic over the current
    // node, parsed by jsep rather than handed to the platform's `eval`.
    expect(values('$..book[(@.length-1)].title')).toEqual(['The Lord of the Rings']);
  });
});

describe('result shape', () => {
  it('reports each match at its normalised path', () => {
    expect(paths('$..book[?(@.price<10)].title')).toEqual([
      "$['store']['book'][0]['title']",
      "$['store']['book'][2]['title']",
    ]);
  });

  it('labels types in JSON vocabulary, not XML Schema', () => {
    const result = evaluateJsonPath(JSON.stringify({ s: 'x', n: 1, f: 1.5, b: true, z: null, a: [], o: {} }), '$.*');
    if (result.kind !== 'values') {
      throw new Error('expected values');
    }
    expect(result.items.map((item) => item.type)).toEqual([
      'string',
      'number',
      'number',
      'boolean',
      'null',
      'array',
      'object',
    ]);
  });

  it('renders a structural match as JSON and a string match as itself', () => {
    expect(values('$.store.bicycle')).toEqual([JSON.stringify({ color: 'red', price: 399 })]);
    expect(values('$.store.bicycle.color')).toEqual(['red']);
  });

  it('reports no match as empty rather than as an error', () => {
    expect(evaluateJsonPath(STORE, '$.store.magazine')).toEqual({ kind: 'empty' });
  });

  it('caps a huge result set and says it truncated', () => {
    const big = JSON.stringify({ items: Array.from({ length: 1_500 }, (_, index) => index) });
    const result = evaluateJsonPath(big, '$.items[*]');
    if (result.kind !== 'values') {
      throw new Error('expected values');
    }
    expect(result.items).toHaveLength(1_000);
    expect(result.truncated).toBe(true);
  });

  it('does not claim truncation at exactly the cap', () => {
    const exact = JSON.stringify({ items: Array.from({ length: 1_000 }, (_, index) => index) });
    const result = evaluateJsonPath(exact, '$.items[*]');
    if (result.kind !== 'values') {
      throw new Error('expected values');
    }
    expect(result.items).toHaveLength(1_000);
    expect(result.truncated).toBe(false);
  });
});

describe('errors, never thrown', () => {
  it('reports a malformed document as an error result', () => {
    const result = evaluateJsonPath('{not json', '$.a');
    expect(result.kind).toBe('error');
  });

  it('reports a malformed expression as an error result', () => {
    const result = evaluateJsonPath(STORE, '$.store.book[?(');
    expect(result.kind).toBe('error');
  });

  it('treats an XPath expression pasted into the JSONPath box as no match', () => {
    // Not an error: `jsonpath-plus` parses `//book/title` as a (nonsensical) path and finds nothing
    // rather than refusing it. Pinned because it is the behaviour the Query view has to live with —
    // the language radio, not a message, is what tells the user they are in the wrong box.
    expect(evaluateJsonPath(STORE, '//book/title')).toEqual({ kind: 'empty' });
  });
});

describe('eval: safe — filters work, the host does not', () => {
  it('refuses a filter that tries to reach a function constructor', () => {
    // The classic JSONPath escape: `constructor.constructor('…')()` is `Function` under another
    // name, and under a real `eval` it runs. jsep has no notion of it, so the expression is refused.
    const result = evaluateJsonPath(JSON.stringify({ a: 1 }), '$[?(this.constructor.constructor("return 1+1")())]');
    expect(result.kind).toBe('error');
  });

  it('refuses the same escape reached through the document rather than through this', () => {
    const result = evaluateJsonPath(
      JSON.stringify({ a: 1 }),
      '$[?(@.a.constructor.constructor("return process.env.PATH")())]',
    );
    expect(result.kind).toBe('error');
  });

  it('treats code-shaped data in the response as data', () => {
    const probe = JSON.stringify({ a: "globalThis.process.env['PATH']" });
    expect(values('$..a', probe)).toEqual(["globalThis.process.env['PATH']"]);
  });
});

describe('reached through evaluateJson, like the other two languages', () => {
  it('dispatches language: jsonpath to the JSONPath evaluator', () => {
    const result: QueryResult = evaluateJson(STORE, '$..book[?(@.price<10)].title', { language: 'jsonpath' });
    if (result.kind !== 'values') {
      throw new Error('expected values');
    }
    expect(result.items.map((item) => item.text)).toEqual(['Sayings of the Century', 'Moby Dick']);
    expect(result.items[0]?.path).toBe("$['store']['book'][0]['title']");
  });

  it('ignores the namespace bindings a JSON query has no use for', () => {
    const result = evaluateJson(STORE, '$.store.bicycle.color', {
      language: 'jsonpath',
      namespaces: { tem: 'http://tempuri.org/' },
    });
    expect(result).toMatchObject({ kind: 'values' });
  });

  it('leaves path absent for an XPath query, which computes rather than locates', () => {
    const result = evaluateJson(STORE, 'count(?store?book?*)', { language: 'xpath' });
    if (result.kind !== 'values') {
      throw new Error('expected values');
    }
    expect(result.items[0]).toEqual({ text: '4', type: 'xs:integer' });
  });
});
