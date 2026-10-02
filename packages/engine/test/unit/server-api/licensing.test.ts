import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_SEATS,
  GRACE_DAYS,
  LICENSE_TEXT_PATTERN,
  licenseInstallRequestSchema,
  licensePayloadSchema,
  licenseStateSchema,
  metaResponseSchema,
} from '../../../src/index.js';

const PAYLOAD = {
  id: '01J9ZK3V8Q0000000000000000',
  customer: 'Example AG',
  edition: 'team',
  seats: 50,
  issuedAt: '2026-09-01T00:00:00Z',
  expiresAt: '2027-09-01T00:00:00Z',
};

describe('licensing wire shapes (licensing spec §3.1, §3.3)', () => {
  it('fixes the product terms', () => {
    expect(COMMUNITY_SEATS).toBe(5);
    expect(GRACE_DAYS).toBe(30);
  });

  it('accepts the spec payload, with and without features, and unlimited seats', () => {
    expect(licensePayloadSchema.parse(PAYLOAD)).toEqual(PAYLOAD);
    expect(licensePayloadSchema.parse({ ...PAYLOAD, features: ['audit-log'] }).features).toEqual(['audit-log']);
    expect(licensePayloadSchema.parse({ ...PAYLOAD, seats: null }).seats).toBeNull();
  });

  it('keeps a feature name it does not know, so a newer signer does not break an older server', () => {
    expect(licensePayloadSchema.parse({ ...PAYLOAD, features: ['scim'] }).features).toEqual(['scim']);
  });

  it.each([
    ['an unknown key', { ...PAYLOAD, serverId: 'x' }],
    ['community as an edition', { ...PAYLOAD, edition: 'community' }],
    ['zero seats', { ...PAYLOAD, seats: 0 }],
    ['fractional seats', { ...PAYLOAD, seats: 1.5 }],
    ['an id that is not a ULID', { ...PAYLOAD, id: 'license-1' }],
    ['a date that is not ISO 8601', { ...PAYLOAD, expiresAt: 'next year' }],
    ['an empty customer', { ...PAYLOAD, customer: '' }],
  ])('refuses %s', (_name, payload) => {
    expect(licensePayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('matches a license line and nothing else', () => {
    expect(LICENSE_TEXT_PATTERN.test('wbl1.eyJh.c2ln')).toBe(true);
    expect(LICENSE_TEXT_PATTERN.test('wbl2.eyJh.c2ln')).toBe(false);
    expect(LICENSE_TEXT_PATTERN.test('wbl1.eyJh')).toBe(false);
    expect(LICENSE_TEXT_PATTERN.test('wbl1.ey Jh.c2ln')).toBe(false);
  });

  it('parses a Community state and a Team state', () => {
    expect(
      licenseStateSchema.parse({
        edition: 'community',
        status: 'none',
        seats: { used: 2, limit: 5 },
        features: [],
      }).seats,
    ).toEqual({ used: 2, limit: 5 });
    expect(
      licenseStateSchema.parse({
        edition: 'team',
        status: 'grace',
        seats: { used: 7, limit: null },
        features: [],
        licenseId: PAYLOAD.id,
        customer: 'Example AG',
        issuedAt: PAYLOAD.issuedAt,
        expiresAt: PAYLOAD.expiresAt,
        graceUntil: '2027-10-01T00:00:00.000Z',
      }).status,
    ).toBe('grace');
  });

  it('parses a state from a newer server: an unknown feature and an unknown invalid reason', () => {
    const state = licenseStateSchema.parse({
      edition: 'enterprise',
      status: 'invalid',
      seats: { used: 1, limit: null },
      features: ['scim'],
      reason: 'future-reason',
    });
    expect(state.features).toEqual(['scim']);
    expect(state.reason).toBe('future-reason');
  });

  it('bounds the install body', () => {
    expect(licenseInstallRequestSchema.safeParse({ license: '' }).success).toBe(false);
    expect(licenseInstallRequestSchema.safeParse({ license: 'x'.repeat(8193) }).success).toBe(false);
  });

  it('lets /meta carry an edition and still parses an older server without one', () => {
    const meta = {
      name: 'wirebench-server',
      version: '1.0.0',
      apiVersion: 1,
      publicUrl: 'https://wb.test',
      auth: { local: true, oidc: false },
      capabilities: [],
    };
    expect(metaResponseSchema.parse(meta).edition).toBeUndefined();
    expect(metaResponseSchema.parse({ ...meta, edition: 'enterprise' }).edition).toBe('enterprise');
    expect(metaResponseSchema.safeParse({ ...meta, edition: 'gold' }).success).toBe(false);
  });
});
