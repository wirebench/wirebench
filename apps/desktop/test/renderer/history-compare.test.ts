import { describe, expect, it } from 'vitest';
import { compareBannerText, compareStep } from '../../src/renderer/features/history/history-compare.js';
import { formatClockTime } from '../../src/renderer/lib/format-size.js';

describe('compareStep', () => {
  it('arms the first entry picked', () => {
    expect(compareStep(undefined, 'a')).toEqual({ kind: 'arm', first: 'a' });
  });

  it('cancels when the armed entry is picked again', () => {
    expect(compareStep('a', 'a')).toEqual({ kind: 'cancel' });
  });

  it('compares the armed entry, on the left, with any other', () => {
    expect(compareStep('a', 'b')).toEqual({ kind: 'compare', first: 'a', second: 'b' });
  });
});

describe('compareBannerText', () => {
  it('names the picked entry as the list shows it, and when it was sent', () => {
    const at = '2026-10-15T20:06:50.000Z';
    expect(compareBannerText({ requestName: 'GET /pets', method: 'GET', at })).toBe(
      `Comparing with /pets · ${formatClockTime(at)}`,
    );
    expect(compareBannerText({ requestName: 'List pets', at })).toBe(
      `Comparing with List pets · ${formatClockTime(at)}`,
    );
  });
});
