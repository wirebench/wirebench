import { describe, expect, it } from 'vitest';
import { describeLicense } from '../../../src/licensing/cli.js';

describe('describeLicense (licensing spec §3.7)', () => {
  it('prints a fresh server', () => {
    expect(describeLicense({ edition: 'community', status: 'none', seats: { used: 2, limit: 5 }, features: [] })).toBe(
      'Edition     Community (none)\nSeats       2 of 5\n',
    );
  });

  it('prints the server id first, when the state has one', () => {
    expect(
      describeLicense({
        edition: 'community',
        status: 'none',
        seats: { used: 2, limit: 5 },
        features: [],
        serverId: '0b6f3c2e-5d1a-4c7e-9f3b-2a8d4e6c1f90',
      }),
    ).toBe('Server id   0b6f3c2e-5d1a-4c7e-9f3b-2a8d4e6c1f90\nEdition     Community (none)\nSeats       2 of 5\n');
  });

  it('prints a license in grace, with its customer, id, features and grace end', () => {
    expect(
      describeLicense({
        edition: 'enterprise',
        status: 'grace',
        seats: { used: 12, limit: null },
        features: ['audit-log'],
        licenseId: '01J9ZK3V8Q0000000000000000',
        customer: 'Example AG',
        issuedAt: '2026-09-01T00:00:00Z',
        expiresAt: '2027-09-01T00:00:00Z',
        graceUntil: '2027-10-01T00:00:00.000Z',
      }),
    ).toBe(
      [
        'Edition     Enterprise (grace)',
        'Customer    Example AG',
        'License     01J9ZK3V8Q0000000000000000',
        'Seats       12 of unlimited',
        'Expires     2027-09-01T00:00:00Z',
        'Grace until 2027-10-01T00:00:00.000Z',
        'Features    audit-log',
        '',
      ].join('\n'),
    );
  });

  it('prints why a stored license is invalid', () => {
    expect(
      describeLicense({
        edition: 'community',
        status: 'invalid',
        seats: { used: 1, limit: 5 },
        features: [],
        reason: 'bad-signature',
        message: 'The license signature does not match.',
      }),
    ).toContain('Problem     The license signature does not match.\n');
  });
});
