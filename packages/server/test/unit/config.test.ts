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
        'WIREBENCH_SERVER_BODY_LIMIT_MB',
        'WIREBENCH_SERVER_DATABASE_URL',
        'WIREBENCH_SERVER_DATA_DIR',
        'WIREBENCH_SERVER_GIT_PATH',
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
