import { describe, expect, it } from 'vitest';
import { paletteFilter, paletteKeywords } from '../../src/renderer/shell/palette-filter.js';

describe('paletteKeywords', () => {
  it('names the category and the label prefix', () => {
    expect(paletteKeywords({ category: 'Explorer', label: 'REST: New Request' })).toEqual(['Explorer', 'REST']);
  });

  it('names the category once when the prefix is the category', () => {
    expect(paletteKeywords({ category: 'History', label: 'History: Clear' })).toEqual(['History']);
  });

  it('names only the category for a label with no prefix', () => {
    expect(paletteKeywords({ category: 'Editor', label: 'Close Tab' })).toEqual(['Editor']);
  });
});

describe('paletteFilter', () => {
  const score = (category: string, label: string, search: string): number =>
    paletteFilter(`${category} ${label}`, search, paletteKeywords({ category, label }));

  it('ranks a command whose group the search names above a fuzzy hit', () => {
    const rest = score('Explorer', 'REST: New Request', 'REST');
    const closeTab = score('Editor', 'Close Tab', 'REST');

    expect(rest).toBe(1);
    expect(closeTab).toBeLessThan(rest);
  });

  it('matches a category prefix whatever its case', () => {
    expect(score('History', 'History: Clear', 'hist')).toBe(1);
  });

  it('keeps fuzzy matches, below a group match', () => {
    const fuzzy = score('Editor', 'Close Tab', 'close');

    expect(fuzzy).toBeGreaterThan(0);
    expect(fuzzy).toBeLessThan(1);
  });

  it('drops a command that does not match at all', () => {
    expect(score('Editor', 'Close Tab', 'zzzz')).toBe(0);
  });
});
