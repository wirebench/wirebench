/**
 * Mapping a JSON Pointer to where its value sits in the text shown, pretty-printed or minified.
 */
import { describe, expect, it } from 'vitest';
import { pointerRange } from '../../../src/json/pointer-range.js';
import { pointerRange as fromSubpath } from '../../../src/json/cursor.js';

describe('pointerRange', () => {
  const pretty = '{\n  "a": {\n    "b": 42,\n    "c": [1, "x", {"d": true}]\n  }\n}';

  it('locates the root as its opening brace', () => {
    expect(pointerRange(pretty, '')).toEqual({ line: 1, column: 1, endLine: 1, endColumn: 2 });
  });

  it('locates a nested scalar in pretty text', () => {
    expect(pointerRange(pretty, '/a/b')).toEqual({ line: 3, column: 10, endLine: 3, endColumn: 12 });
  });

  it('locates an object as its opening brace (where a missing required property is reported)', () => {
    expect(pointerRange(pretty, '/a')).toEqual({ line: 2, column: 8, endLine: 2, endColumn: 9 });
  });

  it('follows array indices', () => {
    expect(pointerRange(pretty, '/a/c/1')).toEqual({ line: 4, column: 14, endLine: 4, endColumn: 17 });
    expect(pointerRange(pretty, '/a/c/2/d')).toEqual({ line: 4, column: 25, endLine: 4, endColumn: 29 });
  });

  it('works on minified text', () => {
    const min = '{"a":{"b":42,"c":[1,"x"]}}';
    expect(pointerRange(min, '/a/c/1')).toEqual({ line: 1, column: 21, endLine: 1, endColumn: 24 });
  });

  it('decodes ~0 and ~1 in the pointer and escapes in the keys', () => {
    const text = '{"a/b": 1, "m~n": 2, "q\\"r": 3, "\\u0041": 4}';
    expect(pointerRange(text, '/a~1b')?.column).toBe(9);
    expect(pointerRange(text, '/m~0n')?.column).toBe(19);
    expect(pointerRange(text, '/q"r')?.column).toBe(30);
    expect(pointerRange(text, '/A')?.column).toBe(43);
  });

  it('skips strings holding brackets and escaped quotes', () => {
    const text = '{"x": "}]\\"{", "y": null}';
    expect(pointerRange(text, '/y')).toEqual({ line: 1, column: 21, endLine: 1, endColumn: 25 });
  });

  it('resolves a duplicate key to its last occurrence, as JSON.parse does', () => {
    expect(pointerRange('{"a":1,"a":"x"}', '/a')).toEqual({ line: 1, column: 12, endLine: 1, endColumn: 15 });
    expect(pointerRange('{"a":{"b":1},"a":{"c":2}}', '/a/c')?.column).toBe(23);
    expect(pointerRange('{"a":{"b":1},"a":{"c":2}}', '/a/b')).toBeUndefined();
  });

  it('returns undefined for a pointer it cannot locate', () => {
    expect(pointerRange(pretty, '/nope')).toBeUndefined();
    expect(pointerRange(pretty, '/a/c/9')).toBeUndefined();
    expect(pointerRange(pretty, '/a/b/c')).toBeUndefined();
    expect(pointerRange('{"a":', '/a')).toBeUndefined();
    expect(pointerRange(pretty, 'a')).toBeUndefined();
  });

  it('is exported from the browser-safe json entry', () => {
    expect(fromSubpath).toBe(pointerRange);
  });
});
