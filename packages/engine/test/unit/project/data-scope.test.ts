import { describe, expect, it } from 'vitest';
import { expand, secretNamesIn } from '#core/project/properties';
import type { PropertyScopes } from '#core/project/properties';

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

  it('is never reached by the ${name} shorthand: a column is read only as ${#Data#column} (D1, #569)', () => {
    expect(expand('${user}', scopes({ user: 'ann' })).text).toBe('env-user');
    const only = expand('${only}', scopes({ only: 'x' }));
    expect(only.text).toBe('${only}');
    expect(only.unresolved).toMatchObject([{ name: 'only', code: 'missing' }]);
    expect(only.used).toEqual([]);
    expect(expand('${#Data#only}', scopes({ only: 'x' })).text).toBe('x');
  });

  it('is not reached by the shorthand from a chained Env value either', () => {
    const chained = expand('${#Env#greeting}', scopes({ name: 'ann' }, { greeting: 'hi ${name}' }));
    expect(chained.unresolved).toMatchObject([{ name: 'name', code: 'missing' }]);
    expect(expand('${#Env#greeting}', scopes({ name: 'ann' }, { greeting: 'hi ${#Data#name}' })).text).toBe('hi ann');
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
