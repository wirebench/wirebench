import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/config.js';
import { samlSettings, ssoUrls } from '../../../src/sso/env.js';

const required = {
  WIREBENCH_SERVER_DATABASE_URL: 'postgres://u:p@db/wirebench',
  WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.example.com',
};

const problemsOf = (env: Record<string, string>): string[] => {
  try {
    loadConfig({ ...required, ...env }, '1.0.0');
    return [];
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return error.problems.map((p) => `${p.variable}: ${p.message}`);
  }
};

describe('SAML configuration (saml-scim spec §3.1)', () => {
  it('is off by default, with the documented defaults', () => {
    const config = loadConfig(required, '1.0.0');
    expect(config.samlIdpMetadata).toBeUndefined();
    expect(config).toMatchObject({ samlDisplayName: 'SSO', samlClockSkewSeconds: 120 });
  });

  it('takes an https:// URL or an absolute path, and refuses anything else', () => {
    expect(problemsOf({ WIREBENCH_SERVER_SAML_IDP_METADATA: 'https://idp.example.com/metadata' })).toEqual([]);
    expect(problemsOf({ WIREBENCH_SERVER_SAML_IDP_METADATA: '/etc/wirebench/idp.xml' })).toEqual([]);
    expect(problemsOf({ WIREBENCH_SERVER_SAML_IDP_METADATA: 'idp.xml' })[0]).toMatch(/SAML_IDP_METADATA: must be/);
    expect(problemsOf({ WIREBENCH_SERVER_SAML_IDP_METADATA: 'http://idp.local/metadata' })[0]).toMatch(/https/);
    expect(
      problemsOf({
        WIREBENCH_SERVER_SAML_IDP_METADATA: 'http://idp.local/metadata',
        WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
        WIREBENCH_SERVER_PUBLIC_URL: 'http://localhost:8080',
      }),
    ).toEqual([]);
  });

  it('bounds the clock skew and the display name', () => {
    expect(problemsOf({ WIREBENCH_SERVER_SAML_CLOCK_SKEW_SECONDS: '300' })).toEqual([]);
    expect(problemsOf({ WIREBENCH_SERVER_SAML_CLOCK_SKEW_SECONDS: '301' })).toHaveLength(1);
    expect(problemsOf({ WIREBENCH_SERVER_SAML_DISPLAY_NAME: 'x'.repeat(61) })).toHaveLength(1);
  });

  it('counts SAML as a sign-in method when local accounts are off', () => {
    expect(problemsOf({ WIREBENCH_SERVER_LOCAL_AUTH: 'false' })[0]).toMatch(/identity-no-method/);
    expect(
      problemsOf({
        WIREBENCH_SERVER_LOCAL_AUTH: 'false',
        WIREBENCH_SERVER_SAML_IDP_METADATA: 'https://idp.example.com/metadata',
      }),
    ).toEqual([]);
  });
});

describe('samlSettings and ssoUrls (saml-scim spec §3.1)', () => {
  it('derives the SP URLs from the public URL', () => {
    expect(ssoUrls('https://wirebench.example.com')).toEqual({
      entityId: 'https://wirebench.example.com/api/v1/auth/saml/metadata',
      acsUrl: 'https://wirebench.example.com/api/v1/auth/saml/acs',
      scimBaseUrl: 'https://wirebench.example.com/scim/v2',
    });
  });

  it('is undefined without metadata, and carries the knobs with it', () => {
    expect(samlSettings(loadConfig(required, '1.0.0'))).toBeUndefined();
    expect(
      samlSettings(
        loadConfig(
          {
            ...required,
            WIREBENCH_SERVER_SAML_IDP_METADATA: '/etc/idp.xml',
            WIREBENCH_SERVER_SAML_EMAIL_ATTRIBUTE: 'upn',
            WIREBENCH_SERVER_SAML_CLOCK_SKEW_SECONDS: '30',
          },
          '1.0.0',
        ),
      ),
    ).toEqual({ metadataSource: '/etc/idp.xml', displayName: 'SSO', clockSkewMs: 30_000, emailAttribute: 'upn' });
  });
});
