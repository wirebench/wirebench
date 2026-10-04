// packages/engine/test/unit/import/templates.test.ts
import { describe, expect, it } from 'vitest';
import { rewriteMustache } from '../../../src/import/templates.js';

describe('rewriteMustache', () => {
  it('turns {{name}} into ${name}, trimming inner spaces', () => {
    expect(rewriteMustache('{{ baseUrl }}/v1/{{id}}')).toBe('${baseUrl}/v1/${id}');
  });

  it('escapes a literal ${ so it is not read as a property', () => {
    expect(rewriteMustache('cost: ${x} and {{y}}')).toBe('cost: $${x} and ${y}');
  });

  it('leaves dynamic {{$…}} variables as written and records them', () => {
    const seen = new Set<string>();
    expect(rewriteMustache('id={{$guid}}&t={{ $timestamp }}', seen)).toBe('id={{$guid}}&t={{ $timestamp }}');
    expect([...seen]).toEqual(['$guid', '$timestamp']);
  });

  it('leaves an empty {{}} alone', () => {
    expect(rewriteMustache('a{{}}b')).toBe('a{{}}b');
  });
});
