import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/args.js';
import { proxyFromEnv } from '../../src/proxy-env.js';

describe('proxyFromEnv', () => {
  it('uses HTTPS_PROXY for https: URLs', () => {
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://p:8080' })('https://api.test/x')).toEqual({ url: 'http://p:8080/' });
  });

  it('uses HTTP_PROXY for http: URLs, not for https:', () => {
    const proxyFor = proxyFromEnv({ HTTP_PROXY: 'http://p:3128' });
    expect(proxyFor('http://api.test/x')).toEqual({ url: 'http://p:3128/' });
    expect(proxyFor('https://api.test/x')).toBeUndefined();
  });

  it('accepts the lower-case variables', () => {
    const proxyFor = proxyFromEnv({ https_proxy: 'http://s:1', http_proxy: 'http://h:2' });
    expect(proxyFor('https://a.test')?.url).toBe('http://s:1/');
    expect(proxyFor('http://a.test')?.url).toBe('http://h:2/');
  });

  it('is undefined when no variable is set', () => {
    expect(proxyFromEnv({})('https://api.test')).toBeUndefined();
  });

  it('NO_PROXY matches the host exactly', () => {
    const proxyFor = proxyFromEnv({ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'api.test' });
    expect(proxyFor('https://api.test/x')).toBeUndefined();
    expect(proxyFor('https://other.test/x')).toBeDefined();
  });

  it('NO_PROXY matches a .suffix, with or without the leading dot', () => {
    const dotted = proxyFromEnv({ HTTPS_PROXY: 'http://p:1', NO_PROXY: '.corp.test' });
    const bare = proxyFromEnv({ HTTPS_PROXY: 'http://p:1', no_proxy: 'corp.test' });
    for (const proxyFor of [dotted, bare]) {
      expect(proxyFor('https://a.corp.test')).toBeUndefined();
      expect(proxyFor('https://notcorp.test')).toBeDefined();
    }
  });

  it('NO_PROXY=* bypasses every host', () => {
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'x.test, *' })('https://a.test')).toBeUndefined();
  });

  it('moves userinfo into auth and strips it from the URL', () => {
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://me:s%40cret@p:8080' })('https://a.test')).toEqual({
      url: 'http://p:8080/',
      auth: { username: 'me', password: 's@cret' },
    });
  });

  it('refuses an unparseable proxy URL', () => {
    expect(() => proxyFromEnv({ HTTPS_PROXY: 'not a url' })).toThrow(UsageError);
  });
});
