/**
 * The entry's page (hosted edition spec §21.4; plan Task 5): served on `app.<app-domain>` only, with no cookie and no
 * cache; absent on a self-hosted server; and a hosted server without SMTP refuses to start rather than promise mail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import { entryModule } from '../../../src/entry/module.js';
import { ENTRY_PAGE_CSP } from '../../../src/entry/page.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';

const SMTP = { WIREBENCH_SERVER_SMTP_URL: 'smtp://mail.test:2525', WIREBENCH_SERVER_SMTP_FROM: 'teams@site.test' };
const hosted = (config: ServerConfig): ServerConfig => ({
  ...config,
  mode: 'hosted',
  appDomain: 'app.test',
  siteDomain: 'site.test',
});

describeDb('the entry page (spec §21.4)', () => {
  describe('hosted', () => {
    let h: IdentityHarness;
    beforeAll(async () => {
      h = await identityHarness({
        env: SMTP,
        modules: [entryModule()],
        configure: hosted,
        beforeBuild: async (db, ctx) => {
          await new TenantAdmin(db, directoryOf(ctx.tenancy)).create({ slug: 'acme', name: 'Acme' });
        },
      });
    });
    afterAll(async () => {
      await h.close();
    });

    it('serves the page on app.<app-domain>, with no cookie and no cache', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/', headers: { host: 'app.app.test' } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toBe(ENTRY_PAGE_CSP);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body).toContain('<input id="email" name="email" type="email"');
      expect(res.body).toContain('href="https://site.test/"');
      expect(res.body).not.toContain('<script');
    });

    it('is not on a tenant host', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/', headers: { host: 'acme.app.test' } });
      expect(res.body).not.toContain('Find your team');
    });
  });

  it('registers nothing on a self-hosted server', async () => {
    const h = await identityHarness({ env: SMTP, modules: [entryModule()] });
    try {
      const res = await h.app.inject({ method: 'GET', url: '/', headers: { host: 'app.app.test' } });
      expect(res.body).not.toContain('Find your team');
    } finally {
      await h.close();
    }
  });

  it('refuses to start in hosted mode without SMTP', async () => {
    await expect(identityHarness({ modules: [entryModule()], configure: hosted })).rejects.toMatchObject({
      code: 'entry-smtp-missing',
    });
  });
});
