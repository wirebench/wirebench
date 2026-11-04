/**
 * Slug uniqueness across three tables (hosted edition spec §22.3): `tenants`, the open `signups` and
 * `tenant_slugs_retired`. One index cannot span them, so every slug write takes {@link SLUG_LOCK} on the control role
 * first and checks all three in the same transaction: two writers of one slug wait on each other, and the second
 * finds the first's row. A retired slug is never written again (§22.8), and a pending signup holds its slug until it
 * expires (§22.6).
 */
import { problem } from '../problem.js';
import { LOCK_SCHEMA_KEY } from '../tenancy/running-lock.js';
import { checkSlug } from '../tenancy/slugs.js';
import type { ControlDb } from './control-db.js';

/** The lock's class ("WBSL"), beside the server's other advisory-lock classes; the schema's hash is the other half. */
export const SLUG_LOCK_CLASS = 0x5742534c;

/** Held until the control transaction ends. */
export const SLUG_LOCK = `select pg_advisory_xact_lock(${String(SLUG_LOCK_CLASS)}, ${LOCK_SCHEMA_KEY})`;

/** A control transaction's querier. */
export type ControlTx = Parameters<Parameters<ControlDb['transaction']>[0]>[0];

/** Where a slug stands: free, or why not. */
export type SlugState = 'ok' | 'slug-invalid' | 'slug-reserved' | 'slug-taken';

/**
 * `slug` checked as every writer checks it: `checkSlug` (syntax and the reserved list, §21.2), then free in all three
 * tables. Takes the slug lock first, so the answer holds until `tx` ends.
 */
export async function slugState(tx: ControlTx, slug: string): Promise<SlugState> {
  const syntax = checkSlug(slug);
  if (syntax !== 'ok') return syntax;
  await tx.query(SLUG_LOCK);
  const rows = await tx.query<{ taken: boolean }>(
    `select exists (select 1 from tenants where slug = $1)
         or exists (select 1 from signups where slug = $1 and status <> 'completed')
         or exists (select 1 from tenant_slugs_retired where slug = $1) as taken`,
    [slug],
  );
  return rows.rows[0]?.taken === true ? 'slug-taken' : 'ok';
}

/**
 * Takes `slug` for a write in `tx`, or refuses it.
 *
 * @throws WirebenchError `tenancy-slug-invalid`, `tenancy-slug-reserved` (as `TenantAdmin.create`), or
 *   `control-plane-slug-taken` when a tenant, an open signup or a retired slug has it
 */
export async function claimSlug(tx: ControlTx, slug: string): Promise<void> {
  const state = await slugState(tx, slug);
  if (state === 'slug-invalid') throw problem('tenancy-slug-invalid', 'that slug is not a valid tenant slug', 400);
  if (state === 'slug-reserved') throw problem('tenancy-slug-reserved', 'that slug is reserved', 409);
  if (state === 'slug-taken') {
    throw problem('control-plane-slug-taken', `the slug "${slug}" is taken, held by a signup, or retired`, 409);
  }
}
