import { describe, expect, it } from 'vitest';
import { expand, secretNamesIn } from '../../../src/project/properties.js';
import type { PropertyScopes } from '../../../src/project/properties.js';

/** Scopes with a real secret, an env chain and a system value a hostile response would like to reach. */
function scopes(sequence: Record<string, string>, env: Record<string, string> = {}): PropertyScopes {
  return {
    project: { baseUrl: 'https://api.example.test' },
    env: { baseUrl: 'https://staging.example.test', ...env },
    global: {},
    system: { HOME: '/home/alice' },
    secrets: { k: 'hunter2-keychain' },
    sequence,
  };
}

describe('the Sequence scope', () => {
  it('resolves ${#Sequence#x} when set, and is missing when not', () => {
    expect(expand('Bearer ${#Sequence#token}', scopes({ token: 'abc123' })).text).toBe('Bearer abc123');
    const result = expand('${#Sequence#token}', scopes({}));
    expect(result.text).toBe('${#Sequence#token}');
    expect(result.unresolved).toMatchObject([{ scope: 'Sequence', name: 'token', code: 'missing' }]);
  });

  it('is never reached by the ${name} shorthand', () => {
    const result = expand('${token}', scopes({ token: 'abc123' }));
    expect(result.text).toBe('${token}');
    expect(result.unresolved).toMatchObject([{ name: 'token', code: 'missing' }]);
  });

  it('cannot shadow a value the shorthand already resolves', () => {
    expect(expand('${baseUrl}', scopes({ baseUrl: 'https://evil.example' })).text).toBe('https://staging.example.test');
  });

  it('reports what it used', () => {
    expect(expand('${#Sequence#id}', scopes({ id: '7' })).used).toEqual([{ scope: 'Sequence', name: 'id' }]);
  });

  it('does not treat an inherited object key as a value', () => {
    expect(expand('${#Sequence#constructor}', scopes({})).unresolved).toMatchObject([{ code: 'missing' }]);
  });
});

describe('a Sequence value is data, never a template (ADR-0015)', () => {
  const hostile = ['${secret:k}', '${#System#HOME}', '${#Env#baseUrl}', '${baseUrl}', '$${y}', 'a ${secret:k} b'];

  it.each(hostile)('substitutes %s verbatim', (value) => {
    const result = expand('q=${#Sequence#next}', scopes({ next: value }));
    expect(result.text).toBe(`q=${value}`);
    expect(result.text).not.toContain('hunter2-keychain');
    expect(result.text).not.toContain('/home/alice');
    expect(result.unresolved).toEqual([]);
  });

  it.each(hostile)('substitutes %s verbatim through a chained Env reference', (value) => {
    const result = expand('${#Env#chain}', scopes({ next: value }, { chain: 'q=${#Sequence#next}' }));
    expect(result.text).toBe(`q=${value}`);
    expect(result.text).not.toContain('hunter2-keychain');
  });

  it('refuses a reference whose name comes from a Sequence value', () => {
    for (const text of ['${${#Sequence#n}}', '${#Env#${#Sequence#n}}', '${secret:${#Sequence#n}}']) {
      const result = expand(text, scopes({ n: 'secret:k' }));
      expect(result.text).toBe(text);
      expect(result.text).not.toContain('hunter2-keychain');
      expect(result.unresolved).toMatchObject([{ code: 'name-from-response' }]);
    }
  });

  it('refuses a name built from a Sequence value inside a chained Env value too', () => {
    const result = expand('${#Env#pick}', scopes({ n: 'k' }, { pick: '${secret:${#Sequence#n}}' }));
    expect(result.text).not.toContain('hunter2-keychain');
    expect(result.unresolved).toMatchObject([{ code: 'name-from-response' }]);
  });

  it('still lets a typed name pick a Sequence value', () => {
    expect(expand('${#Sequence#${#Env#which}}', scopes({ token: 'abc' }, { which: 'token' })).text).toBe('abc');
  });
});

describe('secretNamesIn and the Sequence scope', () => {
  it('does not follow a secret token inside a Sequence value', () => {
    expect(secretNamesIn('${#Sequence#x}', scopes({ x: '${secret:k}' }))).toEqual([]);
  });

  it('still finds secrets referenced directly beside one', () => {
    expect(secretNamesIn('${#Sequence#x} ${secret:k}', scopes({ x: '${secret:other}' }))).toEqual(['k']);
  });
});
