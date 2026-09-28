/**
 * Types are erased in place, so a run-time error's line and column match the file. The output of a
 * fixture is pinned: a change in how Node strips shows up here, not in a user's script.
 */
import { describe, expect, it } from 'vitest';
import { StripError, stripTypes } from '../../../src/script/strip.js';

describe('stripTypes', () => {
  it('erases types in place', () => {
    const source = [
      'interface Pet { id: number; name?: string }',
      'const pet: Pet = response.json() as Pet;',
      'function name(p: Pet): string { return p.name ?? "" }',
      'type Id = Pet["id"];',
      'test("has an id", () => expect(pet.id satisfies Id).toBeDefined());',
    ].join('\n');
    const stripped = stripTypes(source);
    expect(stripped).toMatchInlineSnapshot(`
      "                                           
      const pet      = response.json()       ;
      function name(p     )         { return p.name ?? "" }
                          
      test("has an id", () => expect(pet.id             ).toBeDefined());"
    `);
    const lines = source.split('\n');
    const strippedLines = stripped.split('\n');
    expect(strippedLines.map((line) => line.length)).toEqual(lines.map((line) => line.length));
    expect(strippedLines[4]?.indexOf('toBeDefined')).toBe(lines[4]?.indexOf('toBeDefined'));
  });

  it('refuses syntax that cannot be erased', () => {
    expect(() => stripTypes('enum Color { Red }')).toThrow(StripError);
    expect(() => stripTypes('namespace A { export const x = 1 }')).toThrow(StripError);
  });

  it('does not print the experimental warning', () => {
    const warnings: string[] = [];
    const listener = (warning: Error): void => {
      warnings.push(warning.message);
    };
    process.on('warning', listener);
    try {
      stripTypes('const a: number = 1;');
    } finally {
      process.off('warning', listener);
    }
    expect(warnings.filter((w) => w.includes('stripTypeScriptTypes'))).toEqual([]);
  });
});
