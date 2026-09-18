/**
 * Where a cursor sits in a half-typed JSON document.
 *
 * Every case here is a document that no JSON parser would accept, because that is the only kind a
 * completion provider is ever asked about. `|` marks the cursor in each fixture and is stripped
 * before the call, so the offsets stay readable as the documents grow.
 */
import { describe, expect, it } from 'vitest';
import { jsonCompletionContextAt } from '../../../src/json/cursor.js';

/** Runs the analysis on a document whose cursor is marked with `|`. */
function at(marked: string) {
  const offset = marked.indexOf('|');
  expect(offset).toBeGreaterThanOrEqual(0);
  return jsonCompletionContextAt(marked.replace('|', ''), offset);
}

describe('jsonCompletionContextAt', () => {
  it('reports an empty key at the start of an object', () => {
    expect(at('{|}')).toMatchObject({ path: [], partial: '', quoted: false, siblings: [] });
  });

  it('reports the key being typed inside its quotes', () => {
    const context = at('{"na|"}');
    expect(context).toMatchObject({ partial: 'na', quoted: true, path: [] });
    // The range covers the whole token so the accepted key replaces what follows the cursor too.
    expect(context?.replaceRange).toEqual({ start: 2, end: 4 });
  });

  it('completes an unquoted word, which is what Monaco asks about first', () => {
    const context = at('{ nam| }');
    expect(context).toMatchObject({ partial: 'nam', quoted: false });
    expect(context?.replaceRange).toEqual({ start: 2, end: 5 });
  });

  it('offers nothing in a value', () => {
    expect(at('{"name": "A|"}')).toBeUndefined();
    expect(at('{"name": 1|}')).toBeUndefined();
  });

  it('offers nothing directly inside an array, or outside every object', () => {
    expect(at('{"tags": [ | ]}')).toBeUndefined();
    expect(at('  |  ')).toBeUndefined();
  });

  it('reports the keys the object already holds, which JSON will not let it repeat', () => {
    expect(at('{"name": "A", "mood": "FORMAL", |}')?.siblings).toEqual(['name', 'mood']);
  });

  it('descends into a nested object', () => {
    expect(at('{"address": {"ci|"}}')).toMatchObject({ path: ['address'], partial: 'ci' });
  });

  it('does not count an array index as a path segment', () => {
    // Every item of a repeated field has the element type, so the item is where the field is.
    expect(at('{"items": [{"a": 1}, {"|"}]}')).toMatchObject({ path: ['items'] });
  });

  it('counts a map key as a segment, since only a schema knows the level is a map', () => {
    expect(at('{"counts": {"anything": {"|"}}}')).toMatchObject({ path: ['counts', 'anything'] });
  });

  it('leaves a closed object behind', () => {
    expect(at('{"address": {"city": "Oslo"}, "|"}')).toMatchObject({ path: [], siblings: ['address'] });
  });

  it('reads each object of a one-per-line document on its own', () => {
    expect(at('{"name": "A"}\n{"na|"}')).toMatchObject({ path: [], partial: 'na', siblings: [] });
  });

  it('is not fooled by braces, colons or commas inside a string', () => {
    expect(at('{"name": "a{b,c:d", "|"}')).toMatchObject({ path: [], siblings: ['name'] });
  });

  it('is not fooled by an escaped quote', () => {
    expect(at('{"name": "say \\"hi\\"", "|"}')).toMatchObject({ path: [], siblings: ['name'] });
  });

  it('stops an unterminated string at its line, so one missing quote does not swallow the rest', () => {
    expect(at('{"name": "oops\n"na|"}')).toMatchObject({ partial: 'na', quoted: true });
  });

  it('offers nothing where a key would not be the next thing written', () => {
    // After a complete member, a comma has to come first.
    expect(at('{"name": "A" |}')).toBeUndefined();
    expect(at('{"name"|: "A"}')).toMatchObject({ partial: 'name' });
  });
});
