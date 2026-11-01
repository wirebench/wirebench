import { afterEach, beforeEach, expect, it } from 'vitest';
import * as repo from '../../../src/sso/repo.js';
import { sweepSso } from '../../../src/sso/module.js';
import { mintSecret, newId } from '../../../src/identity/tokens.js';
import * as teams from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

describeDb('SAML and SCIM tables (saml-scim spec §4)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness();
  });
  afterEach(() => h.close());

  const flow = (overrides: Partial<Parameters<typeof repo.insertSamlFlow>[1]> = {}) => {
    const input = {
      id: newId(),
      requestId: `_${mintSecret().hash.slice(0, 40)}`,
      codeChallenge: mintSecret().secret,
      loopbackPort: 49152,
      deviceName: 'Mac',
      relayState: mintSecret().secret,
      createdAt: h.clock.now,
      expiresAt: new Date(h.clock.now.getTime() + 600_000),
      ...overrides,
    };
    return repo.insertSamlFlow(h.tdb, input).then(() => input);
  };

  it('links a SAML identity to its user, and the user going takes the identity with it', async () => {
    const ada = await signedInUser(h, { email: 'ada@example.com' });
    await repo.insertSamlIdentity(h.tdb, {
      entityId: 'https://idp',
      nameId: 'n-1',
      userId: ada.user.id,
      at: h.clock.now,
    });
    expect(await repo.samlIdentityOf(h.tdb, 'https://idp', 'n-1')).toEqual({ userId: ada.user.id });
    expect(await repo.samlIdentityOf(h.tdb, 'https://other', 'n-1')).toBeUndefined();
    await expect(
      repo.insertSamlIdentity(h.tdb, { entityId: 'https://idp', nameId: 'n-1', userId: ada.user.id, at: h.clock.now }),
    ).rejects.toThrow();
    await h.tdb.query('delete from users where id = $1', [ada.user.id]);
    expect(await repo.samlIdentityOf(h.tdb, 'https://idp', 'n-1')).toBeUndefined();
  });

  it('finds a flow by relay state, grants it once, redeems it once, and sweeps it when expired', async () => {
    const ada = await signedInUser(h, { email: 'ada@example.com' });
    const f = await flow();
    expect((await repo.samlFlowByRelayState(h.tdb, f.relayState))?.requestId).toBe(f.requestId);
    const grant = mintSecret();
    expect(await repo.grantSamlFlow(h.tdb, f.id, grant.hash, ada.user.id)).toBe(true);
    expect(await repo.grantSamlFlow(h.tdb, f.id, mintSecret().hash, ada.user.id)).toBe(false);
    expect((await repo.samlFlowById(h.tdb, f.id))?.userId).toBe(ada.user.id);
    expect(await repo.claimGrantedSamlFlow(h.tdb, f.id, grant.hash)).toBe(true);
    expect(await repo.claimGrantedSamlFlow(h.tdb, f.id, grant.hash)).toBe(false);

    const stale = await flow({ expiresAt: new Date(h.clock.now.getTime() - 1) });
    const live = await flow();
    await repo.deleteSamlFlow(h.tdb, live.id);
    expect(await repo.samlFlowById(h.tdb, live.id)).toBeUndefined();
    const kept = await flow();
    expect(await repo.deleteExpiredSamlFlows(h.tdb, h.clock.now)).toBe(1);
    expect(await repo.samlFlowById(h.tdb, stale.id)).toBeUndefined();
    expect(await repo.samlFlowById(h.tdb, kept.id)).toBeDefined();
  });

  it('the daily sweep clears expired SAML flows', async () => {
    const stale = await flow({ expiresAt: new Date(h.clock.now.getTime() - 1) });
    await sweepSso(h.tdb, h.clock.now);
    expect(await repo.samlFlowById(h.tdb, stale.id)).toBeUndefined();
  });

  it('keeps SCIM tokens by hash, unique by name among live ones, and touches and revokes them', async () => {
    const admin = await signedInUser(h, { email: 'admin@example.com', serverAdmin: true });
    const first = mintSecret();
    const token = await repo.insertScimToken(h.tdb, {
      id: newId(),
      name: 'Entra',
      tokenHash: first.hash,
      createdBy: admin.user.id,
      at: h.clock.now,
    });
    expect(token).toMatchObject({ name: 'Entra', lastUsedAt: null, revokedAt: null });
    expect((await repo.scimTokenByHash(h.tdb, first.hash))?.id).toBe(token.id);
    await expect(
      repo.insertScimToken(h.tdb, {
        id: newId(),
        name: 'entra',
        tokenHash: mintSecret().hash,
        createdBy: null,
        at: h.clock.now,
      }),
    ).rejects.toThrow();
    await repo.touchScimToken(h.tdb, token.id, new Date(h.clock.now.getTime() + 1000));
    expect((await repo.listScimTokens(h.tdb))[0]?.lastUsedAt).toBe('2026-09-24T12:00:01.000Z');
    expect(await repo.revokeScimToken(h.tdb, token.id, h.clock.now)).toBe(true);
    expect(await repo.revokeScimToken(h.tdb, token.id, h.clock.now)).toBe(false);
    expect(await repo.listScimTokens(h.tdb)).toEqual([]);
    expect((await repo.scimTokenByHash(h.tdb, first.hash))?.revokedAt).not.toBeNull();
    await repo.insertScimToken(h.tdb, {
      id: newId(),
      name: 'Entra',
      tokenHash: mintSecret().hash,
      createdBy: null,
      at: h.clock.now,
    });
  });

  it('records a user’s external id', async () => {
    const ada = await signedInUser(h, { email: 'ada@example.com' });
    expect(await repo.scimUserOf(h.tdb, ada.user.id)).toBeUndefined();
    await repo.upsertScimUser(h.tdb, ada.user.id, 'ext-1', h.clock.now);
    await repo.upsertScimUser(h.tdb, ada.user.id, 'ext-2', h.clock.now);
    expect(await repo.scimUserOf(h.tdb, ada.user.id)).toEqual({ externalId: 'ext-2' });
    await repo.upsertScimUser(h.tdb, ada.user.id, null, h.clock.now);
    expect(await repo.scimUserOf(h.tdb, ada.user.id)).toEqual({ externalId: null });
  });

  it('stores groups, unique by name in any case, with their members', async () => {
    const ada = await signedInUser(h, { email: 'ada@example.com' });
    const bob = await signedInUser(h, { email: 'bob@example.com' });
    const group = await repo.insertScimGroup(h.tdb, {
      id: newId(),
      displayName: 'QA',
      externalId: 'g-1',
      at: h.clock.now,
    });
    await expect(
      repo.insertScimGroup(h.tdb, { id: newId(), displayName: 'qa', externalId: null, at: h.clock.now }),
    ).rejects.toThrow();
    expect(await repo.addGroupMembers(h.tdb, group.id, [ada.user.id, bob.user.id])).toEqual(
      [ada.user.id, bob.user.id].sort(),
    );
    expect(await repo.addGroupMembers(h.tdb, group.id, [ada.user.id])).toEqual([]);
    expect(await repo.groupMemberIds(h.tdb, group.id)).toEqual([ada.user.id, bob.user.id].sort());
    expect(await repo.removeGroupMembers(h.tdb, group.id, [bob.user.id, 'nobody'])).toEqual([bob.user.id]);
    await repo.updateScimGroup(h.tdb, group.id, { displayName: 'Quality', externalId: 'g-2' }, h.clock.now);
    expect(await repo.scimGroupById(h.tdb, group.id)).toMatchObject({
      displayName: 'Quality',
      externalId: 'g-2',
      teamId: null,
    });
    expect((await repo.listScimGroups(h.tdb)).map((g) => [g.displayName, g.memberCount])).toEqual([['Quality', 1]]);
    await h.tdb.query('delete from users where id = $1', [ada.user.id]);
    expect(await repo.groupMemberIds(h.tdb, group.id)).toEqual([]);
    await repo.deleteScimGroup(h.tdb, group.id);
    expect(await repo.scimGroupById(h.tdb, group.id)).toBeUndefined();
  });

  it('a provisioned membership goes with the team membership and with its group, and a deleted team unlinks', async () => {
    const ada = await signedInUser(h, { email: 'ada@example.com' });
    const team = await teams.insertTeam(h.tdb, { id: newId(), name: 'QA', at: h.clock.now });
    const group = await repo.insertScimGroup(h.tdb, {
      id: newId(),
      displayName: 'QA',
      externalId: null,
      at: h.clock.now,
    });
    const other = await repo.insertScimGroup(h.tdb, {
      id: newId(),
      displayName: 'Ops',
      externalId: null,
      at: h.clock.now,
    });
    await repo.setGroupTeam(h.tdb, group.id, team.id, h.clock.now);
    await repo.setGroupTeam(h.tdb, other.id, team.id, h.clock.now);
    expect((await repo.groupsOfTeam(h.tdb, team.id)).map((g) => g.id).sort()).toEqual([group.id, other.id].sort());
    await teams.insertMember(h.tdb, { teamId: team.id, userId: ada.user.id, role: 'member', at: h.clock.now });
    await repo.insertProvisioned(h.tdb, { teamId: team.id, userId: ada.user.id, groupId: group.id });
    await repo.insertProvisioned(h.tdb, { teamId: team.id, userId: ada.user.id, groupId: other.id });
    await repo.insertProvisioned(h.tdb, { teamId: team.id, userId: ada.user.id, groupId: other.id });
    expect(await repo.countProvisioned(h.tdb, team.id, ada.user.id)).toBe(2);
    await repo.deleteProvisioned(h.tdb, { teamId: team.id, userId: ada.user.id, groupId: other.id });
    expect(await repo.countProvisioned(h.tdb, team.id, ada.user.id)).toBe(1);
    await repo.deleteScimGroup(h.tdb, other.id);
    await teams.deleteMember(h.tdb, team.id, ada.user.id);
    expect(await repo.countProvisioned(h.tdb, team.id, ada.user.id)).toBe(0);
    await teams.deleteTeam(h.tdb, team.id);
    expect((await repo.scimGroupById(h.tdb, group.id))?.teamId).toBeNull();
  });

  it('the audit log accepts the scim actor', async () => {
    await h.tdb.query(
      "insert into audit_events (id, actor_kind, actor_token_id, action, target_kind) values ($1, 'scim', 't', 'user.created', 'user')",
      [newId()],
    );
    await expect(
      h.tdb.query(
        "insert into audit_events (id, actor_kind, action, target_kind) values ($1, 'robot', 'user.created', 'user')",
        [newId()],
      ),
    ).rejects.toThrow();
  });
});
