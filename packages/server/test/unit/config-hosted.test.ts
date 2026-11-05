/**
 * Hosted mode switched on (hosted edition spec §22.1; slice 7 Task 32): `loadConfig` accepts
 * `WIREBENCH_SERVER_MODE=hosted` with everything it requires set, names each missing variable and each refused one,
 * and never a value. Every value here is a placeholder: no real key, no real domain.
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIG_VARIABLES,
  ConfigError,
  describeConfig,
  egressPolicyOf,
  hostedProblems,
  instanceModeOf,
  loadConfig,
  PER_TENANT_VARIABLES,
} from '../../src/config.js';

const SECRET = 'pdl_ntfset_test_placeholder_secret_value';
const APP_PASSWORD = 'placeholder-app-pw';
const CONTROL_PASSWORD = 'placeholder-control-pw';

/** Everything hosted mode requires, set (spec §22.1). */
const HOSTED: Record<string, string> = {
  WIREBENCH_SERVER_MODE: 'hosted',
  WIREBENCH_SERVER_PUBLIC_URL: 'https://app.app.test',
  WIREBENCH_SERVER_DATABASE_URL: `postgres://wirebench_app:${APP_PASSWORD}@db/wirebench`,
  WIREBENCH_SERVER_MIGRATION_DATABASE_URL: 'postgres://wirebench:placeholder-owner-pw@db/wirebench',
  WIREBENCH_SERVER_CONTROL_DATABASE_URL: `postgres://wirebench_control:${CONTROL_PASSWORD}@db/wirebench`,
  WIREBENCH_SERVER_APP_DOMAIN: 'app.test',
  WIREBENCH_SERVER_SITE_DOMAIN: 'site.test',
  WIREBENCH_SERVER_SMTP_URL: 'smtp://mail.site.test:587',
  WIREBENCH_SERVER_SMTP_FROM: 'teams@site.test',
  WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
  WIREBENCH_SERVER_INSTANCE_URL: 'http://server:8091',
  WIREBENCH_SERVER_PADDLE_ENVIRONMENT: 'sandbox',
  WIREBENCH_SERVER_PADDLE_CLIENT_TOKEN: 'test_placeholdertoken',
  WIREBENCH_SERVER_PADDLE_TEAM_PRICE_ID: 'pri_test_team',
  WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET: SECRET,
};

/** What hosted mode needs that the defaults do not give, each refused by name when missing. */
const REQUIRED = Object.keys(HOSTED).filter(
  (variable) => variable !== 'WIREBENCH_SERVER_MODE' && variable !== 'WIREBENCH_SERVER_PUBLIC_URL',
);

function problemsOf(env: Record<string, string>): readonly { variable: string; message: string }[] {
  try {
    loadConfig(env, '0.0.0');
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

/** A value that parses for each per-tenant variable, so each is refused for being set, not for its shape. */
const PER_TENANT_VALUES: Record<string, string> = {
  WIREBENCH_SERVER_OIDC_ISSUER: 'https://idp.site.test',
  WIREBENCH_SERVER_OIDC_CLIENT_ID: 'placeholder-client',
  WIREBENCH_SERVER_OIDC_CLIENT_SECRET: 'placeholder-oidc-secret',
  WIREBENCH_SERVER_OIDC_SCOPES: 'openid email',
  WIREBENCH_SERVER_OIDC_DISPLAY_NAME: 'Company',
  WIREBENCH_SERVER_SAML_IDP_METADATA: '/etc/wirebench/idp.xml',
  WIREBENCH_SERVER_SAML_DISPLAY_NAME: 'Company SSO',
  WIREBENCH_SERVER_SAML_EMAIL_ATTRIBUTE: 'mail',
  WIREBENCH_SERVER_SAML_NAME_ATTRIBUTE: 'displayName',
  WIREBENCH_SERVER_SAML_CLOCK_SKEW_SECONDS: '60',
  WIREBENCH_SERVER_AUDIT_FORWARD_URL: 'https://siem.site.test/ingest',
  WIREBENCH_SERVER_AUDIT_FORWARD_TOKEN: 'placeholder-forward-token',
  WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE: '/etc/wirebench/ca.pem',
};

describe('hosted mode (spec §22.1)', () => {
  it('loads with everything it requires set: always multi, private ranges always denied', () => {
    const config = loadConfig(HOSTED, '0.0.0');
    expect(config).toMatchObject({ mode: 'hosted', appDomain: 'app.test', siteDomain: 'site.test' });
    expect(instanceModeOf(config)).toBe('multi');
    expect(egressPolicyOf(config)).toEqual({ denyPrivate: true });
    expect(describeConfig(HOSTED)).toContainEqual({ variable: 'WIREBENCH_SERVER_MODE', status: 'set' });
  });

  it.each(REQUIRED)('names %s when it is missing', (variable) => {
    const env = { ...HOSTED };
    delete env[variable];
    const problems = problemsOf(env);
    expect(problems.map((p) => p.variable)).toEqual([variable]);
  });

  it('names every missing variable at once, and no value', () => {
    const problems = problemsOf({
      WIREBENCH_SERVER_MODE: 'hosted',
      WIREBENCH_SERVER_PUBLIC_URL: HOSTED.WIREBENCH_SERVER_PUBLIC_URL!,
      WIREBENCH_SERVER_DATABASE_URL: HOSTED.WIREBENCH_SERVER_DATABASE_URL!,
    });
    expect(problems.map((p) => p.variable).sort()).toEqual(
      REQUIRED.filter((v) => v !== 'WIREBENCH_SERVER_DATABASE_URL').sort(),
    );
    expect(JSON.stringify(problems)).not.toContain(APP_PASSWORD);
  });

  it('keeps the SMTP check’s code, moved from the entry’s registration', () => {
    const env = { ...HOSTED };
    delete env.WIREBENCH_SERVER_SMTP_URL;
    delete env.WIREBENCH_SERVER_SMTP_FROM;
    const problems = problemsOf(env);
    expect(problems.map((p) => p.variable)).toEqual(['WIREBENCH_SERVER_SMTP_URL', 'WIREBENCH_SERVER_SMTP_FROM']);
    for (const problem of problems) expect(problem.message).toMatch(/^entry-smtp-missing: /);
  });

  it('refuses a migration URL that is the app role’s', () => {
    for (const migration of [
      HOSTED.WIREBENCH_SERVER_DATABASE_URL!,
      // Another host, the same role: a pooler beside a direct connection is still one role.
      `postgres://wirebench_app:${APP_PASSWORD}@direct.db/wirebench`,
    ]) {
      const problems = problemsOf({ ...HOSTED, WIREBENCH_SERVER_MIGRATION_DATABASE_URL: migration });
      expect(problems).toEqual([
        {
          variable: 'WIREBENCH_SERVER_MIGRATION_DATABASE_URL',
          message: expect.stringMatching(/^control-plane-migration-url-shared: /) as unknown,
        },
      ]);
      expect(JSON.stringify(problems)).not.toContain(APP_PASSWORD);
    }
  });

  it('lists every OIDC, SAML and audit forwarding variable as per tenant, and nothing else', () => {
    const expected = CONFIG_VARIABLES.map((v) => v.env).filter((env) =>
      /^WIREBENCH_SERVER_(OIDC|SAML|AUDIT_FORWARD)_/.test(env),
    );
    expect([...PER_TENANT_VARIABLES].sort()).toEqual(expected.sort());
    expect(Object.keys(PER_TENANT_VALUES).sort()).toEqual(expected.sort());
  });

  it.each(Object.entries(PER_TENANT_VALUES))('refuses %s, a tenant’s setting, by name', (variable, value) => {
    const problems = problemsOf({ ...HOSTED, [variable]: value });
    // A credential travelling with the issuer or the URL may add its own rule; this variable is named for itself.
    expect(problems).toContainEqual({
      variable,
      message: expect.stringMatching(/^control-plane-setting-per-tenant: /) as unknown,
    });
    expect(problems.filter((p) => p.message.startsWith('control-plane-setting-per-tenant:'))).toHaveLength(1);
    expect(JSON.stringify(problems)).not.toContain(value);
  });

  it('never names a value in any refusal', () => {
    const problems = problemsOf({ ...HOSTED, ...PER_TENANT_VALUES, WIREBENCH_SERVER_SMTP_URL: '' });
    const text = JSON.stringify(problems);
    for (const value of [
      SECRET,
      APP_PASSWORD,
      CONTROL_PASSWORD,
      'placeholder-oidc-secret',
      'placeholder-forward-token',
    ])
      expect(text).not.toContain(value);
  });

  it('asks nothing of a self-hosted server', () => {
    expect(hostedProblems({ mode: 'self-hosted', databaseUrl: 'postgres://u:p@db/w' }, () => true)).toEqual([]);
    const config = loadConfig(
      {
        WIREBENCH_SERVER_DATABASE_URL: 'postgres://u:p@db/wirebench',
        WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.example.com',
        ...PER_TENANT_VALUES,
        WIREBENCH_SERVER_SAML_IDP_METADATA: '/etc/wirebench/idp.xml',
      },
      '0.0.0',
    );
    expect(config.mode).toBe('self-hosted');
    expect(config.oidcIssuer).toBe('https://idp.site.test');
  });
});
