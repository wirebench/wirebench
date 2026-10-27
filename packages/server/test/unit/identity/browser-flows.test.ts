import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from '../../../src/identity/browser-flows.js';
import { EVIL_REDIRECTS } from '../../helpers/identity.js';

const PUBLIC_URL = 'https://wirebench.test';

describe('safeRedirectPath (hosted spec §17.2)', () => {
  it.each(EVIL_REDIRECTS)('answers / for %j in a single application', (value) => {
    expect(safeRedirectPath(value, PUBLIC_URL)).toBe('/');
  });

  it('keeps a same-origin path, query and hash, with dot-segments resolved', () => {
    expect(safeRedirectPath('/a/../w/1?tab=a#x', PUBLIC_URL)).toBe('/w/1?tab=a#x');
    expect(safeRedirectPath('/', PUBLIC_URL)).toBe('/');
  });

  it('answers / for anything that is not a string or is too long', () => {
    expect(safeRedirectPath(undefined, PUBLIC_URL)).toBe('/');
    expect(safeRedirectPath(['/w/1'], PUBLIC_URL)).toBe('/');
    expect(safeRedirectPath(`/${'a'.repeat(2048)}`, PUBLIC_URL)).toBe('/');
  });
});
