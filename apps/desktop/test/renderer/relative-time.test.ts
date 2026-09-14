import { describe, expect, it } from 'vitest';
import { formatRelative } from '../../src/renderer/features/sync/relative-time.js';

describe('formatRelative', () => {
  const now = new Date('2026-09-14T12:00:00Z');

  it('says "just now" for anything under 45 seconds', () => {
    expect(formatRelative('2026-09-14T11:59:20Z', now)).toBe('just now');
  });

  it('rounds to minutes under an hour', () => {
    expect(formatRelative('2026-09-14T11:57:00Z', now)).toBe('3 min ago');
  });

  it('rounds to hours under a day', () => {
    expect(formatRelative('2026-09-14T09:00:00Z', now)).toBe('3 hr ago');
  });

  it('rounds to days under a month, singular for one day', () => {
    expect(formatRelative('2026-09-13T12:00:00Z', now)).toBe('1 day ago');
    expect(formatRelative('2026-09-11T12:00:00Z', now)).toBe('3 days ago');
  });

  it('returns an empty string for an unparsable timestamp', () => {
    expect(formatRelative('not-a-date', now)).toBe('');
  });
});
