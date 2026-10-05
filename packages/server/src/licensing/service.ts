// packages/server/src/licensing/service.ts
/**
 * The license service and the two writes (licensing spec §3.6, §3.7, §5.1). The endpoints and the
 * command line both call `installLicense` and `removeLicense`, so they can never disagree.
 */
import type { KeyObject } from 'node:crypto';
import type { LicenseChanged, LicenseService, Querier } from '../context.js';
import { licenseInvalid } from './errors.js';
import { verifyLicense } from './format.js';
import { requireFeature } from './gate.js';
import * as repo from './repo.js';
import { assertSeatAvailable, countEnabledUsers } from './seats.js';
import { licenseState } from './state.js';

export interface LicenseEnv {
  readonly db: Querier;
  readonly publicKeys: readonly KeyObject[];
  readonly now: () => Date;
  /** The id licenses are bound to (license-binding spec §3.1). */
  readonly serverId: string;
}

export function createLicenseService(env: LicenseEnv): LicenseService {
  const state = async (tx: Querier = env.db) =>
    licenseState(
      (await repo.storedLicense(tx))?.text,
      env.publicKeys,
      env.now(),
      await countEnabledUsers(tx),
      env.serverId,
    );
  return {
    state,
    assertSeatAvailable: (tx) => assertSeatAvailable(tx, state),
    requireFeature: (feature) => requireFeature(feature, () => state()),
  };
}

/**
 * Verifies first: a file that fails is not stored, so a broken paste can never replace a working
 * license (§3.6). An expired but genuine license is stored; it is reported as grace or expired.
 */
export async function installLicense(
  env: LicenseEnv,
  text: string,
  actorUserId: string | null,
): Promise<LicenseChanged> {
  const trimmed = text.trim();
  const verified = verifyLicense(trimmed, env.publicKeys, env.now(), env.serverId);
  if (!verified.ok) throw licenseInvalid(verified.message);
  await repo.putLicense(env.db, {
    text: trimmed,
    licenseId: verified.license.id,
    installedBy: actorUserId,
    at: env.now(),
  });
  return { action: 'installed', licenseId: verified.license.id, edition: verified.license.edition, actorUserId };
}

/** `undefined` when no license was stored: nothing changed, so nothing is announced. */
export async function removeLicense(
  env: { readonly db: Querier },
  actorUserId: string | null,
): Promise<LicenseChanged | undefined> {
  const stored = await repo.storedLicense(env.db);
  if (stored === undefined || !(await repo.deleteLicense(env.db))) return undefined;
  return { action: 'removed', licenseId: stored.licenseId, actorUserId };
}
