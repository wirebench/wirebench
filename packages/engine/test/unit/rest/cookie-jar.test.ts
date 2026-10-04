/**
 * The cookie jar (cookie jar spec §1). A cookie sent to the wrong host, over plain HTTP, or after
 * the server deleted it is a credential leak, so the refusals matter as much as the matches.
 */
import { describe, expect, it } from 'vitest';
import type { Cookie } from '../../../src/http/cookies.js';
import {
  CookieJar,
  jarCookieHost,
  MAX_COOKIES,
  MAX_COOKIES_PER_DOMAIN,
  mergeCookieHeader,
  type StoredCookie,
} from '../../../src/rest/cookie-jar.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');

function cookie(name: string, extra: Partial<Cookie> = {}): Cookie {
  return { name, value: `${name}-value`, ...extra };
}

function names(cookies: readonly StoredCookie[]): string[] {
  return cookies.map((stored) => stored.name);
}

describe('CookieJar — host-only and Domain', () => {
  it('stores a cookie with no Domain as host-only, under the default path of the URL that set it', () => {
    const jar = new CookieJar();
    expect(jar.store('https://api.example.test/v1/login', [cookie('sid')], NOW)).toEqual([{ stored: true }]);
    expect(jar.list(NOW)).toEqual([
      {
        name: 'sid',
        value: 'sid-value',
        domain: 'api.example.test',
        hostOnly: true,
        path: '/v1',
        secure: false,
        httpOnly: false,
        createdAt: NOW,
      },
    ]);
    expect(names(jar.cookiesFor('https://api.example.test/v1/pets', NOW))).toEqual(['sid']);
    expect(jar.cookiesFor('https://www.api.example.test/v1/pets', NOW)).toEqual([]);
    expect(jar.cookiesFor('https://example.test/v1/pets', NOW)).toEqual([]);
  });

  it('lowercases a Domain, strips its dot, and sends it to every host under it', () => {
    const jar = new CookieJar();
    jar.store('https://api.example.test/login', [cookie('wide', { domain: '.Example.TEST', path: '/' })], NOW);
    expect(jar.list(NOW)[0]).toMatchObject({ domain: 'example.test', hostOnly: false, path: '/' });
    expect(names(jar.cookiesFor('https://other.example.test/x', NOW))).toEqual(['wide']);
    expect(names(jar.cookiesFor('https://example.test/', NOW))).toEqual(['wide']);
    expect(jar.cookiesFor('https://evil-example.test/', NOW)).toEqual([]);
  });

  it('refuses a Domain the request host is not part of', () => {
    const jar = new CookieJar();
    expect(jar.store('https://api.example.test/', [cookie('a', { domain: 'other.test' })], NOW)).toEqual([
      { stored: false, reason: 'domain-mismatch' },
    ]);
    expect(jar.store('https://api.example.test/', [cookie('b', { domain: 'api.example.test.evil' })], NOW)).toEqual([
      { stored: false, reason: 'domain-mismatch' },
    ]);
    expect(jar.list(NOW)).toEqual([]);
  });

  it('refuses a single-label or IP Domain unless it is the request host, and then stores it host-only', () => {
    const jar = new CookieJar();
    expect(jar.store('https://api.example.test/', [cookie('tld', { domain: 'test' })], NOW)).toEqual([
      { stored: false, reason: 'domain-not-allowed' },
    ]);
    expect(jar.store('http://10.0.0.5/', [cookie('ip', { domain: '10.0.0.6' })], NOW)).toEqual([
      { stored: false, reason: 'domain-not-allowed' },
    ]);
    expect(jar.store('http://10.0.0.5/', [cookie('same-ip', { domain: '10.0.0.5' })], NOW)).toEqual([{ stored: true }]);
    expect(jar.store('http://localhost/', [cookie('local', { domain: 'localhost' })], NOW)).toEqual([{ stored: true }]);
    expect(jar.list(NOW).map((stored) => [stored.name, stored.domain, stored.hostOnly])).toEqual([
      ['same-ip', '10.0.0.5', true],
      ['local', 'localhost', true],
    ]);
  });

  it('strips IPv6 brackets from hostname, storing and sending cookies for http://[::1]/', () => {
    const jar = new CookieJar();
    expect(jar.store('http://[::1]/', [cookie('ipv6')], NOW)).toEqual([{ stored: true }]);
    expect(jar.list(NOW)).toEqual([
      {
        name: 'ipv6',
        value: 'ipv6-value',
        domain: '::1',
        hostOnly: true,
        path: '/',
        secure: false,
        httpOnly: false,
        createdAt: NOW,
      },
    ]);
    expect(names(jar.cookiesFor('http://[::1]/x', NOW))).toEqual(['ipv6']);
  });
});

describe('CookieJar — paths and order', () => {
  it('defaults a missing or relative Path and matches by path prefix', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/api/v3/login', [cookie('default'), cookie('relative', { path: 'x' })], NOW);
    expect(jar.list(NOW).map((stored) => stored.path)).toEqual(['/api/v3', '/api/v3']);
    expect(names(jar.cookiesFor('https://api.test/api/v3', NOW))).toEqual(['default', 'relative']);
    expect(names(jar.cookiesFor('https://api.test/api/v3/pets', NOW))).toEqual(['default', 'relative']);
    expect(jar.cookiesFor('https://api.test/api/v4', NOW)).toEqual([]);
    expect(jar.cookiesFor('https://api.test/api/v3x', NOW)).toEqual([]);
  });

  it('sends longer paths first, then the earlier created (RFC 6265 §5.4)', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('root-old', { path: '/' })], NOW);
    jar.store('https://api.test/', [cookie('root-new', { path: '/' })], NOW + 5);
    jar.store('https://api.test/', [cookie('deep', { path: '/api' })], NOW + 9);
    expect(names(jar.cookiesFor('https://api.test/api/x', NOW + 10))).toEqual(['deep', 'root-old', 'root-new']);
  });

  it('lists by domain, then name', () => {
    const jar = new CookieJar();
    jar.store('https://b.test/', [cookie('z', { path: '/' }), cookie('a', { path: '/' })], NOW);
    jar.store('https://a.test/', [cookie('m', { path: '/' })], NOW);
    expect(jar.list(NOW).map((stored) => `${stored.domain}/${stored.name}`)).toEqual([
      'a.test/m',
      'b.test/a',
      'b.test/z',
    ]);
  });
});

describe('CookieJar — replacing, expiry and deletion', () => {
  it('replaces a cookie of the same name, domain and path, keeping when it was first stored', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('sid', { value: '1', path: '/' })], NOW);
    jar.store('https://api.test/', [cookie('sid', { value: '2', path: '/' })], NOW + 1000);
    expect(jar.list(NOW + 1000)).toEqual([expect.objectContaining({ name: 'sid', value: '2', createdAt: NOW })]);
  });

  it('deletes a stored cookie on Max-Age=0, and stores nothing', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('sid', { path: '/' })], NOW);
    expect(jar.store('https://api.test/', [cookie('sid', { path: '/', maxAge: 0 })], NOW + 1)).toEqual([
      { stored: false, reason: 'deleted' },
    ]);
    expect(jar.list(NOW + 1)).toEqual([]);
  });

  it('deletes a stored cookie on an Expires in the past', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('sid', { path: '/' })], NOW);
    expect(
      jar.store('https://api.test/', [cookie('sid', { path: '/', expires: '2020-01-01T00:00:00.000Z' })], NOW),
    ).toEqual([{ stored: false, reason: 'deleted' }]);
    expect(jar.list(NOW)).toEqual([]);
  });

  it('computes expiry from Max-Age before Expires', () => {
    const jar = new CookieJar();
    jar.store(
      'https://api.test/',
      [cookie('sid', { path: '/', maxAge: 60, expires: '2020-01-01T00:00:00.000Z' })],
      NOW,
    );
    expect(jar.list(NOW)[0]?.expiresAt).toBe(NOW + 60_000);
  });

  it('drops expired cookies whenever it is read', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('short', { path: '/', maxAge: 10 })], NOW);
    expect(jar.cookiesFor('https://api.test/', NOW + 10_001)).toEqual([]);
    expect(jar.list(NOW + 10_001)).toEqual([]);
    expect(jar.list(NOW)).toEqual([]);
  });

  it('saves only cookies with an expiry', () => {
    const jar = new CookieJar();
    jar.store(
      'https://api.test/',
      [cookie('session', { path: '/' }), cookie('kept', { path: '/', maxAge: 3600 })],
      NOW,
    );
    expect(jar.persistent(NOW)).toEqual([expect.objectContaining({ name: 'kept', expiresAt: NOW + 3_600_000 })]);
  });
});

describe('CookieJar — Secure', () => {
  it('refuses a Secure cookie from plain http, and never sends one over it', () => {
    const jar = new CookieJar();
    expect(jar.store('http://api.test/', [cookie('s', { secure: true, path: '/' })], NOW)).toEqual([
      { stored: false, reason: 'secure-over-http' },
    ]);
    jar.store('https://api.test/', [cookie('s', { secure: true, path: '/' })], NOW);
    expect(jar.cookiesFor('http://api.test/', NOW)).toEqual([]);
    expect(names(jar.cookiesFor('https://api.test/', NOW))).toEqual(['s']);
  });

  it('lets no plain http response overwrite a Secure cookie', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('s', { value: 'safe', secure: true, path: '/' })], NOW);
    expect(jar.store('http://api.test/', [cookie('s', { value: 'forged', path: '/' })], NOW)).toEqual([
      { stored: false, reason: 'secure-over-http' },
    ]);
    expect(jar.list(NOW)[0]?.value).toBe('safe');
  });

  it('refuses a non-Secure cookie if a Secure cookie shadows it (RFC 6265bis §5.3 step 13)', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('sid', { value: 'secure', path: '/', secure: true })], NOW);
    expect(jar.store('http://api.test/', [cookie('sid', { value: 'forged', path: '/api' })], NOW)).toEqual([
      { stored: false, reason: 'secure-over-http' },
    ]);
    expect(jar.list(NOW)[0]?.value).toBe('secure');
  });
});

describe('CookieJar — limits', () => {
  it('refuses a name plus value over 4096 bytes', () => {
    const jar = new CookieJar();
    expect(jar.store('https://api.test/', [cookie('big', { value: 'x'.repeat(4094) })], NOW)).toEqual([
      { stored: false, reason: 'too-large' },
    ]);
    expect(jar.store('https://api.test/', [cookie('fit', { value: 'x'.repeat(4093) })], NOW)).toEqual([
      { stored: true },
    ]);
  });

  it('keeps at most 50 per domain, evicting the oldest session cookie', () => {
    const jar = new CookieJar();
    for (let index = 0; index <= MAX_COOKIES_PER_DOMAIN; index += 1) {
      jar.store('https://api.test/', [cookie(`c${String(index)}`, { path: '/' })], NOW + index);
    }
    const kept = names(jar.list(NOW + 100));
    expect(kept).toHaveLength(MAX_COOKIES_PER_DOMAIN);
    expect(kept).not.toContain('c0');
    expect(kept).toContain('c50');
  });

  it('evicts the cookie expiring soonest before any session cookie', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('short', { path: '/', maxAge: 60 })], NOW + 1000);
    for (let index = 0; index < MAX_COOKIES_PER_DOMAIN; index += 1) {
      jar.store('https://api.test/', [cookie(`s${String(index)}`, { path: '/' })], NOW + index);
    }
    const kept = names(jar.list(NOW + 1000));
    expect(kept).toHaveLength(MAX_COOKIES_PER_DOMAIN);
    expect(kept).not.toContain('short');
  });

  it('keeps at most 3000 in all', () => {
    const jar = new CookieJar();
    let stored = 0;
    for (let domain = 0; stored <= MAX_COOKIES; domain += 1) {
      for (let index = 0; index < MAX_COOKIES_PER_DOMAIN && stored <= MAX_COOKIES; index += 1) {
        jar.store(`https://h${String(domain)}.test/`, [cookie(`c${String(index)}`, { path: '/' })], NOW + stored);
        stored += 1;
      }
    }
    expect(jar.list(NOW + stored)).toHaveLength(MAX_COOKIES);
  });
});

describe('CookieJar — verdicts and edits', () => {
  it('gives one verdict per cookie, in order', () => {
    const jar = new CookieJar();
    expect(
      jar.store(
        'https://api.test/',
        [
          cookie('ok'),
          { name: 'junk line', value: '', malformed: true },
          cookie(''),
          cookie('far', { domain: 'x.test' }),
        ],
        NOW,
      ),
    ).toEqual([
      { stored: true },
      { stored: false, reason: 'malformed' },
      { stored: false, reason: 'malformed' },
      { stored: false, reason: 'domain-mismatch' },
    ]);
  });

  it('refuses everything for a URL it cannot parse', () => {
    expect(new CookieJar().store('not a url', [cookie('a')], NOW)).toEqual([{ stored: false, reason: 'malformed' }]);
    expect(new CookieJar().cookiesFor('not a url', NOW)).toEqual([]);
  });

  it('sets, removes, removes a domain and clears', () => {
    const base: StoredCookie = {
      name: 'a',
      value: '1',
      domain: 'api.test',
      hostOnly: true,
      path: '/',
      secure: false,
      httpOnly: false,
      createdAt: NOW,
    };
    const jar = new CookieJar([base]);
    jar.set({ ...base, name: 'b' });
    jar.set({ ...base, name: 'c', domain: 'other.test' });
    expect(names(jar.list(NOW))).toEqual(['a', 'b', 'c']);
    expect(jar.remove({ name: 'a', domain: 'api.test', path: '/' })).toBe(true);
    expect(jar.remove({ name: 'a', domain: 'api.test', path: '/' })).toBe(false);
    expect(jar.removeDomain('.API.test')).toBe(1);
    expect(names(jar.list(NOW))).toEqual(['c']);
    jar.clear();
    expect(jar.list(NOW)).toEqual([]);
  });
});

describe('mergeCookieHeader', () => {
  const stored = (name: string, value: string): StoredCookie => ({
    name,
    value,
    domain: 'api.test',
    hostOnly: true,
    path: '/',
    secure: false,
    httpOnly: false,
    createdAt: NOW,
  });

  it('puts hand-set pairs first, and they win on the same name', () => {
    expect(mergeCookieHeader([stored('sid', 'jar'), stored('lang', 'en')], 'sid=mine; extra=1')).toBe(
      'sid=mine; extra=1; lang=en',
    );
  });

  it('keeps two jar cookies of one name, in the order given', () => {
    expect(mergeCookieHeader([stored('sid', 'deep'), stored('sid', 'root')], undefined)).toBe('sid=deep; sid=root');
  });

  it('is undefined when there is nothing to send', () => {
    expect(mergeCookieHeader([], undefined)).toBeUndefined();
    expect(mergeCookieHeader([], '  ')).toBeUndefined();
  });
});

describe('jarCookieHost', () => {
  it('reads and stores at the clock it is given', () => {
    const jar = new CookieJar();
    let clock = NOW;
    const host = jarCookieHost(jar, () => clock);
    expect(host.remember('https://api.test/', [cookie('sid', { path: '/', maxAge: 1 })])).toEqual([{ stored: true }]);
    expect(names([...host.cookiesFor('https://api.test/')])).toEqual(['sid']);
    clock = NOW + 1000;
    expect(host.cookiesFor('https://api.test/')).toEqual([]);
  });
});

describe('CookieJar.set — the manager keeps the jar bounded', () => {
  function stored(name: string, domain: string): StoredCookie {
    return { name, value: 'v', domain, hostOnly: true, path: '/', secure: false, httpOnly: false, createdAt: NOW };
  }

  it('evicts past the per-domain limit like a stored cookie', () => {
    const jar = new CookieJar();
    for (let index = 0; index <= MAX_COOKIES_PER_DOMAIN; index += 1) {
      jar.set({ ...stored(`c${index}`, 'a.test'), createdAt: NOW + index }, NOW);
    }
    expect(jar.list(NOW)).toHaveLength(MAX_COOKIES_PER_DOMAIN);
    expect(names(jar.list(NOW))).not.toContain('c0');
  });

  it('evicts past the total limit', () => {
    const jar = new CookieJar();
    for (let index = 0; index <= MAX_COOKIES; index += 1) {
      jar.set({ ...stored('c', `d${index}.test`), createdAt: NOW + index }, NOW);
    }
    expect(jar.list(NOW)).toHaveLength(MAX_COOKIES);
  });
});

describe('CookieJar — what the wire schema would refuse', () => {
  it.each([
    ['a name with whitespace', cookie('my token')],
    ['a name with a tab', cookie('a\tb')],
    ['a name with a semicolon', cookie('a;b')],
    ['a name with an equals sign', cookie('a=b')],
    ['a name with a control character', cookie('a\u0001b')],
    ['a value with a semicolon', cookie('sid', { value: 'a;b' })],
    ['a value with a line feed', cookie('sid', { value: 'a\nb' })],
    ['a value with a carriage return', cookie('sid', { value: 'a\rb' })],
    ['a value with a NUL', cookie('sid', { value: 'a\0b' })],
  ])('refuses %s as malformed and stores nothing', (_label, bad) => {
    const jar = new CookieJar();
    expect(jar.store('https://api.example.test/', [bad], NOW)).toEqual([{ stored: false, reason: 'malformed' }]);
    expect(jar.list(NOW)).toEqual([]);
  });

  it('refuses to set such a cookie by hand too', () => {
    const jar = new CookieJar();
    const stored: StoredCookie = {
      name: 'my token',
      value: 'x',
      domain: 'api.example.test',
      hostOnly: true,
      path: '/',
      secure: false,
      httpOnly: false,
      createdAt: NOW,
    };
    expect(() => {
      jar.set(stored, NOW);
    }).toThrow(/name/);
    expect(jar.list(NOW)).toEqual([]);
  });
});
