import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../../src/audit-log/cursor.js';

describe('audit cursor (plan ruling 12)', () => {
  const cursor = { at: '2026-10-01T12:34:56.789Z', id: '01J9ZK3V8Q0000000000000001' };
  it('round-trips and is opaque base64url', () => {
    const text = encodeCursor(cursor);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(text)).toEqual(cursor);
  });
  it('refuses junk, a missing separator, a bad date and a bad id', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    for (const bad of [
      '',
      '!!!',
      b64('nodash'),
      b64('yesterday|01J9ZK3V8Q0000000000000001'),
      b64('2026-10-01T12:34:56.789Z|short'),
      b64('a|b|c'),
    ]) {
      expect(() => decodeCursor(bad)).toThrow(/cursor/);
    }
  });
});
