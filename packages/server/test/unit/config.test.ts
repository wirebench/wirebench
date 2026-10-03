import { isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_VARIABLES, ConfigError, describeConfig, loadConfig } from '../../src/config.js';

const required = {
  WIREBENCH_SERVER_DATABASE_URL: 'postgres://u:p@db/wirebench',
  WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.example.com',
};

describe('loadConfig', () => {
  it('applies the documented defaults when only the required variables are set', () => {
    const config = loadConfig(required, '2.1.1');
    expect(config).toMatchObject({
      databaseUrl: required.WIREBENCH_SERVER_DATABASE_URL,
      publicUrl: 'https://wirebench.example.com',
      dataDir: '/data',
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'info',
      trustProxy: false,
      bodyLimitMb: 32,
      allowInsecurePublicUrl: false,
      version: '2.1.1',
    });
    expect(config.gitPath).toBeUndefined();
  });

  it('names every missing required variable in one error and never echoes a value', () => {
    let caught: unknown;
    try {
      loadConfig({ WIREBENCH_SERVER_DATABASE_URL: 'postgres://secret@db/x' }, '2.1.1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const problems = (caught as ConfigError).problems;
    expect(problems.map((p) => p.variable)).toEqual(['WIREBENCH_SERVER_PUBLIC_URL']);
    expect(problems[0]?.message).toBe('is required');
    expect(JSON.stringify(problems)).not.toContain('secret');
  });

  it('refuses a public URL with a path, query or trailing slash', () => {
    for (const bad of ['https://x.example.com/', 'https://x.example.com/app', 'https://x.example.com?x=1']) {
      expect(() => loadConfig({ ...required, WIREBENCH_SERVER_PUBLIC_URL: bad }, '2.1.1')).toThrow(ConfigError);
    }
  });

  it('refuses an http public URL unless the insecure flag is set', () => {
    const insecure = { ...required, WIREBENCH_SERVER_PUBLIC_URL: 'http://localhost:8080' };
    expect(() => loadConfig(insecure, '2.1.1')).toThrow(/WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL/);
    expect(loadConfig({ ...insecure, WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true' }, '2.1.1').publicUrl).toBe(
      'http://localhost:8080',
    );
  });

  it('refuses any scheme but https, and http without the flag, whatever its case', () => {
    for (const bad of ['HTTP://example.com', 'ftp://example.com', 'Http://localhost:8080']) {
      expect(() => loadConfig({ ...required, WIREBENCH_SERVER_PUBLIC_URL: bad }, '2.1.1')).toThrow(ConfigError);
    }
    expect(() =>
      loadConfig(
        {
          ...required,
          WIREBENCH_SERVER_PUBLIC_URL: 'ftp://example.com',
          WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
        },
        '2.1.1',
      ),
    ).toThrow(ConfigError);
  });

  it('stores the public URL as its normalised origin', () => {
    expect(
      loadConfig({ ...required, WIREBENCH_SERVER_PUBLIC_URL: 'HTTPS://WireBench.Example.com:443' }, '2.1.1').publicUrl,
    ).toBe('https://wirebench.example.com');
    expect(
      loadConfig(
        {
          ...required,
          WIREBENCH_SERVER_PUBLIC_URL: 'HTTP://LocalHost:8080',
          WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
        },
        '2.1.1',
      ).publicUrl,
    ).toBe('http://localhost:8080');
  });

  it('resolves a relative data directory to an absolute path', () => {
    const config = loadConfig({ ...required, WIREBENCH_SERVER_DATA_DIR: 'relative/data' }, '2.1.1');
    expect(isAbsolute(config.dataDir)).toBe(true);
    expect(config.dataDir).toBe(resolve('relative/data'));
  });

  it('parses booleans and numbers from their string forms', () => {
    const config = loadConfig(
      {
        ...required,
        WIREBENCH_SERVER_TRUST_PROXY: '1',
        WIREBENCH_SERVER_PORT: '9090',
        WIREBENCH_SERVER_BODY_LIMIT_MB: '8',
      },
      '2.1.1',
    );
    expect(config.trustProxy).toBe(true);
    expect(config.port).toBe(9090);
    expect(config.bodyLimitMb).toBe(8);
    expect(() => loadConfig({ ...required, WIREBENCH_SERVER_PORT: 'eighty' }, '2.1.1')).toThrow(ConfigError);
    expect(() => loadConfig({ ...required, WIREBENCH_SERVER_TRUST_PROXY: 'yes' }, '2.1.1')).toThrow(ConfigError);
  });

  it('defaults and bounds the audit retention (audit-log spec §3.3)', () => {
    expect(loadConfig(required, '2.1.1')).toMatchObject({ auditMaxAgeDays: 365 });
    expect(loadConfig({ ...required, WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS: '3650' }, '2.1.1')).toMatchObject({
      auditMaxAgeDays: 3650,
    });
    expect(() => loadConfig({ ...required, WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS: '29' }, '2.1.1')).toThrow(ConfigError);
  });

  it('defaults and bounds the webhook-capture variables (webhook-capture §3.7)', () => {
    expect(loadConfig(required, '2.1.1')).toMatchObject({
      hooksEnabled: true,
      hooksBodyLimitMb: 1,
      hooksKeep: 500,
      hooksMaxAgeDays: 7,
      hooksRatePerSecond: 10,
      hooksBurst: 50,
      hooksPerWorkspace: 50,
    });
    expect(
      loadConfig(
        {
          ...required,
          WIREBENCH_SERVER_HOOKS_ENABLED: 'false',
          WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB: '32',
          WIREBENCH_SERVER_HOOKS_KEEP: '10000',
          WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS: '365',
          WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND: '1000',
          WIREBENCH_SERVER_HOOKS_BURST: '1',
          WIREBENCH_SERVER_HOOKS_PER_WORKSPACE: '1000',
        },
        '2.1.1',
      ),
    ).toMatchObject({
      hooksEnabled: false,
      hooksBodyLimitMb: 32,
      hooksKeep: 10_000,
      hooksMaxAgeDays: 365,
      hooksRatePerSecond: 1000,
      hooksBurst: 1,
      hooksPerWorkspace: 1000,
    });
    for (const [variable, value] of [
      ['WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB', '0'],
      ['WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB', '33'],
      ['WIREBENCH_SERVER_HOOKS_KEEP', '10001'],
      ['WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS', '366'],
      ['WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND', '0'],
      ['WIREBENCH_SERVER_HOOKS_BURST', '10001'],
      ['WIREBENCH_SERVER_HOOKS_PER_WORKSPACE', '1001'],
      ['WIREBENCH_SERVER_HOOKS_ENABLED', 'maybe'],
    ] as const) {
      let caught: unknown;
      try {
        loadConfig({ ...required, [variable]: value }, '2.1.1');
      } catch (error) {
        caught = error;
      }
      expect((caught as ConfigError).problems.map((p) => p.variable)).toEqual([variable]);
    }
  });
});

describe('describeConfig', () => {
  it('reports each variable as set, defaulted, missing or invalid, without values', () => {
    const rows = describeConfig({ ...required, WIREBENCH_SERVER_PORT: 'x' });
    const byName = Object.fromEntries(rows.map((row) => [row.variable, row.status]));
    expect(byName.WIREBENCH_SERVER_DATABASE_URL).toBe('set');
    expect(byName.WIREBENCH_SERVER_DATA_DIR).toBe('defaulted');
    expect(byName.WIREBENCH_SERVER_PORT).toBe('invalid');
    expect(byName.WIREBENCH_SERVER_GIT_PATH).toBe('missing');
    expect(JSON.stringify(rows)).not.toContain('postgres://');
  });

  it('documents every variable the schema knows', () => {
    expect(CONFIG_VARIABLES.map((v) => v.env).sort()).toEqual(
      [
        'WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL',
        'WIREBENCH_SERVER_AUDIT_CHAIN_KEY',
        'WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE',
        'WIREBENCH_SERVER_AUDIT_FORWARD_TOKEN',
        'WIREBENCH_SERVER_AUDIT_FORWARD_URL',
        'WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS',
        'WIREBENCH_SERVER_BODY_LIMIT_MB',
        'WIREBENCH_SERVER_DATABASE_URL',
        'WIREBENCH_SERVER_DATA_DIR',
        'WIREBENCH_SERVER_GIT_PATH',
        'WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB',
        'WIREBENCH_SERVER_HOOKS_BURST',
        'WIREBENCH_SERVER_HOOKS_ENABLED',
        'WIREBENCH_SERVER_HOOKS_KEEP',
        'WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS',
        'WIREBENCH_SERVER_HOOKS_PER_WORKSPACE',
        'WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND',
        'WIREBENCH_SERVER_HOOKS_SECRET_KEY',
        'WIREBENCH_SERVER_HOST',
        'WIREBENCH_SERVER_INVITATION_DAYS',
        'WIREBENCH_SERVER_LOCAL_AUTH',
        'WIREBENCH_SERVER_LOG_LEVEL',
        'WIREBENCH_SERVER_OIDC_CLIENT_ID',
        'WIREBENCH_SERVER_OIDC_CLIENT_SECRET',
        'WIREBENCH_SERVER_OIDC_DISPLAY_NAME',
        'WIREBENCH_SERVER_OIDC_ISSUER',
        'WIREBENCH_SERVER_OIDC_SCOPES',
        'WIREBENCH_SERVER_PORT',
        'WIREBENCH_SERVER_PUBLIC_URL',
        'WIREBENCH_SERVER_TOKEN_IDLE_DAYS',
        'WIREBENCH_SERVER_TOKEN_MAX_DAYS',
        'WIREBENCH_SERVER_TRUST_PROXY',
      ].sort(),
    );
  });
});

describe('identity configuration (§4.1)', () => {
  const base = { WIREBENCH_SERVER_DATABASE_URL: 'postgres://x', WIREBENCH_SERVER_PUBLIC_URL: 'https://w.test' };
  const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
    try {
      loadConfig(env, '1');
      return [];
    } catch (error) {
      return (error as ConfigError).problems.map((p) => `${p.variable}: ${p.message}`);
    }
  };

  it('defaults to local auth on, OIDC off, 30/180-day tokens, 7-day invitations, the documented scopes', () => {
    const config = loadConfig(base, '1');
    expect(config).toMatchObject({
      localAuth: true,
      tokenIdleDays: 30,
      tokenMaxDays: 180,
      invitationDays: 7,
      oidcDisplayName: 'OIDC',
    });
    expect(config.oidcIssuer).toBeUndefined();
    expect(config.oidcScopes).toEqual(['openid', 'email', 'profile']);
  });

  it('requires the client id and secret once an issuer is set, naming both at once', () => {
    const problems = problemsOf({ ...base, WIREBENCH_SERVER_OIDC_ISSUER: 'https://idp.test' });
    expect(problems).toEqual([
      'WIREBENCH_SERVER_OIDC_CLIENT_ID: is required when WIREBENCH_SERVER_OIDC_ISSUER is set',
      'WIREBENCH_SERVER_OIDC_CLIENT_SECRET: is required when WIREBENCH_SERVER_OIDC_ISSUER is set',
    ]);
  });

  it('refuses both methods off with identity-no-method', () => {
    expect(problemsOf({ ...base, WIREBENCH_SERVER_LOCAL_AUTH: 'false' })[0]).toContain('identity-no-method');
  });

  it('accepts an http issuer only with the insecure flag, and splits the scopes on whitespace', () => {
    const oidc = {
      WIREBENCH_SERVER_OIDC_ISSUER: 'http://127.0.0.1:9',
      WIREBENCH_SERVER_OIDC_CLIENT_ID: 'c',
      WIREBENCH_SERVER_OIDC_CLIENT_SECRET: 's',
    };
    expect(problemsOf({ ...base, ...oidc })[0]).toContain('WIREBENCH_SERVER_OIDC_ISSUER');
    const config = loadConfig(
      {
        ...base,
        ...oidc,
        WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
        WIREBENCH_SERVER_OIDC_SCOPES: ' openid  email ',
      },
      '1',
    );
    expect(config.oidcScopes).toEqual(['openid', 'email']);
    expect(config.oidcClientSecret).toBe('s');
  });

  it('marks the client secret as a secret so config check and the README never print it', () => {
    expect(CONFIG_VARIABLES.find((v) => v.env === 'WIREBENCH_SERVER_OIDC_CLIENT_SECRET')?.secret).toBe(true);
  });
});

describe('audit forwarding configuration (issue #209)', () => {
  const URL_VAR = 'WIREBENCH_SERVER_AUDIT_FORWARD_URL';
  const TOKEN_VAR = 'WIREBENCH_SERVER_AUDIT_FORWARD_TOKEN';
  const caught = (env: NodeJS.ProcessEnv): ConfigError => {
    try {
      loadConfig({ ...required, ...env }, '1');
    } catch (error) {
      if (error instanceof ConfigError) return error;
      throw error;
    }
    throw new Error('expected a ConfigError');
  };

  it('is off by default: no URL, no token, no CA file', () => {
    const config = loadConfig(required, '1');
    expect(config.auditForwardUrl).toBeUndefined();
    expect(config.auditForwardToken).toBeUndefined();
    expect(config.auditForwardCaFile).toBeUndefined();
  });

  it('accepts syslog over TCP or TLS, https, and http on a loopback host', () => {
    for (const url of [
      'syslog+tcp://collector.example.com:514',
      'syslog+tls://collector.example.com:6514',
      'https://siem.example.com/ingest/wirebench',
      'http://localhost:8088/audit',
      'http://127.0.0.1:8088/audit',
      'http://127.9.9.9/audit',
      'http://[::1]:8088/audit',
    ]) {
      expect(loadConfig({ ...required, [URL_VAR]: url }, '1').auditForwardUrl).toBe(url);
    }
    const tls = loadConfig(
      {
        ...required,
        [URL_VAR]: 'https://siem.example.com/ingest',
        [TOKEN_VAR]: 'tok-123',
        WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE: '/etc/ssl/corp.pem',
      },
      '1',
    );
    expect(tls.auditForwardToken).toBe('tok-123');
    expect(tls.auditForwardCaFile).toBe('/etc/ssl/corp.pem');
  });

  it('refuses http on a host that is not loopback, without echoing the URL', () => {
    for (const url of ['http://siem.example.com/ingest', 'http://10.0.0.5:8088/x', 'http://localhost.evil.example/x']) {
      const error = caught({ [URL_VAR]: url });
      expect(error.problems.map((p) => p.variable)).toEqual([URL_VAR]);
      expect(JSON.stringify(error.problems)).not.toContain(new URL(url).hostname);
      expect(error.message).not.toContain(url);
    }
  });

  it('refuses an unknown scheme, a syslog URL without a port, and text that is no URL', () => {
    for (const url of [
      'syslog+udp://collector.example.com:514',
      'ftp://collector.example.com/x',
      'syslog://collector.example.com:514',
      'syslog+tcp://collector.example.com',
      'not a url at all',
    ]) {
      const error = caught({ [URL_VAR]: url });
      expect(error.problems.map((p) => p.variable)).toEqual([URL_VAR]);
      expect(error.message).not.toContain('collector');
      expect(error.message).not.toContain(url);
    }
  });

  it('refuses a token with a syslog URL, without echoing the token', () => {
    const error = caught({ [URL_VAR]: 'syslog+tls://collector.example.com:6514', [TOKEN_VAR]: 'sekrit-token' });
    expect(error.problems.map((p) => p.variable)).toEqual([TOKEN_VAR]);
    expect(error.message).not.toContain('sekrit-token');
    expect(error.message).not.toContain('collector');
  });

  it('judges the token rule on the parsed scheme, whatever its case or leading space', () => {
    for (const url of ['SYSLOG+TCP://collector.example.com:514', ' syslog+tls://collector.example.com:6514']) {
      const error = caught({ [URL_VAR]: url, [TOKEN_VAR]: 'sekrit-token' });
      expect(error.problems.map((p) => p.variable)).toEqual([TOKEN_VAR]);
    }
  });

  it('refuses a token without a URL', () => {
    const error = caught({ [TOKEN_VAR]: 'sekrit-token' });
    expect(error.problems.map((p) => p.variable)).toEqual([TOKEN_VAR]);
    expect(error.message).not.toContain('sekrit-token');
  });

  it('refuses a CA file without a URL', () => {
    const error = caught({ WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE: '/etc/ssl/corp.pem' });
    expect(error.problems.map((p) => p.variable)).toEqual(['WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE']);
    expect(error.message).not.toContain('corp.pem');
  });

  it('refuses a CA file with an http URL, which has no TLS to verify', () => {
    const error = caught({
      [URL_VAR]: 'HTTP://127.0.0.1:8088/audit',
      WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE: '/etc/ssl/corp.pem',
    });
    expect(error.problems.map((p) => p.variable)).toEqual(['WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE']);
    expect(error.message).not.toContain('corp.pem');
    for (const url of ['syslog+tls://collector.example.com:6514', 'https://siem.example.com/x']) {
      expect(
        loadConfig({ ...required, [URL_VAR]: url, WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE: '/etc/ssl/corp.pem' }, '1')
          .auditForwardCaFile,
      ).toBe('/etc/ssl/corp.pem');
    }
  });

  it('refuses a URL carrying credentials, without echoing them', () => {
    for (const url of ['https://user:pa55word@siem.example.com/x', 'syslog+tcp://user@collector.example.com:514']) {
      const error = caught({ [URL_VAR]: url });
      expect(error.problems.map((p) => p.variable)).toEqual([URL_VAR]);
      expect(error.message).not.toContain('pa55word');
      expect(error.message).not.toContain('user');
    }
  });

  it('marks the token as a secret and documents all three variables', () => {
    const forward = CONFIG_VARIABLES.filter((v) => v.env.startsWith('WIREBENCH_SERVER_AUDIT_FORWARD_'));
    expect(forward.map((v) => [v.env, v.secret, v.required])).toEqual([
      [URL_VAR, false, false],
      [TOKEN_VAR, true, false],
      ['WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE', false, false],
    ]);
    expect(describeConfig({ ...required, [URL_VAR]: 'http://siem.example.com/x' })).toContainEqual({
      variable: URL_VAR,
      status: 'invalid',
    });
  });
});

describe('audit chain key (issue #210)', () => {
  const KEY_VAR = 'WIREBENCH_SERVER_AUDIT_CHAIN_KEY';

  it('is undefined when unset', () => {
    expect(loadConfig(required, '1').auditChainKey).toBeUndefined();
  });

  it('accepts a key of 32 characters or more', () => {
    for (const key of ['k'.repeat(32), 'a much longer chain key, with spaces and ünïcödé, 0123456789']) {
      expect(loadConfig({ ...required, [KEY_VAR]: key }, '1').auditChainKey).toBe(key);
    }
  });

  it('refuses a shorter key without echoing it', () => {
    const key = 'short-chain-key-31-characters!!';
    expect(key).toHaveLength(31);
    let caught: unknown;
    try {
      loadConfig({ ...required, [KEY_VAR]: key }, '1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    expect(error.problems.map((p) => p.variable)).toEqual([KEY_VAR]);
    expect(error.message).not.toContain(key);
    expect(JSON.stringify(error.problems)).not.toContain('short-chain');
    expect(describeConfig({ ...required, [KEY_VAR]: key })).toContainEqual({ variable: KEY_VAR, status: 'invalid' });
  });

  it('is documented as an optional secret', () => {
    const variable = CONFIG_VARIABLES.find((v) => v.env === KEY_VAR);
    expect([variable?.key, variable?.secret, variable?.required]).toEqual(['auditChainKey', true, false]);
  });
});
