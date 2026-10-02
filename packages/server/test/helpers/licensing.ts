/**
 * Licenses for tests (licensing spec §11): a key pair made in the test and passed to the module through
 * its options, never through configuration, so no environment variable can mint an edition.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { LicensePayload } from '@wirebench/engine';
import { ciTokensModule } from '../../src/ci-tokens/module.js';
import type { ServerModule } from '../../src/context.js';
import type { OidcProvider } from '../../src/identity/oidc.js';
import { hooksModule } from '../../src/hooks/module.js';
import { licensingModule } from '../../src/licensing/module.js';
import { teamsModule } from '../../src/teams/module.js';
import { identityHarness, type IdentityHarness, type TestClock } from './identity.js';

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

/**
 * Identity, then licensing with the test key, then teams, webhook capture and CI tokens, then any `extra`
 * modules, all on the harness clock. The middle three are only here for their migrations: versions are
 * checked for contiguity across modules, so 0007 cannot load without 0003 to 0006.
 */
export function licensingHarness(
  keys: TestKeys,
  options: {
    readonly env?: Record<string, string>;
    readonly provider?: OidcProvider;
    readonly logStream?: NodeJS.WritableStream;
    readonly extra?: (clock: TestClock) => readonly ServerModule[];
  } = {},
): Promise<IdentityHarness> {
  return identityHarness({
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.logStream !== undefined ? { logStream: options.logStream } : {}),
    modules: (clock) => [
      licensingModule({ now: () => clock.now, publicKeys: [keys.publicKey] }),
      teamsModule({ now: () => clock.now }),
      hooksModule({ now: () => clock.now }),
      ciTokensModule({ now: () => clock.now }),
      ...(options.extra?.(clock) ?? []),
    ],
  });
}
