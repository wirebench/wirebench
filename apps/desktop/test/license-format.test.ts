// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { LicenseStateWire } from '../src/shared/wire-types.js';
import { bannerText, licenseLineProblem } from '../src/renderer/state/license-format.js';

describe('licenseLineProblem (licensing spec §3.8)', () => {
  it('accepts a license line, surrounding whitespace included', () => {
    expect(licenseLineProblem('  wbl1.eyJhIjoxfQ.c2ln\n')).toBeUndefined();
  });

  it.each([
    ['', 'Paste a license, or choose a license file.'],
    ['hello', 'This is not a Wirebench license. A license is one line that starts with "wbl1.".'],
    ['wbl1.eyJh', 'This is not a Wirebench license. A license is one line that starts with "wbl1.".'],
  ])('refuses %j', (input, message) => {
    expect(licenseLineProblem(input)).toBe(message);
  });
});

describe('bannerText (licensing spec §3.8)', () => {
  const base: LicenseStateWire = { edition: 'team', status: 'none', seats: { used: 7, limit: 50 }, features: [] };

  it('says when the license expired and until when everything keeps working', () => {
    expect(
      bannerText({
        ...base,
        status: 'grace',
        expiresAt: '2027-09-01T00:00:00Z',
        graceUntil: '2027-10-01T00:00:00.000Z',
      }),
    ).toBe("This server's license expired on 2027-09-01. Everything keeps working until 2027-10-01.");
  });

  it('says the server is Community after expiry, with the seats in use', () => {
    expect(bannerText({ ...base, edition: 'community', status: 'expired', seats: { used: 7, limit: 5 } })).toBe(
      'This server is on the Community edition. 7 of 5 seats are in use.',
    );
  });

  it('says nothing otherwise', () => {
    for (const status of ['none', 'active', 'invalid'] as const)
      expect(bannerText({ ...base, status })).toBeUndefined();
  });
});
