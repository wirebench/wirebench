import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTION_GROUPS,
  AUDIT_ACTOR_KINDS,
  AUDIT_TARGET_KINDS,
  FEATURES,
  SCIM_TOKEN_NAME_MAX_LENGTH,
  SCIM_TOKEN_PATTERN,
  metaResponseSchema,
  samlInfoResponseSchema,
  scimGroupLinkRequestSchema,
  scimGroupsResponseSchema,
  scimTokenCreateRequestSchema,
  scimTokenCreatedSchema,
  scimTokensResponseSchema,
} from '../../../src/index.js';

const SCIM_TOKEN = `wbscim_${'a'.repeat(43)}`;
const ID = '01K000000000000000000000T1';

const meta = {
  name: 'wirebench-server',
  version: '1.0.0',
  apiVersion: 1,
  publicUrl: 'https://wirebench.test',
  auth: { local: true, oidc: false },
  capabilities: [],
};

describe('SAML and SCIM wire shapes (saml-scim spec §4)', () => {
  it('names the sso-provisioning feature', () => {
    expect(FEATURES).toContain('sso-provisioning');
  });

  it('audit knows the SCIM actor, its targets and its action group', () => {
    expect(AUDIT_ACTOR_KINDS).toContain('scim');
    expect(AUDIT_TARGET_KINDS).toEqual(expect.arrayContaining(['scim-token', 'scim-group']));
    expect(AUDIT_ACTION_GROUPS).toContain('scim');
  });

  it('meta carries SAML when the server has it, and parses without it from an older server', () => {
    expect(metaResponseSchema.parse(meta).auth).toEqual({ local: true, oidc: false });
    expect(
      metaResponseSchema.parse({ ...meta, auth: { local: true, oidc: false, saml: true, samlDisplayName: 'SSO' } })
        .auth,
    ).toEqual({ local: true, oidc: false, saml: true, samlDisplayName: 'SSO' });
  });

  it('a SCIM token is wbscim_ plus 43 base64url characters, and a device token is not one', () => {
    expect(SCIM_TOKEN_PATTERN.test(SCIM_TOKEN)).toBe(true);
    expect(SCIM_TOKEN_PATTERN.test(`wbs_${'a'.repeat(43)}`)).toBe(false);
    expect(
      scimTokenCreatedSchema.parse({ id: ID, name: 'Entra', token: SCIM_TOKEN, createdAt: '2026-10-13T10:00:00Z' }),
    ).toMatchObject({ token: SCIM_TOKEN });
  });

  it('a listed SCIM token never carries the secret', () => {
    const [listed] = scimTokensResponseSchema.parse([
      { id: ID, name: 'Entra', createdAt: '2026-10-13T10:00:00Z', lastUsedAt: null, token: SCIM_TOKEN },
    ]);
    expect(listed).not.toHaveProperty('token');
  });

  it('bounds a SCIM token name', () => {
    expect(scimTokenCreateRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(scimTokenCreateRequestSchema.safeParse({ name: 'x'.repeat(SCIM_TOKEN_NAME_MAX_LENGTH) }).success).toBe(true);
    expect(scimTokenCreateRequestSchema.safeParse({ name: 'x'.repeat(SCIM_TOKEN_NAME_MAX_LENGTH + 1) }).success).toBe(
      false,
    );
  });

  it('describes groups with their linked team, and a link names a team', () => {
    expect(
      scimGroupsResponseSchema.parse([
        { id: ID, displayName: 'QA', memberCount: 3, team: { id: ID, name: 'QA' } },
        { id: ID, displayName: 'Ops', memberCount: 0, team: null },
      ]),
    ).toHaveLength(2);
    expect(scimGroupLinkRequestSchema.safeParse({ teamId: ID }).success).toBe(true);
    expect(scimGroupLinkRequestSchema.safeParse({}).success).toBe(false);
  });

  it('SAML info carries what an IdP admin needs', () => {
    expect(
      samlInfoResponseSchema.parse({
        configured: false,
        entityId: 'https://wirebench.test/api/v1/auth/saml/metadata',
        acsUrl: 'https://wirebench.test/api/v1/auth/saml/acs',
        scimBaseUrl: 'https://wirebench.test/scim/v2',
      }),
    ).toMatchObject({ configured: false });
  });
});
