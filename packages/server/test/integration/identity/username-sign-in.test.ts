/**
 * User profile Task 5 (spec §5, §9, rulings 8 and 11): signing in with a username. An identifier with `@` is an email,
 * anything else a username; an unknown username answers, costs and is limited exactly as an unknown email does.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as repo from '../../../src/identity/repo.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const PASSWORD = 'correct horse battery';
const DEVICE = { name: 'laptop' };
const PUBLIC_URL = 'https://wirebench.test';
const BROWSER_ENV = { WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64') };

describeDb('signing in with a username (user profile spec §5)', () => {
  let h: IdentityHarness;
  let aliceId: string;
  beforeEach(async () => {
    h = await identityHarness({ env: BROWSER_ENV });
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    aliceId = alice.user.id;
    await repo.setProfile(h.tdb, aliceId, { username: 'Alice.L' });
  });
  afterEach(() => h.close());

  const signIn = (body: object, ip = '10.0.0.1') =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/local/sign-in',
      payload: { password: PASSWORD, device: DEVICE, ...body },
      remoteAddress: ip,
    });
  const code = (res: { json: <T>() => T }) => res.json<{ code: string }>().code;

  it('takes a username in any case, an email as identifier, and the email field older desktops send', async () => {
    for (const body of [{ identifier: 'alice.l' }, { identifier: ' ALICE.L ' }, { identifier: 'Alice@Example.com' }]) {
      const res = await signIn(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(201);
      expect(res.json<{ user: { id: string } }>().user.id).toBe(aliceId);
    }
    expect((await signIn({ email: 'alice@example.com' })).statusCode).toBe(201);
  });

  it('refuses a body with both an identifier and an email, or neither, with 400', async () => {
    const both = await signIn({ identifier: 'alice.l', email: 'alice@example.com' });
    expect([both.statusCode, code(both)]).toEqual([400, 'identity-identifier-invalid']);
    const neither = await signIn({});
    expect([neither.statusCode, code(neither)]).toEqual([400, 'identity-identifier-invalid']);
  });

  it('answers an unknown username, an unknown email and a wrong password alike', async () => {
    const events = recordingAudit(h.hooks);
    const unknownName = await signIn({ identifier: 'nobody' });
    const unknownEmail = await signIn({ identifier: 'nobody@example.com' });
    const wrong = await signIn({ identifier: 'alice.l', password: 'not the password' });
    for (const res of [unknownName, unknownEmail, wrong]) expect(res.statusCode).toBe(401);
    expect(unknownName.body).toBe(wrong.body);
    expect(unknownEmail.body).toBe(wrong.body);
    expect(wrong.json<{ message: string }>().message).toBe('The email, username or password is not right.');
    // The failure names what was typed, lower-cased, under its own kind.
    expect(events.filter((e) => e.action === 'auth.sign_in_failed').map((e) => e.details)).toEqual([
      { method: 'local', reason: 'identity-invalid-credentials', usernameLower: 'nobody' },
      { method: 'local', reason: 'identity-invalid-credentials', emailLower: 'nobody@example.com' },
      { method: 'local', reason: 'identity-invalid-credentials', usernameLower: 'alice.l' },
    ]);
  });

  it('costs the same units and statements, and a password hash, for an unknown username as for a wrong password', async () => {
    const shape = async (identifier: string): Promise<{ units: number[]; ms: number }> => {
      h.statements.entries.length = 0;
      const started = performance.now();
      expect((await signIn({ identifier, password: 'wrong password!' })).statusCode).toBe(401);
      const ms = performance.now() - started;
      const perUnit = new Map<number, number>();
      for (const entry of h.statements.entries)
        if (entry.kind === 'statement') perUnit.set(entry.unit, (perUnit.get(entry.unit) ?? 0) + 1);
      return { units: [...perUnit.values()], ms };
    };
    // The first miss builds the dummy hash once; measure after it.
    await shape('warm-up');
    const known = await shape('alice.l');
    const unknown = await shape('nobody');
    expect(unknown.units).toEqual(known.units);
    // A miss still verifies a hash (ruling 11): not a fraction of the time a real check takes.
    expect(unknown.ms).toBeGreaterThan(known.ms * 0.3);
  });

  it('limits one username across addresses, in any case, apart from the email bucket', async () => {
    for (let i = 0; i < 10; i += 1) await signIn({ identifier: 'alice.l', password: 'x'.repeat(12) }, `10.0.1.${i}`);
    const limited = await signIn({ identifier: 'ALICE.L' }, '10.0.2.1');
    expect([limited.statusCode, code(limited)]).toEqual([429, 'identity-rate-limited']);
    // The email is a key of its own: the username's ten tries did not use it up.
    expect((await signIn({ identifier: 'alice@example.com' }, '10.0.2.2')).statusCode).toBe(201);
  });

  const signInForm = (fields: Record<string, string>) =>
    h.app.inject({
      method: 'POST',
      url: '/sign-in/local',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC_URL },
      payload: new URLSearchParams(fields).toString(),
      remoteAddress: '10.0.0.9',
    });

  it('labels the browser form "Email or username" and posts the identifier', async () => {
    const page = await h.app.inject({ method: 'GET', url: '/sign-in' });
    expect(page.body).toContain('<label for="identifier">Email or username</label>');
    expect(page.body).toMatch(/<input id="identifier" name="identifier" type="text" autocomplete="username"/);
    expect(page.body).not.toContain('name="email"');
    expect((await signInForm({ identifier: 'alice.l', password: PASSWORD })).statusCode).toBe(303);
    // A page a browser cached before usernames still posts `email`.
    expect((await signInForm({ email: 'alice@example.com', password: PASSWORD })).statusCode).toBe(303);
    const wrong = await signInForm({ identifier: 'nobody', password: PASSWORD });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain('The email, username or password is not right.');
    const missing = await signInForm({ password: PASSWORD });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toContain('Enter your email or username and your password.');
  });
});
