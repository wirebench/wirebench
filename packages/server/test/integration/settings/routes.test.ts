/**
 * Slice 7 Task 29 (hosted edition spec §22.12): `/api/v1/tenant/settings`. Server admins of the tenant only; each
 * section checked on save (the issuer's discovery against a fake, the metadata's parse and signing certificate, the
 * URL rules); `budgets` refused to a tenant; `settings.changed` naming the section and nothing of its value; two
 * tenants apart; and a self-hosted server read-only, answering its environment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { freePort } from '../../helpers/net.js';
import { manualTimers } from '../../helpers/timers.js';
import { describeDb } from '../../helpers/database.js';
import { startFakeOidcIssuer, type FakeOidcIssuer } from '../../helpers/fake-oidc-issuer.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { idpMetadata } from '../../helpers/saml-idp.js';
import { twoTenants, type Tenant, type TwoTenants } from '../tenancy/modules/two-tenants.js';

const ENV = {
  WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
  WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
};
const TOKEN = 'forward-token-9c1e7a3b5d';

describeDb('the tenant settings API (spec §22.12)', () => {
  let t: TwoTenants;
  let idp: FakeOidcIssuer;
  const admins: Partial<Record<'acme' | 'beta', SignedInUser>> = {};
  let member: SignedInUser;
  beforeAll(async () => {
    idp = await startFakeOidcIssuer({ clientId: 'acme-client', clientSecret: 'acme-client-secret-0123456789' });
    t = await twoTenants({
      env: ENV,
      identity: { oidcEgress: 'unchecked' },
      modules: (clock) => [auditLogModule({ now: () => clock.now, setTimer: manualTimers().setTimer })],
    });
    for (const tenant of [t.a, t.b])
      admins[tenant.slug] = await tenant.user({ email: `root@${tenant.slug}.test`, serverAdmin: true });
    member = await t.a.user({ email: 'member@acme.test' });
  }, 120_000);
  afterAll(async () => {
    await t.close();
    await idp.close();
  });

  const put = (tenant: Tenant, section: string, payload: object, user = admins[tenant.slug]) =>
    tenant.call<Record<string, unknown>>(user, 'PUT', `/tenant/settings/${section}`, payload);
  const changes = async (tenant: Tenant) =>
    (
      await tenant.tdb.query<{ details: unknown }>(
        "select details from audit_events where action = 'settings.changed' order by at, id",
      )
    ).rows.map((row) => row.details);

  it('is for the tenant’s server admins only', async () => {
    expect((await t.a.call(member, 'GET', '/tenant/settings')).status).toBe(403);
    expect((await t.a.call(undefined, 'GET', '/tenant/settings')).status).toBe(401);
    expect((await put(t.a, 'retention', { hooksKeep: 10 }, member)).status).toBe(403);
    const read = await t.a.call<{ source: string; sections: Record<string, { value: unknown }> }>(
      admins.acme,
      'GET',
      '/tenant/settings',
    );
    expect(read.status).toBe(200);
    expect(read.body.source).toBe('tenant');
    expect(Object.keys(read.body.sections).sort()).toEqual([
      'auditForward',
      'budgets',
      'oidc',
      'retention',
      'saml',
      'smtp',
    ]);
  });

  it('saves OIDC once its discovery answers, and never answers the secret', async () => {
    const port = await freePort();
    const down = await put(t.a, 'oidc', {
      issuer: `http://127.0.0.1:${String(port)}`,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
    });
    expect(down).toMatchObject({ status: 400, body: { code: 'settings-oidc-discovery' } });
    expect((await put(t.a, 'oidc', { issuer: 'ftp://idp.test', clientId: 'x', clientSecret: 'y' })).body).toMatchObject(
      {
        code: 'settings-oidc-issuer',
      },
    );
    const saved = await put(t.a, 'oidc', { issuer: idp.url, clientId: idp.clientId, clientSecret: idp.clientSecret });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(idp.clientSecret);
    expect(saved.body).toMatchObject({
      sections: { oidc: { value: { issuer: idp.url, clientSecret: { set: true } } } },
    });
    // Beta sees none of it.
    const beta = await t.b.call<{ sections: { oidc: { value: unknown } } }>(admins.beta, 'GET', '/tenant/settings');
    expect(beta.body.sections.oidc.value).toBeNull();
    expect(await changes(t.a)).toEqual([{ section: 'oidc' }]);
    expect(await changes(t.b)).toEqual([]);
  });

  it('checks SAML metadata, the forwarding and SMTP URLs on save', async () => {
    expect((await put(t.a, 'saml', { idpMetadataXml: '<nope' })).body).toMatchObject({
      code: 'settings-saml-metadata',
    });
    expect((await put(t.a, 'saml', { idpMetadataXml: idpMetadata({ certs: [] }) })).body).toMatchObject({
      code: 'settings-saml-metadata',
    });
    expect((await put(t.a, 'saml', { idpMetadataXml: idpMetadata() })).status).toBe(200);
    for (const url of [
      'http://siem.acme.test/in',
      'https://user:pass@siem.acme.test/in',
      'syslog+tls://siem.acme.test:6514',
    ])
      expect((await put(t.a, 'auditForward', { url })).body, url).toMatchObject({ code: 'settings-forward-url' });
    expect(
      (await put(t.a, 'auditForward', { url: 'https://siem.acme.test/in', caPem: 'not a pem' })).body,
    ).toMatchObject({
      code: 'settings-forward-ca',
    });
    const forward = await put(t.a, 'auditForward', { url: 'https://siem.acme.test/in', token: TOKEN });
    expect(forward.body).toMatchObject({ sections: { auditForward: { value: { token: { set: true } } } } });
    expect((await put(t.a, 'smtp', { url: 'https://mail.acme.test', from: 'ops@acme.test' })).body).toMatchObject({
      code: 'settings-smtp-url',
    });
    expect((await put(t.a, 'smtp', { url: 'smtps://u:p@mail.acme.test:465', from: 'ops@acme.test' })).status).toBe(200);
    expect((await put(t.a, 'retention', { hooksKeep: 0 })).body).toMatchObject({ code: 'settings-invalid' });
    expect((await put(t.a, 'nonsense', {})).body).toMatchObject({ code: 'settings-unknown-section' });
    const logged = JSON.stringify(await changes(t.a));
    for (const value of [TOKEN, 'siem.acme.test', 'mail.acme.test', 'u:p']) expect(logged).not.toContain(value);
  });

  it('limits a tenant’s saves, its own bucket only', async () => {
    const answers: number[] = [];
    for (let i = 0; i < 21; i++) answers.push((await put(t.b, 'retention', { hooksKeep: 0 })).status);
    expect(answers.slice(0, 20).every((status) => status === 400)).toBe(true);
    expect(answers[20]).toBe(429);
    expect((await put(t.b, 'retention', { hooksKeep: 0 })).body).toMatchObject({ code: 'settings-rate-limited' });
    // A read is not a save, and the other tenant's bucket is its own.
    expect((await t.b.call(admins.beta, 'GET', '/tenant/settings')).status).toBe(200);
    expect((await put(t.a, 'retention', { hooksKeep: 0 })).status).toBe(400);
  });

  it('refuses a tenant’s budgets with settings-operator-only', async () => {
    expect(await put(t.a, 'budgets', { sendsPerMinute: 100_000 })).toMatchObject({
      status: 403,
      body: { code: 'settings-operator-only' },
    });
    expect((await t.a.call(admins.acme, 'DELETE', '/tenant/settings/budgets')).status).toBe(403);
  });

  it('clears a section, recording it, and the next read has none', async () => {
    const cleared = await t.a.call<{ sections: { smtp: { value: unknown } } }>(
      admins.acme,
      'DELETE',
      '/tenant/settings/smtp',
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.sections.smtp.value).toBeNull();
    expect((await changes(t.a)).at(-1)).toEqual({ section: 'smtp' });
  });

  describe('self-hosted', () => {
    let h: IdentityHarness;
    let root: SignedInUser;
    beforeAll(async () => {
      h = await identityHarness({ env: { WIREBENCH_SERVER_HOOKS_KEEP: '42' } });
      root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    }, 60_000);
    afterAll(() => h.close());

    it('answers the environment read-only, and refuses every write with settings-environment', async () => {
      const read = await h.app.inject({ method: 'GET', url: '/api/v1/tenant/settings', headers: root.headers });
      expect(read.json()).toMatchObject({
        source: 'environment',
        sections: {
          retention: { source: 'environment', writable: false, value: { hooksKeep: 42 } },
          oidc: { value: null },
        },
      });
      for (const method of ['PUT', 'DELETE'] as const) {
        const res = await h.app.inject({
          method,
          url: '/api/v1/tenant/settings/retention',
          headers: root.headers,
          ...(method === 'PUT' ? { payload: { hooksKeep: 1 } } : {}),
        });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'settings-environment' });
      }
    });
  });
});
