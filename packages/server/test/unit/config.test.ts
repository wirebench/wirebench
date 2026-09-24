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
        'WIREBENCH_SERVER_LOG_LEVEL',
        'WIREBENCH_SERVER_PORT',
        'WIREBENCH_SERVER_PUBLIC_URL',
        'WIREBENCH_SERVER_TRUST_PROXY',
      ].sort(),
    );
  });
});
