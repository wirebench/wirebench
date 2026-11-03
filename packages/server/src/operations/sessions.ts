/**
 * Re-validating the sessions a process holds after its bus missed events (hosted edition spec §20.3, review I1): a
 * lost bus, a peer's missed marker or a full inbox may have swallowed a `sessionEnded`. The live hub, the host
 * instances and the terminal-share registry each list the device tokens their sockets were opened with; one query
 * per tenant finds the ones that are gone, and each gone token gets the holder's own `sessionEnded` handler, so the
 * effect is exactly the announcement's.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { SessionEndedEvent } from '../context.js';
import { liveTokenIds } from '../identity/repo.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { Tenancy } from '../tenancy/tenancy.js';

/** The device tokens a holder's sockets use, by tenant id. */
export type HeldSessions = Map<string, { readonly tenant: TenantScope; readonly tokenIds: Set<string> }>;

/** Adds one socket's token to `held`. */
export function holdSession(held: HeldSessions, tenant: TenantScope, tokenId: string): void {
  const entry = held.get(tenant.tenantId);
  if (entry === undefined) held.set(tenant.tenantId, { tenant, tokenIds: new Set([tokenId]) });
  else entry.tokenIds.add(tokenId);
}

/**
 * Ends, through `end`, every held token that is no longer a live session: one query per tenant, in that tenant's
 * unit. A tenant whose query fails is logged and left as it is; never rejects.
 */
export async function endGoneSessions(
  tenancy: Pick<Tenancy, 'db'>,
  held: HeldSessions,
  end: (event: SessionEndedEvent) => void,
  log: FastifyBaseLogger,
): Promise<void> {
  for (const { tenant, tokenIds } of held.values()) {
    let live: ReadonlySet<string>;
    try {
      live = await liveTokenIds(tenancy.db(tenant), [...tokenIds]);
    } catch (error) {
      log.warn({ err: error }, 'held sessions could not be re-validated after a bus resync');
      continue;
    }
    for (const tokenId of tokenIds) {
      if (live.has(tokenId)) continue;
      try {
        end({ tenantId: tenant.tenantId, tokenId });
      } catch (error) {
        log.warn({ err: error }, 'a gone session could not be ended');
      }
    }
  }
}
