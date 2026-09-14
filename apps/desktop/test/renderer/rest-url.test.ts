/**
 * The renderer's URL helpers. Everything that splits or rejoins a URL delegates to the engine, so
 * what is tested here is the part the renderer adds: how a URL reads (the highlighted runs), and how
 * the two tables follow it without losing what the user typed.
 */
import { describe, expect, it } from 'vitest';
import {
  isAbsoluteUrl,
  pathFromUrl,
  queryFromUrl,
  syncPathParams,
  urlSegments,
  urlWithQuery,
} from '../../src/renderer/state/rest-url.js';

describe('urlSegments', () => {
  it('marks a property reference and a path placeholder apart from plain text', () => {
    expect(urlSegments('${#Env#base}/pet/{petId}?x=1')).toEqual([
      { text: '${#Env#base}', kind: 'property' },
      { text: '/pet/', kind: 'plain' },
      { text: '{petId}', kind: 'param' },
      { text: '?x=1', kind: 'plain' },
    ]);
  });

  it('keeps a scoped reference in one piece rather than splitting on its hashes', () => {
    expect(urlSegments('${#Project#host}')).toEqual([{ text: '${#Project#host}', kind: 'property' }]);
  });

  it('reads a bare URL as one plain run, and an empty one as nothing', () => {
    expect(urlSegments('/pet/1')).toEqual([{ text: '/pet/1', kind: 'plain' }]);
    expect(urlSegments('')).toEqual([]);
  });

  it('does not mistake a property reference for a path placeholder', () => {
    const kinds = urlSegments('/x/${a}/{b}').map((segment) => segment.kind);
    expect(kinds).toEqual(['plain', 'property', 'plain', 'param']);
  });
});

describe('isAbsoluteUrl', () => {
  it('is true only for a URL that carries its own scheme and host', () => {
    expect(isAbsoluteUrl('https://api.test/pets')).toBe(true);
    expect(isAbsoluteUrl('HTTP://api.test')).toBe(true);
    expect(isAbsoluteUrl('/pets')).toBe(false);
    expect(isAbsoluteUrl('pets')).toBe(false);
    // A property reference could expand to anything, so it is not absolute until it does.
    expect(isAbsoluteUrl('${#Env#base}/pets')).toBe(false);
  });
});

describe('syncPathParams', () => {
  it('keeps the value already typed for a placeholder still in the URL', () => {
    const rows = [{ name: 'petId', value: '42', enabled: true }];
    expect(syncPathParams('/pet/{petId}', rows)).toEqual(rows);
  });

  it('adds a row for a new placeholder and drops one whose placeholder is gone', () => {
    const rows = [{ name: 'petId', value: '42', enabled: true }];
    expect(syncPathParams('/photo/{photoId}', rows)).toEqual([{ name: 'photoId', value: '', enabled: true }]);
  });

  it('returns the rows in the order the URL names them', () => {
    const rows = [
      { name: 'b', value: '2', enabled: true },
      { name: 'a', value: '1', enabled: true },
    ];
    expect(syncPathParams('/{a}/{b}', rows).map((row) => row.name)).toEqual(['a', 'b']);
  });
});

describe('queryFromUrl and urlWithQuery', () => {
  it('reads the query a URL carries, duplicates and order kept', () => {
    expect(queryFromUrl('/pet?tag=a&tag=b&status=sold')).toEqual([
      { name: 'tag', value: 'a', enabled: true },
      { name: 'tag', value: 'b', enabled: true },
      { name: 'status', value: 'sold', enabled: true },
    ]);
  });

  it('leaves the path alone and writes only the enabled rows', () => {
    expect(
      urlWithQuery('/pet?old=1', [
        { name: 'status', value: 'sold', enabled: true },
        { name: 'tag', value: 'a', enabled: false },
      ]),
    ).toBe('/pet?status=sold');
  });

  it('drops the query string entirely when no row is enabled', () => {
    expect(urlWithQuery('/pet?status=sold', [{ name: 'status', value: 'sold', enabled: false }])).toBe('/pet');
  });

  it('keeps a path placeholder untouched while the query changes', () => {
    expect(urlWithQuery('/pet/{petId}', [{ name: 'x', value: '1', enabled: true }])).toBe('/pet/{petId}?x=1');
    expect(pathFromUrl('/pet/{petId}?x=1')).toBe('/pet/{petId}');
  });
});
