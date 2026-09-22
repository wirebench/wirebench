import { describe, expect, it } from 'vitest';
import { diffJson } from '../../../src/snapshot/json-diff.js';

describe('diffJson', () => {
  it('ignores key order', () => {
    expect(diffJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it('treats 1.0 and 1 as equal', () => {
    expect(diffJson({ a: 1.0 }, { a: 1 })).toEqual([]);
  });

  it('reports extra tail items as added', () => {
    expect(diffJson([1, 2], [1, 2, 3])).toEqual([{ kind: 'added', path: '/2', actual: '3' }]);
  });

  it('reports missing tail items as removed', () => {
    expect(diffJson([1, 2, 3], [1, 2])).toEqual([{ kind: 'removed', path: '/2', expected: '3' }]);
  });

  it('reports a type change as one changed entry', () => {
    expect(diffJson({ a: '1' }, { a: 1 })).toEqual([{ kind: 'changed', path: '/a', expected: '"1"', actual: '1' }]);
  });

  it('escapes "~" and "/" in JSON Pointer paths', () => {
    expect(diffJson({ 'a/b~c': 1 }, { 'a/b~c': 2 })).toEqual([
      { kind: 'changed', path: '/a~1b~0c', expected: '1', actual: '2' },
    ]);
  });

  it('recurses into nested objects and arrays', () => {
    expect(diffJson({ items: [{ id: 1 }] }, { items: [{ id: 2 }] })).toEqual([
      { kind: 'changed', path: '/items/0/id', expected: '1', actual: '2' },
    ]);
  });

  it('reports an added and a removed key separately', () => {
    const changes = diffJson({ old: 1 }, { fresh: 1 });
    expect(changes).toEqual(
      expect.arrayContaining([
        { kind: 'removed', path: '/old', expected: '1' },
        { kind: 'added', path: '/fresh', actual: '1' },
      ]),
    );
    expect(changes).toHaveLength(2);
  });

  it('reports a change at the root as "/"', () => {
    expect(diffJson({ a: 1 }, [1])).toEqual([{ kind: 'changed', path: '/', expected: '{"a":1}', actual: '[1]' }]);
    expect(diffJson('a', 'b')).toEqual([{ kind: 'changed', path: '/', expected: '"a"', actual: '"b"' }]);
  });
});
