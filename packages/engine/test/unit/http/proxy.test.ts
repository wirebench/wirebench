import { describe, expect, it } from 'vitest';
import { WirebenchError } from '../../../src/errors.js';
import { isExcluded, parseSystemProxy, resolveProxyFor, type ProxyConfig } from '../../../src/http/proxy.js';

describe('isExcluded', () => {
  it.each([
    ['exact host', 'api.corp.test', ['api.corp.test'], true],
    ['case-insensitive', 'API.Corp.Test', ['api.corp.test'], true],
    ['glob subdomain', 'api.corp.test', ['*.corp.test'], true],
    ['glob does not match the apex', 'corp.test', ['*.corp.test'], false],
    ['dot prefix matches the apex', 'corp.test', ['.corp.test'], true],
    ['dot prefix matches subdomains', 'api.corp.test', ['.corp.test'], true],
    ['cidr', '10.1.2.3', ['10.0.0.0/8'], true],
    ['cidr miss', '11.1.2.3', ['10.0.0.0/8'], false],
    ['cidr /32', '10.0.0.1', ['10.0.0.1/32'], true],
    ['localhost shorthand covers 127.0.0.1', '127.0.0.1', ['localhost'], true],
    ['localhost shorthand covers ::1', '::1', ['localhost'], true],
    ['wildcard excludes everything', 'anything.test', ['*'], true],
    ['blank entries are ignored', 'api.corp.test', ['', '   '], false],
    ['no entries', 'api.corp.test', [], false],
  ])('%s', (_name, host, excludes, expected) => {
    expect(isExcluded(host, excludes as readonly string[])).toBe(expected);
  });
});

describe('parseSystemProxy', () => {
  it.each([
    ['DIRECT', 'DIRECT', { kind: 'direct' }],
    ['PROXY', 'PROXY 10.0.0.1:8080', { kind: 'proxy', url: 'http://10.0.0.1:8080' }],
    ['PROXY first, DIRECT fallback', 'PROXY 10.0.0.1:8080;DIRECT', { kind: 'proxy', url: 'http://10.0.0.1:8080' }],
    ['DIRECT first wins', 'DIRECT;PROXY 10.0.0.1:8080', { kind: 'direct' }],
    ['HTTPS keyword', 'HTTPS secure.corp.test:443', { kind: 'proxy', url: 'https://secure.corp.test:443' }],
    ['lower case keyword', 'proxy 10.0.0.1:3128', { kind: 'proxy', url: 'http://10.0.0.1:3128' }],
    [
      'SOCKS then PROXY falls through',
      'SOCKS5 10.0.0.1:1080;PROXY 10.0.0.2:8080',
      {
        kind: 'proxy',
        url: 'http://10.0.0.2:8080',
      },
    ],
    ['SOCKS then DIRECT goes direct', 'SOCKS5 10.0.0.1:1080;DIRECT', { kind: 'direct' }],
    ['empty string', '', { kind: 'direct' }],
    ['undefined', undefined, { kind: 'direct' }],
  ])('%s', (_name, input, expected) => {
    expect(parseSystemProxy(input)).toEqual(expected);
  });

  // A SOCKS-only answer used to look exactly like `DIRECT`, so a corporate SOCKS proxy silently
  // became a direct connection the firewall then dropped. It is now reported, not swallowed.
  it.each([
    ['SOCKS5', 'SOCKS5 10.0.0.1:1080', 'socks5'],
    ['SOCKS4', 'SOCKS4 10.0.0.1:1080', 'socks4'],
    ['bare SOCKS', 'SOCKS 10.0.0.1:1080', 'socks'],
    ['lower case', 'socks5 10.0.0.1:1080', 'socks5'],
  ])('reports a SOCKS-only answer as unsupported (%s)', (_name, input, scheme) => {
    expect(parseSystemProxy(input)).toEqual({ kind: 'unsupported', scheme });
  });
});

describe('resolveProxyFor', () => {
  const manual: ProxyConfig = { mode: 'manual', host: 'proxy.corp.test', port: 8080, excludes: ['*.internal.test'] };

  it('returns undefined for mode none', () => {
    expect(resolveProxyFor('http://api.test/x', { mode: 'none' })).toBeUndefined();
  });

  it('builds the manual proxy URL', () => {
    expect(resolveProxyFor('http://api.test/x', manual)).toEqual({ url: 'http://proxy.corp.test:8080' });
  });

  it('attaches credentials when a username and resolved password are given', () => {
    const config: ProxyConfig = { ...manual, username: 'u', passwordRef: 'secret:1' };
    expect(resolveProxyFor('http://api.test/x', config, { password: 'p' })).toEqual({
      url: 'http://proxy.corp.test:8080',
      auth: { username: 'u', password: 'p' },
    });
  });

  it('never puts a passwordRef on the wire', () => {
    const config: ProxyConfig = { ...manual, username: 'u', passwordRef: 'secret:1' };
    expect(JSON.stringify(resolveProxyFor('http://api.test/x', config))).not.toContain('secret:1');
  });

  it('honours excludes for the manual mode', () => {
    expect(resolveProxyFor('http://box.internal.test/x', manual)).toBeUndefined();
  });

  it('honours excludes for the system mode, before asking the resolver', () => {
    let asked = 0;
    const resolved = resolveProxyFor(
      'http://box.internal.test/x',
      { mode: 'system', excludes: ['*.internal.test'] },
      {
        resolveSystem: () => {
          asked += 1;
          return 'PROXY 10.0.0.1:8080';
        },
      },
    );
    expect(resolved).toBeUndefined();
    expect(asked).toBe(0);
  });

  it('asks the injected resolver for the system mode', () => {
    expect(
      resolveProxyFor('http://api.test/x', { mode: 'system' }, { resolveSystem: () => 'PROXY 10.0.0.1:8080' }),
    ).toEqual({ url: 'http://10.0.0.1:8080' });
  });

  it('throws proxy-unsupported rather than going direct when the system proxy is SOCKS', () => {
    let error: unknown;
    try {
      resolveProxyFor('http://api.test/x', { mode: 'system' }, { resolveSystem: () => 'SOCKS5 10.0.0.1:1080' });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(WirebenchError);
    expect((error as WirebenchError).code).toBe('proxy-unsupported');
    expect((error as WirebenchError).message).toMatch(/SOCKS5/i);
  });

  it('goes direct for the system mode when no resolver is injected', () => {
    expect(resolveProxyFor('http://api.test/x', { mode: 'system' })).toBeUndefined();
  });

  it('accepts a host that already carries a scheme', () => {
    expect(resolveProxyFor('http://api.test/x', { ...manual, host: 'http://proxy.corp.test' })).toEqual({
      url: 'http://proxy.corp.test:8080',
    });
  });

  it.each([
    ['blank host', { ...manual, host: '  ' }],
    ['zero port', { ...manual, port: 0 }],
    ['fractional port', { ...manual, port: 1.5 }],
  ])('goes direct for an incomplete manual config (%s)', (_name, config) => {
    expect(resolveProxyFor('http://api.test/x', config as ProxyConfig)).toBeUndefined();
  });

  it('goes direct when the request URL cannot be parsed', () => {
    expect(resolveProxyFor('not a url', manual)).toBeUndefined();
  });
});
