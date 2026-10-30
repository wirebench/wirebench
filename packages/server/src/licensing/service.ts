// packages/server/src/licensing/service.ts
/**
 * The license service and the two writes (licensing spec §3.6, §3.7, §5.1). The endpoints and the
 * command line both call `installLicense` and `removeLicense`, so they can never disagree. Every read and
 * write is in one tenant's unit: each tenant has its own license row, and its seats are its own users
 * (hosted edition spec §19.8 guard 5).
 */
import type { KeyObject } from 'node:crypto';
import { COMMUNITY_SEATS, type LicenseState } from '@wirebench/engine';
import type { LicenseChanged, LicenseService, Querier } from '../context.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import type { ScopeSource } from '../tenancy/urls.js';
import { licenseInvalid } from './errors.js';
import { verifyLicense } from './format.js';
import { requireFeature } from './gate.js';
import * as repo from './repo.js';
import { assertSeatAvailable, countEnabledUsers } from './seats.js';
import { licenseState } from './state.js';

export interface LicenseEnv {
  readonly tenancy: Pick<Tenancy, 'db' | 'forEachTenant'>;
  readonly publicKeys: readonly KeyObject[];
  readonly now: () => Date;
  /**
   * The id licenses are bound to (license-binding spec §3.1), read through the unit at hand: `server_identity`
   * is server-wide, so any tenant's unit reads the same row.
   */
  readonly serverId: (db: Querier) => Promise<string>;
}

/** Reads the server id once, on first use, and keeps it; a failed read is tried again next time. */
export function cachedServerId(): (db: Querier) => Promise<string> {
  let cached: Promise<string> | undefined;
  return (db) => {
    cached ??= repo.serverId(db).catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}

/** The job that reads the license of a server whose jobs do not run per tenant yet. */
export const STATE_WITHOUT_SCOPE_JOB = 'license-without-scope';

export function createLicenseService(env: LicenseEnv): LicenseService {
  // The stored license and the seat count in one unit: every feature check pays for it.
  const stateIn = async (tx: TenantQuerier): Promise<LicenseState> =>
    licenseState(
      (await repo.storedLicense(tx))?.text,
      env.publicKeys,
      env.now(),
      await countEnabledUsers(tx),
      await env.serverId(tx),
    );
  const state = (of: ScopeSource, tx?: TenantQuerier): Promise<LicenseState> =>
    tx !== undefined ? stateIn(tx) : env.tenancy.db('tenantId' in of ? of : of.tenant).transaction(stateIn);
  return {
    state,
    assertSeatAvailable: (tx) => assertSeatAvailable(tx, stateIn),
    requireFeature: (feature) => requireFeature(feature, (request) => state(request)),
    stateWithoutScope: async () => {
      const states: LicenseState[] = [];
      let failure: Error | undefined;
      await env.tenancy.forEachTenant(
        STATE_WITHOUT_SCOPE_JOB,
        async (tx) => {
          try {
            states.push(await stateIn(tx));
          } catch (error) {
            failure ??= error instanceof Error ? error : new Error(String(error));
            throw error;
          }
        },
        // The failure is the caller's to log, with its job's name: it is thrown below.
        { error: () => undefined },
      );
      if (failure !== undefined) throw failure;
      // One tenant is a self-hosted server, whose license this is. With several, which only hosted-mode
      // tests make, no one license is the server's, and Community grants no feature.
      return states.length === 1
        ? states[0]!
        : { edition: 'community', status: 'none', seats: { used: 0, limit: COMMUNITY_SEATS }, features: [] };
    },
  };
}

/**
 * Verifies first: a file that fails is not stored, so a broken paste can never replace a working
 * license (§3.6). An expired but genuine license is stored; it is reported as grace or expired.
 */
export async function installLicense(
  env: LicenseEnv,
  scope: TenantScope,
  text: string,
  actorUserId: string | null,
): Promise<LicenseChanged> {
  const trimmed = text.trim();
  return env.tenancy.db(scope).transaction(async (tx) => {
    const verified = verifyLicense(trimmed, env.publicKeys, env.now(), await env.serverId(tx));
    if (!verified.ok) throw licenseInvalid(verified.message);
    await repo.putLicense(tx, {
      text: trimmed,
      licenseId: verified.license.id,
      installedBy: actorUserId,
      at: env.now(),
    });
    return { action: 'installed', licenseId: verified.license.id, edition: verified.license.edition, actorUserId };
  });
}

/** `undefined` when no license was stored: nothing changed, so nothing is announced. */
export async function removeLicense(
  env: Pick<LicenseEnv, 'tenancy'>,
  scope: TenantScope,
  actorUserId: string | null,
): Promise<LicenseChanged | undefined> {
  return env.tenancy.db(scope).transaction(async (tx) => {
    const stored = await repo.storedLicense(tx);
    if (stored === undefined || !(await repo.deleteLicense(tx))) return undefined;
    return { action: 'removed', licenseId: stored.licenseId, actorUserId };
  });
}
