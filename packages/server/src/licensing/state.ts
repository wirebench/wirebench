/**
 * `licenseState` (licensing spec §3.3): what a stored license means right now. Pure and computed on
 * demand, never cached: every input is in memory or one cheap query, and a single-instance server has no
 * cache to keep coherent (ADR-0013).
 */
import type { KeyObject } from 'node:crypto';
import {
  COMMUNITY_SEATS,
  FEATURES,
  GRACE_DAYS,
  type Feature,
  type LicensePayload,
  type LicenseState,
} from '@wirebench/engine';
import { verifyLicense } from './format.js';

export const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

/** §2: an explicit list grants exactly those; otherwise Enterprise grants all and Team none. */
export function grantedFeatures(license: LicensePayload): Feature[] {
  if (license.features !== undefined) return FEATURES.filter((feature) => license.features!.includes(feature));
  return license.edition === 'enterprise' ? [...FEATURES] : [];
}

export function licenseState(
  stored: string | undefined,
  publicKeys: readonly KeyObject[],
  now: Date,
  seatsUsed: number,
  serverId: string,
): LicenseState {
  const community = { edition: 'community' as const, seats: { used: seatsUsed, limit: COMMUNITY_SEATS }, serverId };
  if (stored === undefined) return { ...community, status: 'none', features: [] };
  const verified = verifyLicense(stored, publicKeys, now, serverId);
  // Reported rather than treated as absent, so an admin notices a key rotation they missed (§6).
  if (!verified.ok) {
    return { ...community, status: 'invalid', features: [], reason: verified.reason, message: verified.message };
  }
  const license = verified.license;
  const expires = Date.parse(license.expiresAt);
  const facts = {
    licenseId: license.id,
    customer: license.customer,
    issuedAt: license.issuedAt,
    expiresAt: license.expiresAt,
    graceUntil: new Date(expires + GRACE_MS).toISOString(),
  };
  if (now.getTime() >= expires + GRACE_MS) return { ...community, status: 'expired', features: [], ...facts };
  return {
    edition: license.edition,
    status: now.getTime() < expires ? 'active' : 'grace',
    seats: { used: seatsUsed, limit: license.seats },
    features: grantedFeatures(license),
    serverId,
    ...facts,
  };
}
