import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { ssoModule } from '../../../src/sso/module.js';
import * as repo from '../../../src/sso/repo.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';

const SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

describeDb('the SCIM endpoint (saml-scim spec §3.5, §6.2)', () => {
  const keys = testKeys();
  let h: IdentityHarness;
  let admin: SignedInUser;
  let logs: string[];

  const boot = async () => {
    logs = [];
    h = await licensingHarness(keys, {
      env: { WIREBENCH_SERVER_LOG_LEVEL: 'info' },
      logStream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          logs.push(chunk.toString('utf8'));
          done();
        },
      }),
      extra: (clock) => [
        auditLogModule({ now: () => clock.now }),
        ssoModule({ now: () => clock.now, sweepIntervalMs: 0 }),
      ],
    });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/license',
      headers: admin.headers,
      payload: { license: license(keys, { edition: 'enterprise' }) },
    });
    expect(put.statusCode, put.body).toBe(200);
  };
  const token = async (name = 'Entra ID') => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/scim-tokens',
      headers: admin.headers,
      payload: { name },
    });
    return res.json<{ id: string; token: string }>();
  };
  const scim = (path: string, bearer?: string, ip = '10.0.0.1') =>
    h.app.inject({
      method: 'GET',
      url: `/scim/v2${path}`,
      remoteAddress: ip,
      headers: bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {},
    });
  const failures = async () =>
    (
      await h.db.query<{ details: { method: string; reason: string } }>(
        "select details from audit_events where action = 'auth.sign_in_failed' order by at, id",
      )
    ).rows.map((row) => row.details);
  afterEach(async () => {
    await h.close();
  });

  describe('licensed', () => {
    beforeEach(async () => {
      await boot();
    });

    it('serves the discovery documents to a valid token, in application/scim+json', async () => {
      const { token: bearer } = await token();
      const config = await scim('/ServiceProviderConfig', bearer);
      expect(config.statusCode, config.body).toBe(200);
      expect(config.headers['content-type']).toMatch(/^application\/scim\+json/);
      expect(config.json()).toMatchObject({ patch: { supported: true }, bulk: { supported: false } });
      expect((await scim('/ResourceTypes', bearer)).json()).toMatchObject({ totalResults: 2 });
      expect((await scim('/Schemas', bearer)).json()).toMatchObject({ totalResults: 2 });
    });

    it.each([
      ['no token', undefined],
      ['a malformed token', 'wbscim_short'],
      ['an unknown token', `wbscim_${'A'.repeat(43)}`],
    ])('refuses %s with 401 in the SCIM error shape', async (_name, bearer) => {
      const res = await scim('/ServiceProviderConfig', bearer);
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toMatch(/^application\/scim\+json/);
      expect(res.json()).toMatchObject({ schemas: [SCIM_ERROR], status: '401' });
    });

    it('a revoked token fails at once', async () => {
      const { id, token: bearer } = await token();
      expect((await scim('/ServiceProviderConfig', bearer)).statusCode).toBe(200);
      await h.app.inject({ method: 'DELETE', url: `/api/v1/scim-tokens/${id}`, headers: admin.headers });
      expect((await scim('/ServiceProviderConfig', bearer)).statusCode).toBe(401);
    });

    it('a device token never works on SCIM, and a SCIM token never works on /api/v1', async () => {
      expect((await scim('/ServiceProviderConfig', admin.token)).statusCode).toBe(401);
      const { token: bearer } = await token();
      for (const url of ['/api/v1/me', '/api/v1/workspaces', '/api/v1/audit']) {
        const res = await h.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });
        expect(res.statusCode, url).toBe(401);
      }
    });

    it('an unknown SCIM path answers 404 in the SCIM shape', async () => {
      const { token: bearer } = await token();
      const res = await scim('/Nothing', bearer);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ schemas: [SCIM_ERROR], status: '404' });
    });

    it('rate-limits failed attempts per IP and audits them at most once a minute', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 12; i += 1)
        codes.push((await scim('/ServiceProviderConfig', undefined, '10.0.0.9')).statusCode);
      expect(codes.slice(0, 10).every((code) => code === 401)).toBe(true);
      expect(codes.slice(10)).toEqual([429, 429]);
      expect(await failures()).toEqual([expect.objectContaining({ method: 'scim', reason: 'scim-token-missing' })]);
      h.clock.advance(61_000);
      await scim('/ServiceProviderConfig', undefined, '10.0.0.9');
      expect(await failures()).toHaveLength(2);
    });

    it('touches last_used_at at most once a minute', async () => {
      const { id, token: bearer } = await token();
      await scim('/ServiceProviderConfig', bearer);
      const first = (await repo.scimTokenById(h.tdb, id))!.lastUsedAt;
      expect(first).toBe(h.clock.now.toISOString());
      h.clock.advance(30_000);
      await scim('/ServiceProviderConfig', bearer);
      expect((await repo.scimTokenById(h.tdb, id))!.lastUsedAt).toBe(first);
      h.clock.advance(31_000);
      await scim('/ServiceProviderConfig', bearer);
      expect((await repo.scimTokenById(h.tdb, id))!.lastUsedAt).toBe(h.clock.now.toISOString());
    });

    it('never logs the bearer token', async () => {
      const { token: bearer } = await token();
      await scim('/ServiceProviderConfig', bearer);
      await scim('/Nothing', bearer);
      expect(logs.join('')).not.toContain(bearer);
    });
  });

  it('an unlicensed server answers 403 in the SCIM shape', async () => {
    await boot();
    const { token: bearer } = await token();
    await h.app.inject({ method: 'DELETE', url: '/api/v1/license', headers: admin.headers });
    const res = await scim('/ServiceProviderConfig', bearer);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ schemas: [SCIM_ERROR], status: '403' });
  });
});
