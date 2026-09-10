import { describe, expect, it } from 'vitest';
import { basicAuthorization, isBasicChallenge, parseWwwAuthenticate } from '../../../../src/http/auth/basic.js';

describe('basicAuthorization', () => {
  it('base64-encodes user:password per RFC 7617', () => {
    expect(basicAuthorization('user', 'pass')).toBe(`Basic ${Buffer.from('user:pass', 'utf-8').toString('base64')}`);
  });

  it('encodes non-ASCII credentials as UTF-8', () => {
    const header = basicAuthorization('münch', 'pässwörd');
    expect(header).toBe(`Basic ${Buffer.from('münch:pässwörd', 'utf-8').toString('base64')}`);
    expect(Buffer.from(header.slice('Basic '.length), 'base64').toString('utf-8')).toBe('münch:pässwörd');
  });

  it('keeps a colon in the password (only the first colon separates)', () => {
    expect(Buffer.from(basicAuthorization('u', 'a:b').slice(6), 'base64').toString('utf-8')).toBe('u:a:b');
  });
});

describe('parseWwwAuthenticate', () => {
  it('returns an empty list for an absent or blank header', () => {
    expect(parseWwwAuthenticate(undefined)).toEqual([]);
    expect(parseWwwAuthenticate('   ')).toEqual([]);
  });

  it('parses a quoted realm', () => {
    expect(parseWwwAuthenticate('Basic realm="wirebench"')).toEqual([
      { scheme: 'basic', params: { realm: 'wirebench' } },
    ]);
  });

  it('parses an unquoted parameter value and lower-cases parameter names', () => {
    expect(parseWwwAuthenticate('Digest Realm=wirebench, qop=auth')).toEqual([
      { scheme: 'digest', params: { realm: 'wirebench', qop: 'auth' } },
    ]);
  });

  it('parses multiple challenges in one header', () => {
    expect(parseWwwAuthenticate('Negotiate, NTLM, Basic realm="w, b", charset="UTF-8"')).toEqual([
      { scheme: 'negotiate', params: {} },
      { scheme: 'ntlm', params: {} },
      { scheme: 'basic', params: { realm: 'w, b', charset: 'UTF-8' } },
    ]);
  });

  it('parses a token68 challenge without parameters', () => {
    expect(parseWwwAuthenticate('NTLM TlRMTVNTUAAB')).toEqual([{ scheme: 'ntlm', params: {} }]);
  });
});

describe('isBasicChallenge', () => {
  it('is true for a 401 carrying a Basic challenge, whatever the header casing', () => {
    expect(isBasicChallenge({ status: 401, headers: { 'www-authenticate': 'basic realm="x"' } })).toBe(true);
    expect(isBasicChallenge({ status: 401, headers: { 'WWW-Authenticate': 'Negotiate, Basic' } })).toBe(true);
  });

  it('is false without a 401, without the header, or for another scheme', () => {
    expect(isBasicChallenge({ status: 200, headers: { 'www-authenticate': 'Basic' } })).toBe(false);
    expect(isBasicChallenge({ status: 401, headers: {} })).toBe(false);
    expect(isBasicChallenge({ status: 401, headers: { 'www-authenticate': 'NTLM' } })).toBe(false);
  });
});
