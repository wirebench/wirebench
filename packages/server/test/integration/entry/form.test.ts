/**
 * The entry's form (hosted edition spec §21.4; plan Task 6): one answer for every input, the `Origin` check, the body
 * limit, both rate limits, and the lookup queued after the answer is sent.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import { entryModule } from '../../../src/entry/module.js';
import type { EntryQueue } from '../../../src/entry/queue.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';

const SMTP = { WIREBENCH_SERVER_SMTP_URL: 'smtp://mail.test:2525', WIREBENCH_SERVER_SMTP_FROM: 'teams@site.test' };
const hosted = (config: ServerConfig): ServerConfig => ({
  ...config,
  mode: 'hosted',
  appDomain: 'app.test',
  siteDomain: 'site.test',
});
const ORIGIN = 'https://app.app.test';
const FORM = { host: 'app.app.test', origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' };

describeDb('the entry form (spec §21.4)', () => {
  let h: IdentityHarness;
  let queue: EntryQueue;
  let now = 0;
  let ip = 0;
  const queued: string[] = [];
  let hold: Promise<void> | undefined;
  beforeAll(async () => {
    h = await identityHarness({
      env: SMTP,
      configure: hosted,
      modules: [
        entryModule({
          now: () => now,
          run: async (address) => {
            queued.push(address);
            await hold;
          },
          onQueue: (made) => {
            queue = made;
          },
        }),
      ],
    });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await queue.idle();
    queued.length = 0;
    hold = undefined;
    now += 24 * 3_600_000;
    ip++;
  });

  /** A post from its own client address, so the per-client bucket of one test never limits the next. */
  const post = (email: string | undefined, headers: Record<string, string> = FORM) =>
    h.app.inject({
      method: 'POST',
      url: '/',
      headers,
      payload: email === undefined ? '' : `email=${encodeURIComponent(email)}`,
      remoteAddress: `10.0.0.${String(ip)}`,
    });

  it('answers the same page, byte for byte, to a valid, a malformed and a missing address', async () => {
    const answers = [await post('Someone@Acme.test'), await post('not an address'), await post(undefined)];
    for (const res of answers) {
      expect(res.statusCode).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toBe(answers[0]!.body);
    }
    expect(answers[0]!.body).toContain('If that address has a team, a message is on its way.');
    await queue.idle();
    expect(queued).toEqual(['someone@acme.test']);
  });

  it('refuses a post from another origin, or with none, and queues nothing', async () => {
    for (const origin of ['https://evil.test', 'https://acme.app.test', undefined]) {
      const headers: Record<string, string> = { ...FORM };
      if (origin === undefined) delete headers.origin;
      else headers.origin = origin;
      const res = await post('someone@acme.test', headers);
      expect(res.statusCode, String(origin)).toBe(403);
    }
    await queue.idle();
    expect(queued).toEqual([]);
  });

  it('refuses a body over 1 KiB', async () => {
    const res = await post(`${'a'.repeat(1100)}@acme.test`);
    expect(res.statusCode).toBe(413);
  });

  it('answers the same page over either limit, and queues nothing more', async () => {
    const first = await post('limited@acme.test');
    for (let i = 0; i < 4; i++) await post(`other${String(i)}@acme.test`);
    // The client's sixth post in the minute: over its limit.
    const over = await post('late@acme.test');
    expect(over.statusCode).toBe(200);
    expect(over.body).toBe(first.body);
    await queue.idle();
    expect(queued).not.toContain('late@acme.test');
  });

  it('queues one address at most three times an hour, whatever the client', async () => {
    for (let i = 0; i < 5; i++) {
      ip++;
      await post('same@acme.test');
    }
    await queue.idle();
    expect(queued.filter((address) => address === 'same@acme.test')).toHaveLength(3);
  });

  it('answers before the lookup finishes', async () => {
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const res = await post('slow@acme.test');
    expect(res.statusCode).toBe(200);
    await expect.poll(() => queued).toEqual(['slow@acme.test']);
    release();
    await queue.idle();
  });
});
