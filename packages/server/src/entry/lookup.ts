/**
 * Which teams an address belongs to (hosted edition spec §21.4, ADR-0038): one tenant unit per resolvable tenant
 * (active, not the default), each reading `users` by `email_lower`, enabled users only. No bypass role and no index
 * across tenants: under forced row-level security a unit sees its own tenant's rows and nothing else. A tenant whose
 * unit fails is skipped; the job loop logs it by tenant id.
 */
import type { FastifyBaseLogger } from 'fastify';
import { findUserByEmail } from '../identity/repo.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { Tenancy } from '../tenancy/tenancy.js';

export interface EntryMatch {
  readonly scope: TenantScope;
  /** The tenant's name, as its admin wrote it: plain text. */
  readonly name: string;
}

export async function teamsOf(
  tenancy: Pick<Tenancy, 'forEachResolvableTenant'>,
  emailLower: string,
  log: Pick<FastifyBaseLogger, 'error'>,
): Promise<EntryMatch[]> {
  const matches: EntryMatch[] = [];
  await tenancy.forEachResolvableTenant(
    'entry-lookup',
    async (tx, scope, name) => {
      const user = await findUserByEmail(tx, emailLower);
      if (user !== undefined && user.disabledAt === null) matches.push({ scope, name });
    },
    log,
  );
  return matches;
}
