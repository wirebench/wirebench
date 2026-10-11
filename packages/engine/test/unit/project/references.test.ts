import { describe, expect, it } from 'vitest';
import { expand } from '../../../src/project/properties.js';
import { propertyReferences } from '../../../src/project/references.js';

describe('propertyReferences', () => {
  it('finds the shorthand, scoped, secret and dynamic forms with their spans', () => {
    const text = 'a ${host} b ${#Env#port} c ${secret:token} d ${$guid} e ${#Dynamic#randomInt(1,5)}';
    expect(propertyReferences(text)).toEqual([
      { start: 2, end: 9, form: 'shorthand', name: 'host' },
      { start: 12, end: 24, form: 'scoped', scope: 'Env', name: 'port' },
      { start: 27, end: 42, form: 'secret', scope: 'Secret', name: 'token' },
      { start: 45, end: 53, form: 'dynamic', scope: 'Dynamic', name: 'guid' },
      { start: 56, end: 82, form: 'dynamic', scope: 'Dynamic', name: 'randomInt' },
    ]);
  });

  it('skips the $${ escape, including a run of three dollars', () => {
    expect(propertyReferences('$${x} and $$${y}')).toEqual([]);
  });

  it('reports a reference whose name is built from another as nested', () => {
    expect(propertyReferences('${${#Env#which}}')).toEqual([
      { start: 0, end: 16, form: 'nested', name: '${#Env#which}' },
    ]);
  });

  it('reports an unknown scope and an unterminated reference', () => {
    expect(propertyReferences('${#Foo#x} ${oops')).toEqual([
      { start: 0, end: 9, form: 'unknown-scope', scope: 'Foo', name: 'x' },
      { start: 10, end: 16, form: 'malformed', name: '' },
    ]);
  });

  it('keeps System and Sequence as scoped references', () => {
    expect(propertyReferences('${#System#HOME}${#Sequence#id}').map((ref) => ref.scope)).toEqual([
      'System',
      'Sequence',
    ]);
  });

  it('agrees with expand() on where every unresolved reference sits', () => {
    const texts = [
      'http://${host}:${#Env#port}/x',
      '$${skip} ${a}${b}',
      '<x>${#Project#a}</x>\n<y>${#Foo#b}</y>',
      '${${#Env#n}} tail ${unterminated',
      'é ${naïve} ${#Global#g}',
    ];
    for (const text of texts) {
      // expand() may report one span twice (the inner reference, then the name it failed to build).
      const spans = expand(text, { project: {}, global: {}, system: {} }).unresolved.map(
        (ref) => `${ref.start}-${ref.end}`,
      );
      const fromExpand = [...new Set(spans)].map((span) => span.split('-').map(Number));
      const fromScanner = propertyReferences(text).map((ref) => [ref.start, ref.end]);
      expect(fromScanner, text).toEqual(fromExpand);
    }
  });
});
