/**
 * The edition in hosted mode (hosted edition spec §22.4; slice 7 Task 5): `state(scope)` reads the tenant row's
 * edition and seats, never a license; the seat lock and the host-instance cap read them through it; a license is
 * neither uploaded nor installed from the command line (`licensing-hosted`). Self-hosted mode is unchanged.
 */
import { FEATURES } from '@wirebench/engine';
import { afterEach, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import { runAdmin } from '../../../src/identity/cli.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { newId } from '../../../src/identity/tokens.js';
import { TenantAdmin, type NewTenant } from '../../../src/tenancy/directory.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';

const keys = testKeys();
const APP_DOMAIN = 'example.test';
const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: APP_DOMAIN });

let h: IdentityHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function hostedHarness(): Promise<IdentityHarness> {
  h = await licensingHarness(keys, { configure: hosted });
  return h;
}

async function tenant(harness: IdentityHarness, input: Partial<NewTenant> & { slug: string }): Promise<TenantScope> {
  const created = await new TenantAdmin(harness.db, directoryOf(harness.ctx.tenancy)).create({
    name: input.slug,
    ...input,
  });
  return created.scope;
}

async function addUsers(harness: IdentityHarness, scope: TenantScope, count: number, from = 0): Promise<void> {
  const tdb = harness.ctx.tenancy.db(scope);
  for (let i = from; i < from + count; i += 1) {
    await identityRepo.insertUser(tdb, {
      id: newId(),
      email: `u${i}@example.com`,
      displayName: `u${i}`,
      serverAdmin: false,
      at: harness.clock.now,
    });
  }
}

describeDb('the edition from the tenant row (hosted spec §22.4)', () => {
  it('a Team tenant is Team, active, with its row’s seats and no features', async () => {
    const harness = await hostedHarness();
    const scope = await tenant(harness, { slug: 'acme', edition: 'team', seats: 3, editionSource: 'subscription' });
    await addUsers(harness, scope, 2);
    const state = await harness.ctx.license.state(scope);
    expect(state).toMatchObject({ edition: 'team', status: 'active', seats: { used: 2, limit: 3 }, features: [] });
    expect(state.licenseId).toBeUndefined();
  });

  it('an Enterprise tenant has every feature, and no seats on its row means no limit', async () => {
    const harness = await hostedHarness();
    const scope = await tenant(harness, { slug: 'bigco', edition: 'enterprise', editionSource: 'operator' });
    const state = await harness.ctx.license.state(scope);
    expect(state).toMatchObject({ edition: 'enterprise', status: 'active', seats: { limit: null } });
    expect([...state.features].sort()).toEqual([...FEATURES].sort());
  });

  it('the seat lock refuses at the row’s seats, and the host-instance cap reads the same limit', async () => {
    const harness = await hostedHarness();
    const scope = await tenant(harness, { slug: 'acme', edition: 'team', seats: 2, editionSource: 'subscription' });
    await addUsers(harness, scope, 1);
    const tdb = harness.ctx.tenancy.db(scope);
    await tdb.transaction((tx) => harness.ctx.license.assertSeatAvailable(tx));
    // The host module's cap: `(await ctx.license.state(tx.scope, tx)).seats.limit`, in the take's unit.
    expect(await tdb.transaction(async (tx) => (await harness.ctx.license.state(tx.scope, tx)).seats.limit)).toBe(2);
    await addUsers(harness, scope, 1, 1);
    await expect(tdb.transaction((tx) => harness.ctx.license.assertSeatAvailable(tx))).rejects.toMatchObject({
      code: 'licensing-seat-limit',
    });
    // The operator raises the seats: the next check reads the row again.
    await harness.db.query('update tenants set seats = 5 where id = $1::uuid', [scope.tenantId]);
    await tdb.transaction((tx) => harness.ctx.license.assertSeatAvailable(tx));
  });

  it('PUT and DELETE /license answer 409 licensing-hosted on a tenant host', async () => {
    const harness = await hostedHarness();
    const scope = await tenant(harness, { slug: 'acme', edition: 'team', seats: 5, editionSource: 'subscription' });
    const tdb = harness.ctx.tenancy.db(scope);
    const admin = await signedInUser(harness, { email: 'admin@example.com', serverAdmin: true, tdb });
    const headers = { ...admin.headers, host: `acme.${APP_DOMAIN}` };
    const put = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/license',
      headers,
      payload: { license: license(keys) },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json()).toMatchObject({ code: 'licensing-hosted' });
    const del = await harness.app.inject({ method: 'DELETE', url: '/api/v1/license', headers });
    expect(del.statusCode).toBe(409);
    const get = await harness.app.inject({ method: 'GET', url: '/api/v1/license', headers });
    expect(get.json()).toMatchObject({ edition: 'team', seats: { limit: 5 } });
    expect((await tdb.query('select 1 from license')).rows).toHaveLength(0);
  });

  it('admin license refuses in hosted mode with the same code', async () => {
    const harness = await hostedHarness();
    await tenant(harness, { slug: 'acme', edition: 'team', seats: 5, editionSource: 'subscription' });
    const err: string[] = [];
    const io = {
      stdout: { write: () => true },
      stderr: { write: (t: string) => err.push(t) },
      env: { WIREBENCH_SERVER_DATABASE_URL: harness.db.url, WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test' },
    };
    for (const command of ['admin-license-show', 'admin-license-remove'] as const) {
      err.length = 0;
      expect(await runAdmin({ command, tenant: 'acme' }, io, { configure: hosted, publicKeys: [keys.publicKey] })).toBe(
        1,
      );
      expect(err.join('')).toMatch(/^licensing-hosted: /);
    }
  });
});

describeDb('the edition in self-hosted mode (unchanged)', () => {
  it('reads the license, not the row', async () => {
    h = await licensingHarness(keys);
    await h.db.owner.query('update tenants set edition = $1, seats = 99', ['enterprise']);
    const state = await h.ctx.license.state(h.tdb.scope);
    expect(state).toMatchObject({ edition: 'community', status: 'none', seats: { limit: 5 } });
  });
});
