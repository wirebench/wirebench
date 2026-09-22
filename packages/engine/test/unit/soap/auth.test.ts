import { describe, expect, it } from 'vitest';
import { applySoapAuth } from '../../../src/soap/auth.js';

const URL_ = 'https://h/s';

describe('applySoapAuth', () => {
  it('adds a Bearer header', () => {
    expect(applySoapAuth(URL_, undefined, { type: 'bearer', token: 't' })).toEqual({
      endpoint: URL_,
      headers: { Authorization: 'Bearer t' },
    });
  });

  it('uses a custom scheme', () => {
    expect(applySoapAuth(URL_, undefined, { type: 'bearer', token: 't', scheme: 'Token' }).headers).toEqual({
      Authorization: 'Token t',
    });
  });

  it('sends an OAuth2 access token as Bearer', () => {
    expect(applySoapAuth(URL_, undefined, { type: 'oauth2', accessToken: 'at' }).headers).toEqual({
      Authorization: 'Bearer at',
    });
  });

  it('adds an API key header', () => {
    const applied = applySoapAuth(URL_, { A: '1' }, { type: 'api-key', name: 'X-Api-Key', value: 'k', in: 'header' });
    expect(applied.headers).toEqual({ A: '1', 'X-Api-Key': 'k' });
    expect(applied.endpoint).toBe(URL_);
  });

  it('appends an API key to the query string', () => {
    expect(applySoapAuth(URL_, undefined, { type: 'api-key', name: 'key', value: 'k', in: 'query' })).toEqual({
      endpoint: 'https://h/s?key=k',
      headers: {},
    });
  });

  it('keeps an existing query and fragment', () => {
    const auth = { type: 'api-key', name: 'key', value: 'k', in: 'query' } as const;
    expect(applySoapAuth('https://h/s?a=1#f', undefined, auth).endpoint).toBe('https://h/s?a=1&key=k#f');
  });

  it('encodes the query value', () => {
    const auth = { type: 'api-key', name: 'key', value: 'a b&c', in: 'query' } as const;
    expect(applySoapAuth(URL_, undefined, auth).endpoint).toBe('https://h/s?key=a%20b%26c');
  });

  it("leaves the endpoint's own query exactly as configured", () => {
    const auth = { type: 'api-key', name: 'key', value: 'k', in: 'query' } as const;
    expect(applySoapAuth('http://h/svc.asmx?op', undefined, auth).endpoint).toBe('http://h/svc.asmx?op&key=k');
    expect(applySoapAuth('https://h/s?a=x%20y&p=/a/b:c', undefined, auth).endpoint).toBe(
      'https://h/s?a=x%20y&p=/a/b:c&key=k',
    );
    expect(applySoapAuth('https://h/s?', undefined, auth).endpoint).toBe('https://h/s?key=k');
  });

  it('returns an unparseable endpoint unchanged', () => {
    const auth = { type: 'api-key', name: 'key', value: 'k', in: 'query' } as const;
    expect(applySoapAuth('not a url', undefined, auth).endpoint).toBe('not a url');
  });

  it('lets a caller header win case-insensitively', () => {
    const applied = applySoapAuth(URL_, { authorization: 'Mine' }, { type: 'bearer', token: 't' });
    expect(applied.headers).toEqual({ authorization: 'Mine' });
  });

  it('hands Basic and NTLM to the transport', () => {
    const basic = { type: 'basic', username: 'u', password: 'p', preemptive: true } as const;
    expect(applySoapAuth(URL_, undefined, basic)).toEqual({ endpoint: URL_, headers: {}, transportAuth: basic });
    const ntlm = { type: 'ntlm', username: 'u', password: 'p' } as const;
    expect(applySoapAuth(URL_, { A: '1' }, ntlm)).toEqual({ endpoint: URL_, headers: { A: '1' }, transportAuth: ntlm });
  });

  it('changes nothing without auth', () => {
    expect(applySoapAuth(URL_, undefined, undefined)).toEqual({ endpoint: URL_, headers: {} });
  });
});
