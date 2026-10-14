import { describe, expect, it } from 'vitest';
import { expand, secretNamesIn } from '../../../src/project/properties.js';
import type { PropertyScopes } from '../../../src/project/properties.js';

function scopes(data: Record<string, string>, env: Record<string, string> = {}): PropertyScopes {
  return {
    project: { user: 'project-user' },
    env: { user: 'env-user', ...env },
    global: {},
    system: { HOME: '/home/alice' },
    secrets: { k: 'hunter2-keychain' },
    data,
  };
}

describe('the Data scope (#336)', () => {
  it('resolves ${#Data#column} when the row has it, and is missing when not', () => {
    expect(expand('user=${#Data#user}', scopes({ user: 'ann' })).text).toBe('user=ann');
    const result = expand('${#Data#user}', scopes({}));
    expect(result.text).toBe('${#Data#user}');
    expect(result.unresolved).toMatchObject([{ scope: 'Data', name: 'user', code: 'missing' }]);
  });

  it('is missing outside a data-driven run', () => {
    const without: PropertyScopes = { project: {}, global: {} };
    expect(expand('${#Data#user}', without).unresolved).toMatchObject([{ code: 'missing' }]);
  });

  it('is reached by the ${name} shorthand last, so a column never shadows a property (#560)', () => {
    expect(expand('${user}', scopes({ user: 'ann' })).text).toBe('env-user');
    const only = expand('${only}', scopes({ only: 'x' }));
    expect(only.text).toBe('x');
    expect(only.unresolved).toEqual([]);
    expect(only.used).toEqual([{ scope: 'Data', name: 'only' }]);
    expect(expand('${only}', scopes({})).unresolved).toMatchObject([{ name: 'only', code: 'missing' }]);
  });

  it('substitutes a cell the shorthand reaches literally too', () => {
    for (const value of ['${secret:k}', '${#System#HOME}', '${user}', '$${y}']) {
      const result = expand('v=${cell}', scopes({ cell: value }));
      expect(result.text).toBe(`v=${value}`);
      expect(result.unresolved).toEqual([]);
    }
  });

  it('reaches a cell by the shorthand from a chained Env value', () => {
    expect(expand('${#Env#greeting}', scopes({ name: 'ann' }, { greeting: 'hi ${name}' })).text).toBe('hi ann');
  });

  it('substitutes a cell literally: its own references are not expanded', () => {
    for (const value of ['${secret:k}', '${#System#HOME}', '${user}', '$${y}']) {
      const result = expand('v=${#Data#cell}', scopes({ cell: value }));
      expect(result.text).toBe(`v=${value}`);
      expect(result.unresolved).toEqual([]);
    }
  });

  it('XML-escapes a cell when the expansion entitizes', () => {
    expect(expand('<a>${#Data#cell}</a>', scopes({ cell: 'x<y&z' }), { entitize: true }).text).toBe(
      '<a>x&lt;y&amp;z</a>',
    );
  });

  it('reaches a cell from a chained Env value', () => {
    expect(expand('${#Env#greeting}', scopes({ user: 'ann' }, { greeting: 'hi ${#Data#user}' })).text).toBe('hi ann');
  });

  it('reads a column named like an object key only when the row has it', () => {
    expect(expand('${#Data#constructor}', scopes({})).unresolved).toMatchObject([{ code: 'missing' }]);
    const row = Object.create(null) as Record<string, string>;
    row['__proto__'] = 'p';
    expect(expand('${#Data#__proto__}', scopes(row)).text).toBe('p');
  });

  it('reports what it used', () => {
    expect(expand('${#Data#id}', scopes({ id: '7' })).used).toEqual([{ scope: 'Data', name: 'id' }]);
  });

  it('never leads secretNamesIn to a secret inside a cell', () => {
    expect(secretNamesIn('${#Data#cell}', scopes({ cell: '${secret:k}' }))).toEqual([]);
    expect(secretNamesIn('${cell}', scopes({ cell: '${secret:k}' }))).toEqual([]);
  });
});
