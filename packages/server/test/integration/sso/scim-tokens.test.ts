import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SCIM_TOKEN_PATTERN } from '@wirebench/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashSecret, newId } from '../../../src/identity/tokens.js';
import { runAdmin } from '../../../src/identity/cli.js';
import { main } from '../../../src/main.js';
import { ssoModule } from '../../../src/sso/module.js';
import * as repo from '../../../src/sso/repo.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { defaultTenantDb } from '../../helpers/tenancy.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';

const keys = testKeys();

describeDb('SCIM tokens (saml-scim spec §3.4)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  const boot = async (licensed = true) => {
    h = await licensingHarness(keys, {
      extra: (clock) => [ssoModule({ now: () => clock.now, sweepIntervalMs: 0 })],
    });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    if (licensed) {
      const put = await h.app.inject({
        method: 'PUT',
        url: '/api/v1/license',
        headers: admin.headers,
        payload: { license: license(keys, { edition: 'enterprise' }) },
      });
      expect(put.statusCode, put.body).toBe(200);
    }
  };
  afterEach(async () => {
    await h.close();
  });
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, who: SignedInUser = admin) =>
    h.app.inject({ method, url: `/api/v1${url}`, headers: who.headers, ...(payload !== undefined ? { payload } : {}) });

  describe('licensed', () => {
    beforeEach(async () => {
      await boot();
    });

    it('creates a token shown once, stores only its hash, lists it without the secret and revokes it', async () => {
      const created = await call('POST', '/scim-tokens', { name: '  Entra ID  ' });
      expect(created.statusCode, created.body).toBe(201);
      const body = created.json<{ id: string; name: string; token: string; createdAt: string }>();
      expect(body.name).toBe('Entra ID');
      expect(body.token).toMatch(SCIM_TOKEN_PATTERN);
      const row = await repo.scimTokenById(h.db, body.id);
      expect(row?.tokenHash).toBe(hashSecret(body.token));
      const stored = await h.db.query<Record<string, unknown>>('select * from scim_tokens');
      expect(JSON.stringify(stored.rows)).not.toContain(body.token);

      const list = await call('GET', '/scim-tokens');
      expect(list.json()).toEqual([{ id: body.id, name: 'Entra ID', createdAt: body.createdAt, lastUsedAt: null }]);
      expect(list.body).not.toContain(body.token);

      expect((await call('DELETE', `/scim-tokens/${body.id}`)).statusCode).toBe(204);
      expect((await call('GET', '/scim-tokens')).json()).toEqual([]);
      const again = await call('DELETE', `/scim-tokens/${body.id}`);
      expect(again.statusCode).toBe(404);
      expect(again.json()).toMatchObject({ code: 'sso-scim-token-not-found' });
    });

    it('refuses a duplicate live name, case-insensitively, and frees the name on revoke', async () => {
      const first = (await call('POST', '/scim-tokens', { name: 'Okta' })).json<{ id: string }>();
      const dup = await call('POST', '/scim-tokens', { name: 'okta' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json()).toMatchObject({ code: 'sso-scim-token-name-taken' });
      await call('DELETE', `/scim-tokens/${first.id}`);
      expect((await call('POST', '/scim-tokens', { name: 'okta' })).statusCode).toBe(201);
    });

    it('refuses a blank or over-long name', async () => {
      expect((await call('POST', '/scim-tokens', { name: '   ' })).statusCode).toBe(400);
      expect((await call('POST', '/scim-tokens', { name: 'x'.repeat(65) })).statusCode).toBe(400);
    });

    it('is for server admins only', async () => {
      const member = await signedInUser(h, { email: 'm@example.com' });
      expect((await call('GET', '/scim-tokens', undefined, member)).statusCode).toBe(403);
      expect((await call('POST', '/scim-tokens', { name: 'x' }, member)).statusCode).toBe(403);
    });
  });

  it('needs the sso-provisioning feature', async () => {
    await boot(false);
    const res = await call('POST', '/scim-tokens', { name: 'Entra ID' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'licensing-feature-required' });
  });
});

describeDb('wirebench-server admin scim-token (saml-scim spec §3.4)', () => {
  const NOW = new Date('2026-09-24T12:00:00Z');
  let db: Awaited<ReturnType<typeof testDatabase>>;
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: {
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => err.push(t) },
        env: {
          WIREBENCH_SERVER_DATABASE_URL: db.url,
          WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
          WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
        },
      },
      stdout: () => out.join(''),
      stderr: () => err.join(''),
    };
  };
  const options = { now: () => NOW, publicKeys: [keys.publicKey] };
  beforeEach(async () => {
    db = await testDatabase();
    expect(await main(['migrate'], io().io)).toBe(0);
  });
  afterEach(() => db.close());

  it('refuses without the licence feature', async () => {
    const out = io();
    expect(await runAdmin({ command: 'admin-scim-token-create', name: 'Entra ID' }, out.io, options)).toBe(1);
    expect(out.stderr()).toContain('licensing-feature-required');
  });

  it('creates (printing the token once), lists and revokes', async () => {
    const lic = io();
    const dir = await mkTempDir();
    const file = join(dir, 'enterprise.lic');
    await writeFile(file, license(keys, { edition: 'enterprise' }));
    expect(await runAdmin({ command: 'admin-license-install', file }, lic.io, options)).toBe(0);
    await removeTempDir(dir);

    const created = io();
    expect(await runAdmin({ command: 'admin-scim-token-create', name: 'Entra ID' }, created.io, options)).toBe(0);
    const token = /^(wbscim_\S+)$/m.exec(created.stdout())?.[1];
    expect(token).toMatch(SCIM_TOKEN_PATTERN);
    const id = /\((\S+)\)/.exec(created.stdout())?.[1];

    const list = io();
    expect(await runAdmin({ command: 'admin-scim-token-list' }, list.io, options)).toBe(0);
    expect(list.stdout()).toContain('Entra ID');
    expect(list.stdout()).not.toContain(token);

    const revoked = io();
    expect(await runAdmin({ command: 'admin-scim-token-revoke', id: id! }, revoked.io, options)).toBe(0);
    const again = io();
    expect(await runAdmin({ command: 'admin-scim-token-revoke', id: id! }, again.io, options)).toBe(1);
    expect(again.stderr()).toContain('sso-scim-token-not-found');
  });

  it('scim-group list, link and unlink, by name', async () => {
    const dir = await mkTempDir();
    const file = join(dir, 'enterprise.lic');
    await writeFile(file, license(keys, { edition: 'enterprise' }));
    expect(await runAdmin({ command: 'admin-license-install', file }, io().io, options)).toBe(0);
    await removeTempDir(dir);
    const team = await teamsRepo.insertTeam(await defaultTenantDb(db), { id: newId(), name: 'Payments', at: NOW });
    await repo.insertScimGroup(db, { id: newId(), displayName: 'Engineering', externalId: null, at: NOW });

    const linked = io();
    expect(
      await runAdmin({ command: 'admin-scim-group-link', group: 'engineering', team: 'payments' }, linked.io, options),
    ).toBe(0);
    expect(linked.stdout()).toBe('Linked Engineering to Payments\n');
    const list = io();
    expect(await runAdmin({ command: 'admin-scim-group-list' }, list.io, options)).toBe(0);
    expect(list.stdout()).toMatch(/Engineering\s+0\s+Payments/);
    const unlinked = io();
    expect(await runAdmin({ command: 'admin-scim-group-unlink', group: 'Engineering' }, unlinked.io, options)).toBe(0);
    expect((await repo.listScimGroups(db))[0]!.teamId).toBeNull();
    expect(team.id).toBeDefined();
    const missing = io();
    expect(await runAdmin({ command: 'admin-scim-group-unlink', group: 'nope' }, missing.io, options)).toBe(1);
    expect(missing.stderr()).toContain('sso-scim-group-not-found');
  });
});
