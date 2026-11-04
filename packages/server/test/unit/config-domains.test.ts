/**
 * The two hosted names (hosted edition spec §21.1): `WIREBENCH_SERVER_APP_DOMAIN` and
 * `WIREBENCH_SERVER_SITE_DOMAIN`. No real domain appears here: `app.test`, `site.test` and their kin only.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, domainProblems, loadConfig, type ServerConfig } from '../../src/config.js';
import { main } from '../../src/main.js';

const required = {
  WIREBENCH_SERVER_DATABASE_URL: 'postgres://u:p@db/wirebench',
  WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.example.com',
};

function problemsOf(env: Record<string, string>): readonly { variable: string; message: string }[] {
  try {
    loadConfig({ ...required, ...env }, '0.0.0');
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('the app and site domains', () => {
  it('reads both, folding upper case', () => {
    const config = loadConfig(
      { ...required, WIREBENCH_SERVER_APP_DOMAIN: 'App.Test', WIREBENCH_SERVER_SITE_DOMAIN: 'SITE.test' },
      '0.0.0',
    );
    expect(config.appDomain).toBe('app.test');
    expect(config.siteDomain).toBe('site.test');
  });

  it('leaves both unset by default', () => {
    const config = loadConfig(required, '0.0.0');
    expect(config.appDomain).toBeUndefined();
    expect(config.siteDomain).toBeUndefined();
  });

  it.each([
    ['https://app.test', 'a scheme'],
    ['app.test:443', 'a port'],
    ['app.test/x', 'a path'],
    ['app.test.', 'a trailing dot'],
    ['localhost', 'one label'],
    ['10.0.0.5', 'an IPv4 literal'],
    ['[::1]', 'an IPv6 literal'],
    [`${'a'.repeat(64)}.test`, 'a 64-character label'],
    ['-app.test', 'a leading hyphen'],
    ['app-.test', 'a trailing hyphen'],
    ['app_x.test', 'an underscore'],
    ['a..test', 'an empty label'],
    [`${'a.'.repeat(126)}test`, 'more than 253 characters'],
  ])('refuses %s (%s), naming the variable', (value) => {
    for (const variable of ['WIREBENCH_SERVER_APP_DOMAIN', 'WIREBENCH_SERVER_SITE_DOMAIN']) {
      const problems = problemsOf({ [variable]: value });
      expect(problems.map((problem) => problem.variable)).toContain(variable);
    }
  });

  it.each([
    ['app.test', 'app.test', 'equal'],
    ['app.site.test', 'site.test', 'the app domain under the site domain'],
    ['site.test', 'www.site.test', 'the site domain under the app domain'],
  ])('refuses %s with %s (%s)', (app, site) => {
    const problems = problemsOf({ WIREBENCH_SERVER_APP_DOMAIN: app, WIREBENCH_SERVER_SITE_DOMAIN: site });
    expect(problems.map((problem) => problem.variable)).toEqual(['WIREBENCH_SERVER_SITE_DOMAIN']);
    expect(problems[0]?.message).toContain('apart');
  });

  it.each([
    [`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`, 'exactly 253 characters'],
    ['xn--bcher-kva.test', 'a punycode label'],
    ['app.xn--p1ai', 'a punycode top-level label'],
  ])('accepts %s (%s)', (value) => {
    expect(problemsOf({ WIREBENCH_SERVER_APP_DOMAIN: value })).toEqual([]);
  });

  it('refuses an all-numeric top-level label', () => {
    expect(problemsOf({ WIREBENCH_SERVER_APP_DOMAIN: 'app.123' }).map((problem) => problem.variable)).toEqual([
      'WIREBENCH_SERVER_APP_DOMAIN',
    ]);
  });

  it('accepts names that only share a suffix of characters, not of labels', () => {
    expect(
      problemsOf({ WIREBENCH_SERVER_APP_DOMAIN: 'xsite.test', WIREBENCH_SERVER_SITE_DOMAIN: 'site.test' }),
    ).toEqual([]);
  });

  it('requires both in hosted mode', () => {
    const base = loadConfig(required, '0.0.0');
    const hosted: ServerConfig = { ...base, mode: 'hosted' };
    expect(domainProblems(hosted).map((problem) => problem.message)).toEqual([
      expect.stringContaining('domains-app-domain-missing'),
      expect.stringContaining('domains-site-domain-missing'),
    ]);
    expect(domainProblems({ ...hosted, appDomain: 'app.test', siteDomain: 'site.test' })).toEqual([]);
    expect(domainProblems(base)).toEqual([]);
  });
});

describe('the DNS servers of the custom-name check (spec §23.2)', () => {
  it('reads IP addresses, each with an optional port, comma-separated', () => {
    const config = loadConfig(
      {
        ...required,
        WIREBENCH_SERVER_DNS_SERVERS: ' 192.0.2.53, 192.0.2.54:5353,[2001:db8::53]:53 , 2001:db8::54,[2001:db8::55]',
      },
      '0.0.0',
    );
    expect(config.dnsServers).toEqual([
      '192.0.2.53',
      '192.0.2.54:5353',
      '[2001:db8::53]:53',
      '2001:db8::54',
      '[2001:db8::55]',
    ]);
  });

  it('leaves it unset by default: the system resolver', () => {
    expect(loadConfig(required, '0.0.0').dnsServers).toBeUndefined();
  });

  it.each([
    ['dns.test', 'a host name'],
    ['dns.test:53', 'a host name with a port'],
    ['192.0.2.53:0', 'port 0'],
    ['192.0.2.53:65536', 'a port past 65535'],
    ['192.0.2.53:', 'an empty port'],
    ['999.0.2.53', 'not an IPv4 address'],
    ['[dns.test]:53', 'a name in brackets'],
    ['udp://192.0.2.53', 'a scheme'],
    [',', 'no server at all'],
  ])('refuses %s (%s), naming the variable', (value) => {
    expect(problemsOf({ WIREBENCH_SERVER_DNS_SERVERS: value }).map((problem) => problem.variable)).toEqual([
      'WIREBENCH_SERVER_DNS_SERVERS',
    ]);
  });
});

describe('config check', () => {
  async function check(env: Record<string, string>): Promise<{ code: number; out: string }> {
    let out = '';
    const code = await main(['config', 'check'], {
      env: { ...required, ...env },
      stdout: { write: (chunk: string) => ((out += chunk), true) },
      stderr: { write: () => true },
    });
    return { code, out };
  }

  it('says the two names are unused on a self-hosted server', async () => {
    const { code, out } = await check({
      WIREBENCH_SERVER_APP_DOMAIN: 'app.test',
      WIREBENCH_SERVER_SITE_DOMAIN: 'site.test',
    });
    expect(code).toBe(0);
    expect(out).toContain('WIREBENCH_SERVER_APP_DOMAIN and WIREBENCH_SERVER_SITE_DOMAIN are read in hosted mode only');
  });

  it('prints no such line when neither is set', async () => {
    const { out } = await check({});
    expect(out).not.toContain('hosted mode only');
  });
});
