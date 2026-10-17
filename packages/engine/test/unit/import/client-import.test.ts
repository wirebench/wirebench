import { describe, expect, it } from 'vitest';
import { flattenValue } from '../../../src/import/client-import.js';

describe('flattenValue', () => {
  it('flattens nested objects and arrays', () => {
    expect(flattenValue('v', { db: { host: 'x', port: 5432 }, ids: [1, true], none: null })).toEqual([
      ['v.db.host', 'x'],
      ['v.db.port', '5432'],
      ['v.ids.0', '1'],
      ['v.ids.1', 'true'],
      ['v.none', ''],
    ]);
  });

  it('keeps a string as it is, and an empty container as its JSON', () => {
    expect(flattenValue('name', 'a {{b}}')).toEqual([['name', 'a {{b}}']]);
    expect(flattenValue('empty', {})).toEqual([['empty', '{}']]);
    expect(flattenValue('list', [])).toEqual([['list', '[]']]);
  });
});
