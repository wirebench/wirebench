/**
 * Cookie matching. Sending a cookie to the wrong host or over plain HTTP is a credential leak, so
 * the negative cases here matter more than the positive ones.
 */
import { describe, expect, it } from 'vitest';
import {
  cookieHeader,
  cookiesToSend,
  defaultPath,
  domainMatches,
  isExpired,
  pathMatches,
} from '../../../src/rest/cookies.js';
import type { Cookie } from '../../../src/rest/response.js';

const NOW = new Date('2026-09-13T12:00:00Z');

function cookie(name: string, extra: Partial<Cookie> = {}): Cookie {
  return { name, value: `${name}-value`, ...extra };
}

describe('domainMatches', () => {
  it.each([
    ['api.example.test', 'example.test', true],
    ['example.test', 'example.test', true],
    ['example.test', '.example.test', true],
    ['EXAMPLE.test', 'example.TEST', true],
    ['evil-example.test', 'example.test', false],
    ['example.test', 'api.example.test', false],
    ['127.0.0.1', '0.0.1', false],
  ])('%s against %s', (host, domain, expected) => {
    expect(domainMatches(host, domain)).toBe(expected);
  });
});

describe('defaultPath and pathMatches', () => {
  it.each([
    ['/api/v3/pet', '/api/v3'],
    ['/pet', '/'],
    ['/', '/'],
    ['pet', '/'],
  ])('default path of %s is %s', (pathname, expected) => {
    expect(defaultPath(pathname)).toBe(expected);
  });

  it.each([
    ['/api/v3/pet', '/api', true],
    ['/api/v3/pet', '/api/', true],
    ['/api/v3/pet', '/api/v3/pet', true],
    ['/apifoo', '/api', false],
    ['/api', '/api/v3', false],
  ])('%s against cookie path %s', (requestPath, cookiePath, expected) => {
    expect(pathMatches(requestPath, cookiePath)).toBe(expected);
  });
});

describe('isExpired', () => {
  it('treats a past Expires as expired and a future one as live', () => {
    expect(isExpired(cookie('a', { expires: '2020-01-01T00:00:00Z' }), NOW)).toBe(true);
    expect(isExpired(cookie('a', { expires: '2030-01-01T00:00:00Z' }), NOW)).toBe(false);
  });

  it('prefers Max-Age over Expires, counted from when it was received', () => {
    const setAt = new Date(NOW.getTime() - 10_000);
    expect(isExpired(cookie('a', { maxAge: 5, expires: '2030-01-01T00:00:00Z' }), NOW, setAt)).toBe(true);
    expect(isExpired(cookie('a', { maxAge: 60, expires: '2020-01-01T00:00:00Z' }), NOW, setAt)).toBe(false);
  });

  it('treats Max-Age 0 or negative as expired at once', () => {
    expect(isExpired(cookie('a', { maxAge: 0 }), NOW)).toBe(true);
    expect(isExpired(cookie('a', { maxAge: -1 }), NOW)).toBe(true);
  });

  it('treats a session cookie as live', () => {
    expect(isExpired(cookie('a'), NOW)).toBe(false);
  });
});

describe('cookiesToSend', () => {
  const jar: Cookie[] = [
    cookie('host-only'),
    cookie('scoped', { domain: 'example.test' }),
    cookie('other-host', { domain: 'other.test' }),
    cookie('secure-only', { secure: true }),
    cookie('deep', { path: '/api/v3' }),
    cookie('gone', { expires: '2020-01-01T00:00:00Z' }),
    { name: 'junk', value: '', malformed: true },
  ];

  it('sends what matches over https', () => {
    expect(cookiesToSend(jar, 'https://api.example.test/api/v3/pet', NOW).map((c) => c.name)).toEqual([
      'host-only',
      'scoped',
      'secure-only',
      'deep',
    ]);
  });

  it('withholds a Secure cookie over plain http', () => {
    expect(cookiesToSend(jar, 'http://api.example.test/api/v3/pet', NOW).map((c) => c.name)).not.toContain(
      'secure-only',
    );
  });

  it('withholds a cookie scoped to another host', () => {
    expect(cookiesToSend(jar, 'https://api.example.test/api/v3/pet', NOW).map((c) => c.name)).not.toContain(
      'other-host',
    );
  });

  it('withholds a cookie whose path does not cover the request', () => {
    expect(cookiesToSend(jar, 'https://api.example.test/health', NOW).map((c) => c.name)).not.toContain('deep');
  });

  it('withholds an expired and a malformed cookie', () => {
    const names = cookiesToSend(jar, 'https://api.example.test/api/v3/pet', NOW).map((c) => c.name);
    expect(names).not.toContain('gone');
    expect(names).not.toContain('junk');
  });

  it('sends nothing for a URL it cannot parse', () => {
    expect(cookiesToSend(jar, 'not a url', NOW)).toEqual([]);
  });
});

describe('cookieHeader', () => {
  it('joins pairs with "; " and keeps the last value of a repeated name', () => {
    expect(cookieHeader([cookie('a'), cookie('b'), { name: 'a', value: 'newer' }])).toBe('a=newer; b=b-value');
  });

  it('is undefined when there is nothing to send', () => {
    expect(cookieHeader([])).toBeUndefined();
  });
});
