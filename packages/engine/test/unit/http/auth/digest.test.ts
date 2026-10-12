/**
 * Digest against the worked examples of RFC 7616 §3.9.1 (MD5 and SHA-256) and RFC 2617 §3.5, plus
 * the legacy no-`qop` form (RFC 2069) and the `-sess` variants, computed from their definitions.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWwwAuthenticate } from '../../../../src/http/auth/basic.js';
import { digestAuthorization, DigestNonceCache, pickDigestChallenge } from '../../../../src/http/auth/digest.js';

const RFC7616 = [
  'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"',
  'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=MD5, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"',
].join(', ');
const RFC7616_CNONCE = 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ';

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

/** The `name=value` pairs of a `Digest …` header, unquoted. */
function fields(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of header.slice('Digest '.length).matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|[^,\s]*)/g)) {
    const [, name, raw] = match;
    if (name !== undefined && raw !== undefined) out[name] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return out;
}

describe('pickDigestChallenge', () => {
  it('prefers SHA-256 over MD5 and reads qop, realm, nonce and opaque', () => {
    const challenge = pickDigestChallenge(parseWwwAuthenticate(RFC7616));
    expect(challenge).toEqual({
      realm: 'http-auth@example.org',
      nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
      opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS',
      algorithm: 'SHA-256',
      qop: 'auth',
      stale: false,
    });
  });

  it('defaults the algorithm to MD5 and reads stale', () => {
    const challenge = pickDigestChallenge(parseWwwAuthenticate('Digest realm="r", nonce="n", stale=TRUE'));
    expect(challenge).toMatchObject({ algorithm: 'MD5', stale: true });
    expect(challenge?.qop).toBeUndefined();
  });

  it('answers undefined when no Digest challenge is offered', () => {
    expect(pickDigestChallenge(parseWwwAuthenticate('Basic realm="r"'))).toBeUndefined();
  });

  it('refuses a challenge that offers only qop=auth-int', () => {
    expect(() => pickDigestChallenge(parseWwwAuthenticate('Digest realm="r", nonce="n", qop="auth-int"'))).toThrow(
      expect.objectContaining({ code: 'digest-unsupported' }),
    );
  });

  it('skips an algorithm it does not know and refuses when nothing else is left', () => {
    expect(
      pickDigestChallenge(
        parseWwwAuthenticate('Digest realm="r", nonce="a", algorithm=SHA-512-256, Digest realm="r", nonce="b"'),
      ),
    ).toMatchObject({ nonce: 'b', algorithm: 'MD5' });
    expect(() =>
      pickDigestChallenge(parseWwwAuthenticate('Digest realm="r", nonce="a", algorithm=SHA-512-256')),
    ).toThrow(expect.objectContaining({ code: 'digest-unsupported' }));
  });
});

describe('digestAuthorization', () => {
  const base = {
    username: 'Mufasa',
    password: 'Circle of Life',
    method: 'GET',
    uri: '/dir/index.html',
    nc: 1,
    cnonce: RFC7616_CNONCE,
  };
  const realm = 'http-auth@example.org';
  const nonce = '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v';
  const opaque = 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS';

  it('matches the RFC 7616 MD5 example', () => {
    const header = digestAuthorization({
      ...base,
      challenge: { realm, nonce, opaque, algorithm: 'MD5', qop: 'auth', stale: false },
    });
    expect(fields(header)).toEqual({
      username: 'Mufasa',
      realm,
      uri: '/dir/index.html',
      algorithm: 'MD5',
      nonce,
      nc: '00000001',
      cnonce: RFC7616_CNONCE,
      qop: 'auth',
      response: '8ca523f5e9506fed4657c9700eebdbec',
      opaque,
    });
  });

  it('matches the RFC 7616 SHA-256 example', () => {
    const header = digestAuthorization({
      ...base,
      challenge: { realm, nonce, opaque, algorithm: 'SHA-256', qop: 'auth', stale: false },
    });
    expect(fields(header).response).toBe('753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1');
    expect(fields(header).algorithm).toBe('SHA-256');
  });

  it('matches the RFC 2617 example', () => {
    const header = digestAuthorization({
      username: 'Mufasa',
      password: 'Circle Of Life',
      method: 'GET',
      uri: '/dir/index.html',
      nc: 1,
      cnonce: '0a4f113b',
      challenge: {
        realm: 'testrealm@host.com',
        nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
        opaque: '5ccc069c403ebaf9f0171e9517f40e41',
        algorithm: 'MD5',
        qop: 'auth',
        stale: false,
      },
    });
    expect(fields(header).response).toBe('6629fae49393a05397450978507c4ef1');
  });

  it('computes the legacy form without qop, nc or cnonce', () => {
    const header = digestAuthorization({
      username: 'u',
      password: 'p',
      method: 'POST',
      uri: '/x?y=1',
      nc: 1,
      cnonce: 'c',
      challenge: { realm: 'r', nonce: 'n', algorithm: 'MD5', stale: false },
    });
    const parsed = fields(header);
    expect(parsed.response).toBe(md5(`${md5('u:r:p')}:n:${md5('POST:/x?y=1')}`));
    expect(parsed).not.toHaveProperty('nc');
    expect(parsed).not.toHaveProperty('cnonce');
    expect(parsed).not.toHaveProperty('qop');
  });

  it('folds the nonce and cnonce into HA1 for MD5-sess', () => {
    const header = digestAuthorization({
      username: 'u',
      password: 'p',
      method: 'GET',
      uri: '/',
      nc: 2,
      cnonce: 'c',
      challenge: { realm: 'r', nonce: 'n', algorithm: 'MD5-sess', qop: 'auth', stale: false },
    });
    const ha1 = md5(`${md5('u:r:p')}:n:c`);
    expect(fields(header).response).toBe(md5(`${ha1}:n:00000002:c:auth:${md5('GET:/')}`));
    expect(fields(header).algorithm).toBe('MD5-sess');
  });

  it('escapes a quote in the username', () => {
    const header = digestAuthorization({
      ...base,
      username: 'a"b',
      challenge: { realm, nonce, algorithm: 'MD5', qop: 'auth', stale: false },
    });
    expect(header).toContain('username="a\\"b"');
  });
});

describe('DigestNonceCache', () => {
  it('counts nc up per origin and starts again for a new nonce', () => {
    const cache = new DigestNonceCache();
    const challenge = { realm: 'r', nonce: 'n1', algorithm: 'MD5' as const, qop: 'auth' as const, stale: false };
    expect(cache.next('http://a')).toBeUndefined();
    cache.remember('http://a', challenge);
    expect(cache.next('http://a')).toEqual({ challenge, nc: 1 });
    expect(cache.next('http://a')).toEqual({ challenge, nc: 2 });
    expect(cache.next('http://b')).toBeUndefined();
    cache.remember('http://a', { ...challenge, nonce: 'n2' });
    expect(cache.next('http://a')?.nc).toBe(1);
    cache.forget('http://a');
    expect(cache.next('http://a')).toBeUndefined();
  });
});
