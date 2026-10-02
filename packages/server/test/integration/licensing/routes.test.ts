// packages/server/test/integration/licensing/routes.test.ts
import type { LicenseState } from '@wirebench/engine';
import { afterEach, expect, it } from 'vitest';
import type { LicenseChanged, ServerModule } from '../../../src/context.js';
import { requireServerAdmin } from '../../../src/identity/guard.js';
import * as repo from '../../../src/licensing/repo.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, PAYLOAD, testKeys } from '../../helpers/licensing.js';
import { call } from '../../helpers/teams.js';

const keys = testKeys();
const other = testKeys();
const DAY = 24 * 60 * 60 * 1000;

/** A route behind the gate, as the audit log will register one (§3.5); the name is only Fastify's label. */
const probe: ServerModule = {
  name: 'gate-probe' as ServerModule['name'],
  // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async
  async register(app, ctx) {
    app.get('/probe', { preHandler: [requireServerAdmin, ctx.license.requireFeature('audit-log')] }, () => ({
      ok: true,
    }));
  },
};

let h: IdentityHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function setUp(): Promise<{
  h: IdentityHarness;
  admin: SignedInUser;
  member: SignedInUser;
  events: LicenseChanged[];
}> {
  h = await licensingHarness(keys, { extra: () => [probe] });
  const admin = await signedInUser(h, { email: 'admin@example.com', serverAdmin: true });
  const member = await signedInUser(h, { email: 'member@example.com' });
  const events: LicenseChanged[] = [];
  h.hooks.licenseChanged.push((event) => events.push(event));
  return { h, admin, member, events };
}

describeDb('the license endpoints (licensing spec §3.6, §13)', () => {
  it('a fresh server is Community with five seats, and /meta says so', async () => {
    const { h, admin } = await setUp();
    expect((await call<LicenseState>(h, admin, 'GET', '/license')).body).toEqual({
      edition: 'community',
      status: 'none',
      seats: { used: 2, limit: 5 },
      features: [],
    });
    expect((await call<{ edition: string }>(h, undefined, 'GET', '/meta')).body.edition).toBe('community');
  });

  it('only a server admin reads, installs or removes', async () => {
    const { h, member } = await setUp();
    expect((await call(h, member, 'GET', '/license')).status).toBe(403);
    expect((await call(h, member, 'PUT', '/license', { license: license(keys) })).status).toBe(403);
    expect((await call(h, member, 'DELETE', '/license')).status).toBe(403);
    expect((await call(h, undefined, 'GET', '/license')).status).toBe(401);
  });

  it('installs a valid license, answers the new state, announces it, and /meta shows only the edition', async () => {
    const { h, admin, events } = await setUp();
    const put = await call<LicenseState>(h, admin, 'PUT', '/license', { license: `${license(keys)}\n` });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      edition: 'team',
      status: 'active',
      seats: { used: 2, limit: 50 },
      licenseId: PAYLOAD.id,
    });
    expect(events).toEqual([
      { action: 'installed', licenseId: PAYLOAD.id, edition: 'team', actorUserId: admin.user.id },
    ]);
    const meta = (await call<Record<string, unknown>>(h, undefined, 'GET', '/meta')).body;
    expect(meta['edition']).toBe('team');
    expect(JSON.stringify(meta)).not.toContain(PAYLOAD.id);
    expect(JSON.stringify(meta)).not.toContain('Example AG');
    expect((await repo.storedLicense(h.db))?.installedBy).toBe(admin.user.id);
  });

  it('refuses an invalid file without touching the stored license', async () => {
    const { h, admin, events } = await setUp();
    await call(h, admin, 'PUT', '/license', { license: license(keys) });
    events.length = 0;
    for (const bad of [license(other), 'hello', license(keys).replace(/^wbl1/, 'wbl9')]) {
      const res = await call<{ code: string }>(h, admin, 'PUT', '/license', { license: bad });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('licensing-invalid');
    }
    expect((await call<LicenseState>(h, admin, 'GET', '/license')).body).toMatchObject({
      edition: 'team',
      status: 'active',
    });
    expect(events).toEqual([]);
  });

  it('removes the license; the server is Community on the next request', async () => {
    const { h, admin, events } = await setUp();
    await call(h, admin, 'PUT', '/license', { license: license(keys) });
    expect((await call(h, admin, 'DELETE', '/license')).status).toBe(204);
    expect((await call<LicenseState>(h, admin, 'GET', '/license')).body.status).toBe('none');
    expect(events.at(-1)).toEqual({ action: 'removed', licenseId: PAYLOAD.id, actorUserId: admin.user.id });
    events.length = 0;
    expect((await call(h, admin, 'DELETE', '/license')).status).toBe(204);
    expect(events).toEqual([]); // nothing was stored, so nothing changed
  });

  it('reports a stored license that no longer verifies as invalid, and the server as Community', async () => {
    const { h, admin } = await setUp();
    await repo.putLicense(h.db, { text: license(other), licenseId: PAYLOAD.id, installedBy: null, at: h.clock.now });
    expect((await call<LicenseState>(h, admin, 'GET', '/license')).body).toMatchObject({
      edition: 'community',
      status: 'invalid',
      reason: 'bad-signature',
    });
  });

  it('moves through grace to expired on the clock alone, and nobody is signed out', async () => {
    const { h, admin } = await setUp();
    await call(h, admin, 'PUT', '/license', { license: license(keys) });
    // The licence outlives the device tokens minted today, so sign in again at each later instant.
    h.clock.set(new Date(Date.parse(PAYLOAD.expiresAt) + DAY));
    const inGrace = await signedInUser(h, { email: 'grace@example.com', serverAdmin: true });
    expect((await call<LicenseState>(h, inGrace, 'GET', '/license')).body).toMatchObject({
      edition: 'team',
      status: 'grace',
    });
    h.clock.set(new Date(Date.parse(PAYLOAD.expiresAt) + 31 * DAY));
    const lapsed = await signedInUser(h, { email: 'lapsed@example.com', serverAdmin: true });
    expect((await call<LicenseState>(h, lapsed, 'GET', '/license')).body).toMatchObject({
      edition: 'community',
      status: 'expired',
    });
    expect((await call(h, lapsed, 'GET', '/me')).status).toBe(200);
  });

  it('gates a feature: 403 on Community and Team, 200 on Enterprise or an explicit list, 403 again after removal', async () => {
    const { h, admin } = await setUp();
    const probeAs = async () => (await call<{ code?: string }>(h, admin, 'GET', '/probe')).status;
    expect(await probeAs()).toBe(403);
    await call(h, admin, 'PUT', '/license', { license: license(keys) });
    expect(await probeAs()).toBe(403);
    await call(h, admin, 'PUT', '/license', { license: license(keys, { edition: 'enterprise' }) });
    expect(await probeAs()).toBe(200);
    await call(h, admin, 'PUT', '/license', { license: license(keys, { features: ['audit-log'] }) });
    expect(await probeAs()).toBe(200);
    await call(h, admin, 'DELETE', '/license');
    expect(await probeAs()).toBe(403);
  });

  it('answers the role guard before the gate', async () => {
    const { h, member } = await setUp();
    expect((await call<{ code: string }>(h, member, 'GET', '/probe')).body.code).toBe('identity-forbidden');
  });

  it('rate-limits installs per admin', async () => {
    const { h, admin } = await setUp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1)
      statuses.push((await call(h, admin, 'PUT', '/license', { license: 'hello' })).status);
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('never logs the license text', async () => {
    const lines: string[] = [];
    const { Writable } = await import('node:stream');
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    h = await licensingHarness(keys, { env: { WIREBENCH_SERVER_LOG_LEVEL: 'info' }, logStream });
    const admin = await signedInUser(h, { email: 'admin@example.com', serverAdmin: true });
    const text = license(keys);
    await call(h, admin, 'PUT', '/license', { license: text });
    const [, segment] = text.split('.');
    expect(lines.join('')).toContain(PAYLOAD.id);
    expect(lines.join('')).not.toContain(segment);
  });
});
