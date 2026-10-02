import { describe, expect, it } from 'vitest';
import { grantedFeatures, licenseState } from '../../../src/licensing/state.js';
import { license, PAYLOAD, testKeys } from '../../helpers/licensing.js';

const keys = testKeys();
const other = testKeys();
const at = (iso: string) => new Date(iso);
const state = (stored: string | undefined, now: string, used = 3) =>
  licenseState(stored, [keys.publicKey], at(now), used);

describe('licenseState (licensing spec §3.3)', () => {
  it('is Community with 5 seats and status none when nothing is stored', () => {
    expect(state(undefined, '2026-09-24T12:00:00Z')).toEqual({
      edition: 'community',
      status: 'none',
      seats: { used: 3, limit: 5 },
      features: [],
    });
  });

  it('is Community and invalid, with the reason, when the stored text fails verification', () => {
    const s = licenseState(license(other), [keys.publicKey], at('2026-09-24T12:00:00Z'), 3);
    expect(s).toMatchObject({ edition: 'community', status: 'invalid', reason: 'bad-signature', seats: { limit: 5 } });
    expect(s.message).toBeTypeOf('string');
  });

  it('is the license edition and seats while active', () => {
    expect(state(license(keys), '2026-09-24T12:00:00Z')).toEqual({
      edition: 'team',
      status: 'active',
      seats: { used: 3, limit: 50 },
      features: [],
      licenseId: PAYLOAD.id,
      customer: 'Example AG',
      issuedAt: PAYLOAD.issuedAt,
      expiresAt: PAYLOAD.expiresAt,
      graceUntil: '2027-10-01T00:00:00.000Z',
    });
  });

  it.each([
    ['one millisecond before expiry', '2027-08-31T23:59:59.999Z', 'active', 'team'],
    ['exactly at expiry', '2027-09-01T00:00:00.000Z', 'grace', 'team'],
    ['one millisecond before grace ends', '2027-09-30T23:59:59.999Z', 'grace', 'team'],
    ['exactly when grace ends', '2027-10-01T00:00:00.000Z', 'expired', 'community'],
  ])('%s → %s (%s)', (_name, now, status, edition) => {
    const s = state(license(keys), now);
    expect(s.status).toBe(status);
    expect(s.edition).toBe(edition);
    expect(s.seats.limit).toBe(edition === 'community' ? 5 : 50);
  });

  it('keeps the dates on an expired license so the banner can name them', () => {
    expect(state(license(keys), '2028-01-01T00:00:00Z')).toMatchObject({
      status: 'expired',
      licenseId: PAYLOAD.id,
      expiresAt: PAYLOAD.expiresAt,
      features: [],
    });
  });

  it('reports unlimited seats as a null limit', () => {
    expect(state(license(keys, { seats: null }), '2026-09-24T12:00:00Z').seats).toEqual({ used: 3, limit: null });
  });
});

describe('grantedFeatures (licensing spec §2)', () => {
  it('grants nothing on Team and every known feature on Enterprise', () => {
    expect(grantedFeatures(PAYLOAD)).toEqual([]);
    expect(grantedFeatures({ ...PAYLOAD, edition: 'enterprise' })).toEqual(['audit-log']);
  });

  it('grants exactly an explicit list, whatever the edition, ignoring names it does not know', () => {
    expect(grantedFeatures({ ...PAYLOAD, features: ['audit-log', 'scim'] })).toEqual(['audit-log']);
    expect(grantedFeatures({ ...PAYLOAD, edition: 'enterprise', features: [] })).toEqual([]);
  });
});
