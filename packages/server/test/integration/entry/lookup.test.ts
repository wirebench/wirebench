/**
 * The entry's lookup and message (hosted edition spec §21.4, ADR-0038; plan Task 7), over two tenants as the app
 * role: each tenant is read in its own unit, so only a tenant the address belongs to is listed, never the default
 * tenant and never for a disabled user. The message is plain text and holds links only.
 */
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import type { EntryMail } from '../../../src/entry/mail.js';
import { entryModule } from '../../../src/entry/module.js';
import type { EntryQueue } from '../../../src/entry/queue.js';
import * as repo from '../../../src/identity/repo.js';
import { newId } from '../../../src/identity/tokens.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
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
const FORM = {
  host: 'app.app.test',
  origin: 'https://app.app.test',
  'content-type': 'application/x-www-form-urlencoded',
};

describeDb('the entry lookup and message (spec §21.4)', () => {
  let h: IdentityHarness;
  let queue: EntryQueue;
  const sent: { to: string; mail: EntryMail; smtp: { url: string; from: string } }[] = [];
  const logLines: string[] = [];
  let ip = 0;
  beforeAll(async () => {
    const at = new Date('2026-11-03T12:00:00.000Z');
    const user = async (tx: Parameters<typeof repo.insertUser>[0], email: string): Promise<repo.UserRow> =>
      repo.insertUser(tx, { id: newId(), email, displayName: email, serverAdmin: false, at });
    h = await identityHarness({
      env: { ...SMTP, WIREBENCH_SERVER_LOG_LEVEL: 'info' },
      configure: hosted,
      logStream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          logLines.push(chunk.toString());
          done();
        },
      }),
      modules: [
        entryModule({
          send: (smtp, to, mail) => {
            sent.push({ smtp: { ...smtp }, to, mail });
            return Promise.resolve();
          },
          onQueue: (made) => {
            queue = made;
          },
        }),
      ],
      beforeBuild: async (db, ctx) => {
        const directory = directoryOf(ctx.tenancy);
        const admin = new TenantAdmin(db, directory);
        const acme = (await admin.create({ slug: 'acme', name: 'Acme <b>Labs</b>\nBcc: x@evil.test' })).scope;
        const beta = (await admin.create({ slug: 'beta', name: 'Beta' })).scope;
        const write = (scope: TenantScope, fn: (tx: Parameters<typeof repo.insertUser>[0]) => Promise<unknown>) =>
          ctx.tenancy.db(scope).transaction(fn);
        await write(acme, (tx) => user(tx, 'Only-Acme@Example.test'));
        await write(acme, (tx) => user(tx, 'both@example.test'));
        await write(beta, (tx) => user(tx, 'both@example.test'));
        await write(beta, async (tx) => {
          const gone = await user(tx, 'disabled@example.test');
          await repo.setDisabled(tx, gone.id, at);
        });
        await write(directory.defaultScope(), (tx) => user(tx, 'default@example.test'));
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    sent.length = 0;
    ip++;
  });

  const ask = async (email: string): Promise<void> => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/',
      headers: FORM,
      payload: `email=${encodeURIComponent(email)}`,
      remoteAddress: `10.1.0.${String(ip)}`,
    });
    expect(res.statusCode).toBe(200);
    await queue.idle();
  };

  it("mails an address that belongs to one tenant that tenant's sign-in link only", async () => {
    await ask('only-acme@example.test');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('only-acme@example.test');
    expect(sent[0]!.smtp).toEqual({ url: SMTP.WIREBENCH_SERVER_SMTP_URL, from: SMTP.WIREBENCH_SERVER_SMTP_FROM });
    expect(sent[0]!.mail.subject).toBe('Your Wirebench teams');
    expect(sent[0]!.mail.text).toContain('https://acme.app.test/sign-in');
    expect(sent[0]!.mail.text).not.toContain('beta.app.test');
    expect(sent[0]!.mail.text).toContain('https://site.test/');
    expect(sent[0]!.mail.text).toContain('You asked for this at app.app.test.');
  });

  it('lists every tenant an address belongs to', async () => {
    await ask('both@example.test');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.mail.text).toContain('https://acme.app.test/sign-in');
    expect(sent[0]!.mail.text).toContain('https://beta.app.test/sign-in');
  });

  it('sends nothing for an unknown address, a disabled user or a user of the default tenant', async () => {
    for (const email of ['nobody@example.test', 'disabled@example.test', 'default@example.test']) await ask(email);
    expect(sent).toEqual([]);
  });

  it("keeps a tenant's name to one line of plain text, with no html part", async () => {
    await ask('only-acme@example.test');
    const { mail } = sent[0]!;
    expect(mail).not.toHaveProperty('html');
    expect(mail.text).toContain('Acme <b>Labs</b> Bcc: x@evil.test\n  https://acme.app.test/sign-in');
    expect(mail.text.split('\n').filter((line) => line.startsWith('Bcc:'))).toEqual([]);
  });

  it('logs a count and a time, never the address or a slug', async () => {
    logLines.length = 0;
    await ask('both@example.test');
    const lines = logLines.filter((line) => line.includes('an entry lookup finished'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ matched: 2 });
    for (const line of logLines) {
      expect(line).not.toContain('both@example.test');
      expect(line).not.toContain('acme');
      expect(line).not.toContain('beta');
    }
  });
});
