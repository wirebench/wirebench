import { afterAll, beforeAll, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { ssoModule } from '../../../src/sso/module.js';
import { expectNoSecretsInAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';

/** The provisioning fire sites (saml-scim spec §3.4–§3.6, plan ruling 10), read back from the stored rows. */
describeDb('SCIM audit events', () => {
  const keys = testKeys();
  let h: IdentityHarness;
  let admin: SignedInUser;
  beforeAll(async () => {
    h = await licensingHarness(keys, {
      extra: (clock) => [
        auditLogModule({ now: () => clock.now }),
        ssoModule({ now: () => clock.now, sweepIntervalMs: 0 }),
      ],
    });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/license',
      headers: admin.headers,
      payload: { license: license(keys, { edition: 'enterprise' }) },
    });
    expect(put.statusCode, put.body).toBe(200);
  });
  afterAll(async () => {
    await h.close();
  });

  const rows = async (action: string) =>
    (
      await h.db.query<{ actor_kind: string; target_kind: string; target_id: string; details: unknown }>(
        'select actor_kind, target_kind, target_id, details from audit_events where action = $1 order by at, id',
        [action],
      )
    ).rows;

  it('records scim.token_created and scim.token_revoked with the name only', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/scim-tokens',
      headers: admin.headers,
      payload: { name: 'Entra ID' },
    });
    const { id } = created.json<{ id: string }>();
    await h.app.inject({ method: 'DELETE', url: `/api/v1/scim-tokens/${id}`, headers: admin.headers });
    expect(await rows('scim.token_created')).toEqual([
      { actor_kind: 'user', target_kind: 'scim-token', target_id: id, details: { name: 'Entra ID' } },
    ]);
    expect(await rows('scim.token_revoked')).toEqual([
      { actor_kind: 'user', target_kind: 'scim-token', target_id: id, details: { name: 'Entra ID' } },
    ]);
    await expectNoSecretsInAudit(h.db);
  });
  it('records user.updated as the SCIM token, with the changed field names only', async () => {
    const token = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/scim-tokens',
        headers: admin.headers,
        payload: { name: 'IdP' },
      })
    ).json<{ id: string; token: string }>();
    const headers = { authorization: `Bearer ${token.token}`, 'content-type': 'application/scim+json' };
    const created = await h.app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers,
      payload: JSON.stringify({ userName: 'ada@example.com', displayName: 'Ada' }),
    });
    const { id } = created.json<{ id: string }>();
    await h.app.inject({
      method: 'PATCH',
      url: `/scim/v2/Users/${id}`,
      headers,
      payload: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'displayName', value: 'Ada Lovelace' }],
      }),
    });
    expect(await rows('user.updated')).toEqual([
      { actor_kind: 'scim', target_kind: 'user', target_id: id, details: { fields: ['displayName'] } },
    ]);
    const actor = await h.db.query<{ actor_token_id: string }>(
      "select actor_token_id from audit_events where action = 'user.updated'",
    );
    expect(actor.rows[0]!.actor_token_id).toBe(token.id);
    await expectNoSecretsInAudit(h.db);
  });
});
