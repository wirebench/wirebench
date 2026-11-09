import { describe, expect, it } from 'vitest';
import {
  countMatches,
  createTypeAhead,
  highlightParts,
  isTypeAheadKey,
  matchesFilter,
  typeAheadIndex,
  TYPE_AHEAD_MS,
} from '../../src/renderer/features/explorer/explorer-filter.js';
import type { ExplorerNode } from '../../src/renderer/features/explorer/tree-nodes.js';

const node = (label: string, children?: ExplorerNode[], method?: string): ExplorerNode => ({
  id: label,
  kind: children === undefined ? 'rest-request' : 'folder',
  label,
  ...(children !== undefined ? { children } : {}),
  ...(method !== undefined ? { method } : {}),
});

describe('the Explorer filter', () => {
  it('matches a row by the name it shows, whatever the case', () => {
    expect(matchesFilter(node('List pets'), 'PET')).toBe(true);
    expect(matchesFilter(node('List pets'), 'dog')).toBe(false);
    // The method its badge shows is not part of the name.
    expect(matchesFilter(node('GET /pets', undefined, 'GET'), 'get')).toBe(false);
    expect(matchesFilter(node('anything'), '  ')).toBe(true);
  });

  it('counts the matching rows at any depth', () => {
    const tree = [node('Pets', [node('List pets'), node('Create pet'), node('Health')])];
    expect(countMatches(tree, 'pet')).toBe(3);
    expect(countMatches(tree, 'zebra')).toBe(0);
  });

  it('cuts a name at every match, keeping its own case', () => {
    expect(highlightParts('Pet pets', 'pet')).toEqual([
      { text: 'Pet', match: true },
      { text: ' ', match: false },
      { text: 'pet', match: true },
      { text: 's', match: false },
    ]);
    expect(highlightParts('Health', '')).toEqual([{ text: 'Health', match: false }]);
  });
});

describe('type-ahead', () => {
  const names = ['Add', 'Divide', 'Multiply', 'Subtract', 'Sum'];

  it('moves to the next row starting with a letter, wrapping round', () => {
    expect(typeAheadIndex(names, 0, 's')).toBe(3);
    expect(typeAheadIndex(names, 3, 's')).toBe(4);
    expect(typeAheadIndex(names, 4, 's')).toBe(3);
    expect(typeAheadIndex(names, -1, 'a')).toBe(0);
    expect(typeAheadIndex(names, 0, 'z')).toBeUndefined();
  });

  it('keeps to the current row while the word typed still fits it', () => {
    expect(typeAheadIndex(names, 3, 'su')).toBe(3);
    expect(typeAheadIndex(names, 3, 'sum')).toBe(4);
  });

  it('takes printable characters only, leaving Space, * and chords alone', () => {
    const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) => ({
      key: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...mods,
    });
    expect(isTypeAheadKey(key('m'))).toBe(true);
    expect(isTypeAheadKey(key('M'))).toBe(true);
    expect(isTypeAheadKey(key('/'))).toBe(true);
    expect(isTypeAheadKey(key(' '))).toBe(false);
    expect(isTypeAheadKey(key('*'))).toBe(false);
    expect(isTypeAheadKey(key('Enter'))).toBe(false);
    expect(isTypeAheadKey(key('F2'))).toBe(false);
    expect(isTypeAheadKey(key('Delete'))).toBe(false);
    expect(isTypeAheadKey(key('d', { metaKey: true }))).toBe(false);
  });

  it('forgets the word once half a second passes without a key', () => {
    let now = 1_000;
    const typed = createTypeAhead(() => now);
    expect(typed('s')).toBe('s');
    now += 100;
    expect(typed('u')).toBe('su');
    now += TYPE_AHEAD_MS + 1;
    expect(typed('a')).toBe('a');
  });
});
