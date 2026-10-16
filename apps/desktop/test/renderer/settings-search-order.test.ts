import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS, sectionsForSearch } from '../../src/renderer/features/preferences/settings-model.js';

describe('sectionsForSearch (#594)', () => {
  it('lists the section the query names first, then sections it starts, then nav order', () => {
    const ids = (query: string): string[] => sectionsForSearch(query).map((s) => s.id);
    expect(ids('ssh')[0]).toBe('ssh');
    expect(ids('ssh').indexOf('ssh')).toBeLessThan(ids('ssh').indexOf('terminal'));
    expect(ids('mock')[0]).toBe('mocks');
    expect(ids('timeout')).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
  });
});
