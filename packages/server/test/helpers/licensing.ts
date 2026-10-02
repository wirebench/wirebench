/**
 * Licenses for tests (licensing spec §11): a key pair made in the test and passed to the module through
 * its options, never through configuration, so no environment variable can mint an edition.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { LicensePayload } from '@wirebench/engine';

export interface TestKeys {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

export function testKeys(): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey, privateKey };
}

/** A Team license for 50 seats, active on the identity harness clock (2026-09-24T12:00Z). */
export const PAYLOAD: LicensePayload = {
  id: '01J9ZK3V8Q0000000000000000',
  customer: 'Example AG',
  edition: 'team',
  seats: 50,
  issuedAt: '2026-09-01T00:00:00Z',
  expiresAt: '2027-09-01T00:00:00Z',
};

/** Signs any object, valid or not, as the signing tool would: over the payload segment's text. */
export function signLicense(payload: object, privateKey: KeyObject): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(body, 'ascii'), privateKey).toString('base64url');
  return `wbl1.${body}.${signature}`;
}

export function license(keys: TestKeys, overrides: Partial<LicensePayload> = {}): string {
  return signLicense({ ...PAYLOAD, ...overrides }, keys.privateKey);
}
