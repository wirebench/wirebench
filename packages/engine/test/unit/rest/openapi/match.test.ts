import { describe, expect, it } from 'vitest';
import { matchOperation } from '../../../../src/rest/openapi/match.js';

const operations = [
  { method: 'get', path: '/pets' },
  { method: 'post', path: '/pets' },
  { method: 'get', path: '/pets/{petId}' },
  { method: 'get', path: '/pets/{petId}/toys' },
  { method: 'get', path: '/stores/{storeId}' },
  { method: 'get', path: '/stores/open' },
];

describe('matchOperation', () => {
  it('matches a literal path by method, ignoring the method case', () => {
    expect(matchOperation(operations, 'GET', '/pets', [])).toEqual({ method: 'get', path: '/pets' });
    expect(matchOperation(operations, 'POST', '/pets', [])).toEqual({ method: 'post', path: '/pets' });
    expect(matchOperation(operations, 'DELETE', '/pets', [])).toBeUndefined();
  });

  it('lets a parameter segment match anything, but a literal only itself', () => {
    expect(matchOperation(operations, 'GET', '/pets/42', [])).toEqual({ method: 'get', path: '/pets/{petId}' });
    expect(matchOperation(operations, 'GET', '/pets/{petId}/toys', [])).toEqual({
      method: 'get',
      path: '/pets/{petId}/toys',
    });
    expect(matchOperation(operations, 'GET', '/pets/{{id}}', [])).toEqual({ method: 'get', path: '/pets/{petId}' });
    expect(matchOperation(operations, 'GET', '/owners/42', [])).toBeUndefined();
    expect(matchOperation(operations, 'GET', '/pets/42/toys/1', [])).toBeUndefined();
  });

  it('ignores a trailing slash, the query string and the fragment', () => {
    expect(matchOperation(operations, 'GET', '/pets/', [])).toEqual({ method: 'get', path: '/pets' });
    expect(matchOperation(operations, 'GET', '/pets?limit=10#top', [])).toEqual({ method: 'get', path: '/pets' });
  });

  it('prefers the more concrete path, and gives no answer on a tie', () => {
    expect(matchOperation(operations, 'GET', '/stores/open', [])).toEqual({ method: 'get', path: '/stores/open' });
    expect(matchOperation(operations, 'GET', '/stores/42', [])).toEqual({ method: 'get', path: '/stores/{storeId}' });
    const tie = [
      { method: 'get', path: '/a/{x}/c' },
      { method: 'get', path: '/a/b/{y}' },
    ];
    expect(matchOperation(tie, 'GET', '/a/b/c', [])).toBeUndefined();
  });

  it('compares literal segments percent-decoded', () => {
    const spaced = [{ method: 'get', path: '/pets/foo bar' }];
    expect(matchOperation(spaced, 'GET', '/pets/foo%20bar', [])).toEqual({ method: 'get', path: '/pets/foo bar' });
    expect(matchOperation(spaced, 'GET', '/pets/%E0%A4%A', [])).toBeUndefined();
  });

  it('strips a matching base URL first', () => {
    const bases = ['https://api.example.test/v1/'];
    expect(matchOperation(operations, 'GET', 'https://api.example.test/v1/pets/7', bases)).toEqual({
      method: 'get',
      path: '/pets/{petId}',
    });
  });

  it('treats a leading variable as an opaque base URL', () => {
    expect(matchOperation(operations, 'GET', '{{baseUrl}}/pets/7', [])).toEqual({
      method: 'get',
      path: '/pets/{petId}',
    });
    expect(matchOperation(operations, 'GET', '${#Project#base}/pets', [])).toEqual({ method: 'get', path: '/pets' });
  });

  it('drops the origin of an absolute URL no base URL matches', () => {
    expect(matchOperation(operations, 'GET', 'http://localhost:8080/pets', [])).toEqual({
      method: 'get',
      path: '/pets',
    });
  });
});
