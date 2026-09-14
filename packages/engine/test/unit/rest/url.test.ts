/**
 * URL composition. The cases worth pinning down are the ones where a wrong answer changes what is
 * sent without telling anyone: a base URL's path silently dropped, a `%20` encoded twice, a path
 * parameter carrying a `/` and inventing a segment, or a missing parameter reaching the wire as
 * the literal text `{id}`.
 */
import { describe, expect, it } from 'vitest';
import { entry } from '../../../src/rest/model.js';
import {
  composeUrl,
  encodeValue,
  joinBase,
  joinQuery,
  parseUrlParams,
  splitQuery,
  trimTrailingSlashes,
} from '../../../src/rest/url.js';

describe('joinBase', () => {
  it.each([
    ['https://h/api/v3', '/pet', 'https://h/api/v3/pet'],
    ['https://h/api/v3/', '/pet', 'https://h/api/v3/pet'],
    ['https://h/api/v3', 'pet', 'https://h/api/v3/pet'],
    ['https://h', '', 'https://h'],
    ['https://h/', '', 'https://h'],
    ['https://h/api', '//pet', 'https://h/api/pet'],
    ['', '/pet', '/pet'],
  ])('joins %s with %s', (base, url, expected) => {
    expect(joinBase(base, url)).toBe(expected);
  });

  it('lets an absolute request URL win over the base', () => {
    expect(joinBase('https://base.test/api', 'http://other.test/x')).toBe('http://other.test/x');
  });
});

describe('encodeValue', () => {
  it.each([
    ['a b', 'a%20b'],
    ['a/b', 'a%2Fb'],
    ['é', '%C3%A9'],
    ['🐕', '%F0%9F%90%95'],
    ["it's", 'it%27s'],
    ['a+b', 'a%2Bb'],
  ])('encodes %s', (value, expected) => {
    expect(encodeValue(value)).toBe(expected);
  });

  it('leaves an already-valid escape alone rather than double-encoding it', () => {
    expect(encodeValue('a%20b')).toBe('a%20b');
    expect(encodeValue('%C3%A9')).toBe('%C3%A9');
  });

  it('encodes a lone percent that is not an escape', () => {
    expect(encodeValue('100%')).toBe('100%25');
    expect(encodeValue('%zz')).toBe('%25zz');
  });

  it('keeps the characters a caller declares safe', () => {
    expect(encodeValue('a:b@c', ':@')).toBe('a:b@c');
  });
});

describe('parseUrlParams', () => {
  it('lists each placeholder once, in order', () => {
    expect(parseUrlParams('/pet/{petId}/photo/{photoId}?x={petId}')).toEqual(['petId', 'photoId']);
  });

  it('ignores a property reference and an unterminated brace', () => {
    expect(parseUrlParams('${#Env#base}/pet/{petId')).toEqual([]);
  });
});

describe('splitQuery and joinQuery', () => {
  it('splits a query string into rows, keeping order and duplicates', () => {
    expect(splitQuery('/search?q=cat&tag=a&tag=b&flag')).toEqual({
      path: '/search',
      query: [
        { name: 'q', value: 'cat', enabled: true },
        { name: 'tag', value: 'a', enabled: true },
        { name: 'tag', value: 'b', enabled: true },
        { name: 'flag', value: '', enabled: true },
      ],
    });
  });

  it('leaves a URL with no query alone', () => {
    expect(splitQuery('/pet/{id}')).toEqual({ path: '/pet/{id}', query: [] });
  });

  it('keeps a fragment out of the query', () => {
    expect(splitQuery('/a?x=1#frag')).toEqual({ path: '/a#frag', query: [{ name: 'x', value: '1', enabled: true }] });
  });

  it.each([
    '/search?q=cat&tag=a&tag=b',
    '/search',
    '/a?x=1#frag',
    '/a#frag',
    'https://h/api?a=1&flag',
    '/unit?q=${#Env#term}',
  ])('round-trips %s through split and join', (url) => {
    const { path, query } = splitQuery(url);
    expect(joinQuery(path, query)).toBe(url);
  });

  it('normalises a trailing "=" away, the one rewrite the round trip makes', () => {
    // `?b=` and `?b` are the same empty value to every parser, and the table cannot tell them
    // apart, so the editor settles on the shorter spelling the first time it rewrites the URL.
    const { path, query } = splitQuery('/a?b=');
    expect(query).toEqual([{ name: 'b', value: '', enabled: true }]);
    expect(joinQuery(path, query)).toBe('/a?b');
  });

  it('drops a disabled row when rebuilding the URL', () => {
    expect(joinQuery('/a', [entry('x', '1'), entry('y', '2', { enabled: false })])).toBe('/a?x=1');
  });
});

describe('composeUrl', () => {
  it('fills path parameters, encoding each value as one segment', () => {
    expect(composeUrl('https://h/api', '/pet/{petId}', [entry('petId', 'a b/c')]).url).toBe(
      'https://h/api/pet/a%20b%2Fc',
    );
  });

  it('keeps the sub-delims a path segment may carry', () => {
    expect(composeUrl('https://h', '/x/{v}', [entry('v', 'a:b@c,d')]).url).toBe('https://h/x/a:b@c,d');
  });

  it('reports a missing path parameter and leaves the placeholder visible', () => {
    const result = composeUrl('https://h', '/pet/{petId}/photo/{photoId}', [entry('petId', '')]);
    expect(result.problems).toEqual([
      { code: 'missing-path-param', name: 'petId' },
      { code: 'missing-path-param', name: 'photoId' },
    ]);
    expect(result.url).toBe('https://h/pet/{petId}/photo/{photoId}');
  });

  it('ignores a disabled path-parameter row, which is therefore missing', () => {
    expect(composeUrl('https://h', '/p/{id}', [entry('id', '1', { enabled: false })]).problems).toEqual([
      { code: 'missing-path-param', name: 'id' },
    ]);
  });

  it('appends the URL query first, then the table, and skips disabled rows', () => {
    expect(
      composeUrl('https://h', '/s?q=cat', [], [entry('tag', 'a'), entry('tag', 'b', { enabled: false })]).url,
    ).toBe('https://h/s?q=cat&tag=a');
  });

  it('encodes query names and values, and writes a valueless row bare', () => {
    expect(composeUrl('https://h', '/s', [], [entry('a b', 'c&d'), entry('flag', '')]).url).toBe(
      'https://h/s?a%20b=c%26d&flag',
    );
  });

  it('sends values verbatim when encoding is off', () => {
    expect(composeUrl('https://h', '/s/{v}', [entry('v', 'a b')], [entry('q', 'x y')], { encode: false }).url).toBe(
      'https://h/s/a b?q=x y',
    );
  });

  it('puts the query before an existing fragment', () => {
    expect(composeUrl('https://h', '/a#frag', [], [entry('x', '1')]).url).toBe('https://h/a?x=1#frag');
  });

  it('reports a property nobody expanded rather than sending it', () => {
    const result = composeUrl('https://h', '/x/${#Env#missing}');
    expect(result.problems).toEqual([{ code: 'unexpanded-property', name: '#Env#missing' }]);
  });

  it('reports a URL with no host at all', () => {
    expect(composeUrl('', '/pet').problems).toEqual([{ code: 'no-host', name: '/pet' }]);
  });

  it('accepts an absolute request URL with no base', () => {
    expect(composeUrl('', 'https://h/pet')).toEqual({ url: 'https://h/pet', problems: [] });
  });
});

describe('trimTrailingSlashes', () => {
  it('drops every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('https://h/api///')).toBe('https://h/api');
    expect(trimTrailingSlashes('https://h/api')).toBe('https://h/api');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(trimTrailingSlashes('')).toBe('');
    expect(trimTrailingSlashes('//a//b')).toBe('//a//b');
  });

  it('is linear, where the regex it replaces was quadratic', () => {
    // `replace(/\/+$/, '')` retries at every position: 80k slashes took ~5s. This asserts the
    // shape of the cost, not a wall-clock budget — the perf suite is where timings are gated.
    const time = (n: number): number => {
      const input = '/'.repeat(n) + 'a' + '/'.repeat(n);
      const started = performance.now();
      expect(trimTrailingSlashes(input)).toBe('/'.repeat(n) + 'a');
      return performance.now() - started;
    };
    time(20_000);
    expect(time(160_000)).toBeLessThan(250);
  });
});
