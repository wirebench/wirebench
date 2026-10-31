/**
 * The audit log in a tenant (tenancy Task 14, hosted edition spec §19.7, §19.8 guard 6): the module's sealer
 * seals each tenant's chain with that tenant's key (the configured one only for the self-hosted default tenant),
 * and the license listener writes in the announcement's tenant. The two-tenant chains under the forced policy are
 * Task 18's.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { genesisHash, keyId } from '../../../src/audit-log/chain/canonical.js';
import { chainKeys, derivedChainKey } from '../../../src/audit-log/chain/keys.js';
import { verifyChain } from '../../../src/audit-log/chain/verify.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { readAnchor } from '../../../src/audit-log/repo.js';
import type { ServerConfig } from '../../../src/config.js';
import { announce } from '../../../src/context.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { directoryOf, isDefaultTenant } from '../../../src/tenancy/tenancy.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';
import { manualTimers } from '../../helpers/timers.js';

const KEY = 'test-chain-key-0123456789abcdefghij';
const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: 'example.test' });

describeDb('the audit log in a tenant (tenancy Task 14)', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0)) await close();
  });

  async function server(configure?: (config: ServerConfig) => ServerConfig): Promise<IdentityHarness> {
    const timers = manualTimers();
    const h = await identityHarness({
      env: { WIREBENCH_SERVER_AUDIT_CHAIN_KEY: KEY },
      ...(configure !== undefined ? { configure } : {}),
      modules: (clock) => [auditLogModule({ now: () => clock.now, setTimer: timers.setTimer })],
    });
    cleanup.push(() => h.close());
    return h;
  }

  /** The anchor the module's first pass writes (a genesis, even with nothing to seal). */
  const anchorOf = async (h: IdentityHarness) => {
    let anchor: Awaited<ReturnType<typeof readAnchor>>;
    await vi.waitFor(async () => {
      anchor = await readAnchor(h.tdb);
      expect(anchor).toBeDefined();
    });
    return anchor!;
  };

  it('self-hosted: the default tenant’s chain is sealed with the configured key, as before', async () => {
    const h = await server();
    const anchor = await anchorOf(h);
    expect(anchor.keyId).toBe(keyId(KEY));
    expect(anchor.hash).toEqual(genesisHash(KEY));
    expect(await verifyChain(h.tdb, KEY)).toMatchObject({ kind: 'checked', result: 'intact' });
  }, 30_000);

  it('hosted: the default tenant’s chain is sealed with its derived key, and the configured key seals nothing', async () => {
    const h = await server(hosted);
    const derived = derivedChainKey(KEY, h.tdb.scope.tenantId);
    const anchor = await anchorOf(h);
    expect(anchor.keyId).toBe(keyId(derived));
    expect(anchor.hash).toEqual(genesisHash(derived));
    expect(await verifyChain(h.tdb, KEY)).toEqual({ kind: 'wrong-key', chainKeyId: keyId(derived) });
    expect(await verifyChain(h.tdb, derived)).toMatchObject({ kind: 'checked', result: 'intact' });
  }, 30_000);

  it('self-hosted: a tenant other than the default one gets a derived key, through the real default-tenant check', async () => {
    const h = await server();
    const second = await new TenantAdmin(h.db, directoryOf(h.ctx.tenancy)).create({ slug: 'second', name: 'Second' });
    const keys = chainKeys(KEY, h.ctx.config.mode, (scope) => isDefaultTenant(h.ctx.tenancy, scope));
    expect(keys(h.tdb.scope)).toBe(KEY);
    expect(keys(second.scope)).toBe(derivedChainKey(KEY, second.scope.tenantId));
    expect(keys(second.scope)).not.toBe(derivedChainKey(KEY, h.tdb.scope.tenantId));
  }, 30_000);

  it('the license listener writes inside a unit of the announcement’s tenant', async () => {
    const h = await server();
    const second = await new TenantAdmin(h.db, directoryOf(h.ctx.tenancy)).create({ slug: 'second', name: 'Second' });
    h.statements.entries.length = 0;
    announce(
      h.hooks.licenseChanged,
      {
        action: 'installed',
        licenseId: 'L-second',
        edition: 'team',
        actorUserId: null,
        tenantId: second.scope.tenantId,
        tenant: second.scope,
      },
      h.app.log,
    );
    await vi.waitFor(() => {
      expect(h.statements.entries.some((entry) => entry.text.startsWith('insert into audit_events'))).toBe(true);
    });
    const insert = h.statements.entries.find((entry) => entry.text.startsWith('insert into audit_events'))!;
    expect(insert.tenantId).toBe(second.scope.tenantId);
    const unit = h.statements.entries.filter((entry) => entry.unit === insert.unit);
    expect(unit[0]).toMatchObject({ kind: 'set-config', tenantId: second.scope.tenantId });
    expect(unit.every((entry) => entry.tenantId === second.scope.tenantId)).toBe(true);
  }, 30_000);
});
