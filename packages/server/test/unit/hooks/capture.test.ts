import { describe, expect, it } from 'vitest';
import { headerPairs, splitTarget, subpathOf, truncateBody } from '../../../src/hooks/capture.js';

describe('capture helpers (webhook-capture §3.2, §3.3)', () => {
  it('pairs raw headers in arrival order, repeats and spelling kept', () => {
    expect(headerPairs(['Host', 'x', 'Via', '1.1 a', 'set-cookie', 'a=1', 'Via', '1.1 b'])).toEqual([
      ['Host', 'x'],
      ['Via', '1.1 a'],
      ['set-cookie', 'a=1'],
      ['Via', '1.1 b'],
    ]);
    expect(headerPairs([])).toEqual([]);
  });

  it('splits the target at the first ?, keeping both halves encoded', () => {
    expect(splitTarget('/hooks/S/a%20b?x=1&y=%3F?z')).toEqual({ path: '/hooks/S/a%20b', query: 'x=1&y=%3F?z' });
    expect(splitTarget('/hooks/S')).toEqual({ path: '/hooks/S', query: '' });
    expect(splitTarget('/hooks/S?')).toEqual({ path: '/hooks/S', query: '' });
  });

  it("takes what follows /hooks/<secret>: '' or '/…'", () => {
    expect(subpathOf('/hooks/SECRET')).toBe('');
    expect(subpathOf('/hooks/SECRET/')).toBe('/');
    expect(subpathOf('/hooks/SECRET/payments/events')).toBe('/payments/events');
  });

  it('stores up to the limit: exactly the limit is whole, one byte more is cut and marked', () => {
    const limit = 8;
    const exact = Buffer.alloc(limit, 1);
    expect(truncateBody(exact, limit)).toEqual({ body: exact, bodySize: 8, truncated: false });
    const over = Buffer.alloc(limit + 1, 2);
    const cut = truncateBody(over, limit);
    expect(cut).toEqual({ body: Buffer.alloc(limit, 2), bodySize: 9, truncated: true });
    expect(truncateBody(Buffer.alloc(0), limit)).toEqual({ body: Buffer.alloc(0), bodySize: 0, truncated: false });
  });
});
