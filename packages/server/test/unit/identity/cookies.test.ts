import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  clearSessionCookie,
  sessionCookieName,
  sessionToken,
  setSessionCookie,
} from '../../../src/identity/cookies.js';

const HTTPS = 'https://wirebench.test';
const HTTP = 'http://localhost:8080';

/** One route that runs `act` on the reply, so the Set-Cookie header comes back as a browser sees it. */
async function setCookieOf(act: (reply: import('fastify').FastifyReply) => void): Promise<string[]> {
  const app = Fastify();
  app.get('/', async (_request, reply) => {
    act(reply);
    return reply.send('ok');
  });
  const res = await app.inject({ method: 'GET', url: '/' });
  await app.close();
  const header = res.headers['set-cookie'];
  return header === undefined ? [] : Array.isArray(header) ? header : [header];
}

describe('the session cookie (hosted spec §17.2)', () => {
  it('is __Host-wb_session on an https public URL and wb_session on an http one', () => {
    expect(sessionCookieName(HTTPS)).toBe('__Host-wb_session');
    expect(sessionCookieName(HTTP)).toBe('wb_session');
  });

  it('is HttpOnly, Secure, SameSite=Lax, Path=/ with no Domain, for the token maximum age', async () => {
    const [cookie] = await setCookieOf((reply) => setSessionCookie(reply, HTTPS, 'wbs_abc', 15_552_000));
    expect(cookie).toBe('__Host-wb_session=wbs_abc; Max-Age=15552000; Path=/; HttpOnly; Secure; SameSite=Lax');
    expect(cookie).not.toMatch(/Domain/i);
  });

  it('drops Secure on an http public URL, since only the insecure opt-in allows one', async () => {
    const [cookie] = await setCookieOf((reply) => setSessionCookie(reply, HTTP, 'wbs_abc', 60));
    expect(cookie).toBe('wb_session=wbs_abc; Max-Age=60; Path=/; HttpOnly; SameSite=Lax');
  });

  it('clears with an empty value and Max-Age=0 under the same attributes', async () => {
    expect(await setCookieOf((reply) => clearSessionCookie(reply, HTTPS))).toEqual([
      '__Host-wb_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  it('appends to a Set-Cookie already on the reply instead of replacing it', async () => {
    const cookies = await setCookieOf((reply) => {
      reply.header('set-cookie', 'other=1; Path=/');
      setSessionCookie(reply, HTTPS, 'wbs_abc', 60);
      clearSessionCookie(reply, HTTP);
    });
    expect(cookies).toEqual([
      'other=1; Path=/',
      '__Host-wb_session=wbs_abc; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax',
      'wb_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
    ]);
  });

  it('reads the first exact-name match from the Cookie header and nothing else', () => {
    const read = (cookie: string | undefined, publicUrl = HTTPS) =>
      sessionToken({ headers: cookie === undefined ? {} : { cookie } } as never, publicUrl);
    expect(read(undefined)).toBeUndefined();
    expect(read('a=1; __Host-wb_session=wbs_one; __Host-wb_session=wbs_two')).toBe('wbs_one');
    expect(read('x__Host-wb_session=wbs_no; __Host-wb_session_x=wbs_no')).toBeUndefined();
    expect(read('__Host-wb_session=')).toBeUndefined();
    expect(read('wb_session=wbs_plain')).toBeUndefined(); // the https name only
    expect(read(' wb_session = wbs_plain ', HTTP)).toBe('wbs_plain');
  });
});
