/**
 * The counts on the REST tabs that hold rows (#559): only rows that are sent count, and an empty
 * table shows no count at all, as the Assertions tab does.
 */
import { describe, expect, it } from 'vitest';
import { responseHeadersBadge, rowsBadge } from '../../src/renderer/features/rest-editor/tab-counts.js';

describe('rowsBadge', () => {
  it('counts the switched-on, named rows', () => {
    expect(
      rowsBadge([
        { name: 'a', enabled: true },
        { name: 'b', enabled: false },
        { name: '', enabled: true },
        { name: 'c', enabled: true },
      ]),
    ).toBe('2');
  });

  it('shows nothing for an empty table', () => {
    expect(rowsBadge([])).toBeUndefined();
    expect(rowsBadge([{ name: 'off', enabled: false }])).toBeUndefined();
  });
});

describe('responseHeadersBadge', () => {
  it('counts the headers as they came off the wire, a repeat twice', () => {
    expect(
      responseHeadersBadge({
        headers: { 'set-cookie': 'a, b' },
        rawHeaders: [
          ['Set-Cookie', 'a'],
          ['Set-Cookie', 'b'],
        ],
      }),
    ).toBe('2');
  });

  it('falls back to the joined map, and shows nothing for none', () => {
    expect(responseHeadersBadge({ headers: { a: '1', b: '2', c: '3' } })).toBe('3');
    expect(responseHeadersBadge({ headers: {} })).toBeUndefined();
  });
});
