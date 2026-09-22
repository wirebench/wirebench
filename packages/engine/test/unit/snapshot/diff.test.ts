import { describe, expect, it } from 'vitest';
import { diffSnapshot } from '../../../src/snapshot/diff.js';

describe('diffSnapshot', () => {
  it('diffs JSON semantically', () => {
    const result = diffSnapshot('{"a":1}', '{"a":2}', { format: 'json', ignore: [] });
    expect(result).toEqual({
      format: 'json',
      changes: [{ kind: 'changed', path: '/a', expected: '1', actual: '2' }],
      ignored: 0,
    });
  });

  it('diffs XML semantically', () => {
    const result = diffSnapshot('<root>1</root>', '<root>2</root>', { format: 'xml', ignore: [] });
    expect(result).toEqual({
      format: 'xml',
      changes: [{ kind: 'changed', path: '/root', expected: '1', actual: '2' }],
      ignored: 0,
    });
  });

  it('diffs text exactly, ignoring line-ending differences', () => {
    const same = diffSnapshot('a\r\nb', 'a\nb', { format: 'text', ignore: [] });
    expect(same).toEqual({ format: 'text', changes: [], ignored: 0 });

    const different = diffSnapshot('a', 'b', { format: 'text', ignore: [] });
    expect(different).toEqual({
      format: 'text',
      changes: [{ kind: 'changed', path: '/', expected: 'a', actual: 'b' }],
      ignored: 0,
    });
  });

  it('falls back to text diffing and sets error on a JSON parse failure', () => {
    const result = diffSnapshot('{not json', 'still not json', { format: 'json', ignore: [] });
    expect(result.format).toBe('text');
    expect(result.error).toBeDefined();
    expect(result.changes).toEqual([{ kind: 'changed', path: '/', expected: '{not json', actual: 'still not json' }]);
  });

  it('falls back to text diffing and sets error on an XML parse failure', () => {
    const result = diffSnapshot('<unclosed>', '<unclosed>', { format: 'xml', ignore: [] });
    expect(result.format).toBe('text');
    expect(result.error).toBeDefined();
  });

  it('drops ignored changes and reports how many were dropped', () => {
    const result = diffSnapshot('{"a":1,"b":1}', '{"a":2,"b":2}', { format: 'json', ignore: ['/a'] });
    expect(result).toEqual({
      format: 'json',
      changes: [{ kind: 'changed', path: '/b', expected: '1', actual: '2' }],
      ignored: 1,
    });
  });

  it('truncates expected/actual values to 200 characters', () => {
    const long = 'x'.repeat(250);
    const result = diffSnapshot(`{"a":"${long}"}`, '{"a":"short"}', { format: 'json', ignore: [] });
    const change = result.changes[0];
    expect(change?.expected).toHaveLength(200); // 199 chars, then the 1-char ellipsis
    expect(change?.expected?.endsWith('…')).toBe(true);
  });

  it('leaves a value of exactly 200 characters whole', () => {
    const exact = 'y'.repeat(200);
    const result = diffSnapshot(exact, 'short', { format: 'text', ignore: [] });
    expect(result.changes[0]?.expected).toBe(exact);
  });

  it('falls back to text diffing and sets error on an empty XML body', () => {
    const result = diffSnapshot('<root/>', '', { format: 'xml', ignore: [] });
    expect(result.format).toBe('text');
    expect(result.error).toBeDefined();
    expect(result.changes).toEqual([{ kind: 'changed', path: '/', expected: '<root/>', actual: '' }]);
  });

  it('reports a root JSON change at "/", which a "/" rule ignores', () => {
    expect(diffSnapshot('1', '2', { format: 'json', ignore: [] }).changes).toEqual([
      { kind: 'changed', path: '/', expected: '1', actual: '2' },
    ]);
    expect(diffSnapshot('{"a":1}', '[]', { format: 'json', ignore: ['/'] })).toEqual({
      format: 'json',
      changes: [],
      ignored: 1,
    });
  });
});
