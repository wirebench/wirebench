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
    return repo.insertSamlFlow(h.db, input).then(() => input);
  };

  it('links a SAML identity to its user, and the user going takes the identity with it', async () => {
    const ada = await signedInUser(h, { email: 'ada@example.com' });
    await repo.insertSamlIdentity(h.db, {
      entityId: 'https://idp',
      nameId: 'n-1',
      userId: ada.user.id,
      at: h.clock.now,
    });
    expect(await repo.samlIdentityOf(h.db, 'https://idp', 'n-1')).toEqual({ userId: ada.user.id });
    expect(await repo.samlIdentityOf(h.db, 'https://other', 'n-1')).toBeUndefined();
    await expect(
      repo.insertSamlIdentity(h.db, { entityId: 'https://idp', nameId: 'n-1', userId: ada.user.id, at: h.clock.now }),
    ).rejects.toThrow();
    await h.db.query('delete from users where id = $1', [ada.user.id]);
    expect(await repo.samlIdentityOf(h.db, 'https://idp', 'n-1')).toBeUndefined();
  });

  it('finds a flow by relay state, grants it once, redeems it once, and sweeps it when expired', async () => {
    const ada = await signedInUser(h, { email: 'ada@example.com' });
    const f = await flow();
    expect((await repo.samlFlowByRelayState(h.db, f.relayState))?.requestId).toBe(f.requestId);
    const grant = mintSecret();
    expect(await repo.grantSamlFlow(h.db, f.id, grant.hash, ada.user.id)).toBe(true);
    expect(await repo.grantSamlFlow(h.db, f.id, mintSecret().hash, ada.user.id)).toBe(false);
    expect((await repo.samlFlowById(h.db, f.id))?.userId).toBe(ada.user.id);
    expect(await repo.claimGrantedSamlFlow(h.db, f.id, grant.hash)).toBe(true);
    expect(await repo.claimGrantedSamlFlow(h.db, f.id, grant.hash)).toBe(false);

    const stale = await flow({ expiresAt: new Date(h.clock.now.getTime() - 1) });
    const live = await flow();
    await repo.deleteSamlFlow(h.db, live.id);
    expect(await repo.samlFlowById(h.db, live.id)).toBeUndefined();
    const kept = await flow();
    expect(await repo.deleteExpiredSamlFlows(h.db, h.clock.now)).toBe(1);
    expect(await repo.samlFlowById(h.db, stale.id)).toBeUndefined();
    expect(await repo.samlFlowById(h.db, kept.id)).toBeDefined();
  });

  it('the daily sweep clears expired SAML flows', async () => {
    const stale = await flow({ expiresAt: new Date(h.clock.now.getTime() - 1) });
    await sweepSso(h.db, h.clock.now);
    expect(await repo.samlFlowById(h.db, stale.id)).toBeUndefined();
  });

  it('keeps SCIM tokens by hash, unique by name among live ones, and touches and revokes them', async () => {
    const admin = await signedInUser(h, { email: 'admin@example.com', serverAdmin: true });
    const first = mintSecret();
    const token = await repo.insertScimToken(h.db, {
      id: newId(),
      name: 'Entra',
      tokenHash: first.hash,
      createdBy: admin.user.id,
      at: h.clock.now,
    });
    expect(token).toMatchObject({ name: 'Entra', lastUsedAt: null, revokedAt: null });
    expect((await repo.scimTokenByHash(h.db, first.hash))?.id).toBe(token.id);
    await expect(
      repo.insertScimToken(h.db, {
        id: newId(),
        name: 'entra',
        tokenHash: mintSecret().hash,
        createdBy: null,
        at: h.clock.now,
      }),
    ).rejects.toThrow();
    await repo.touchScimToken(h.db, token.id, new Date(h.clock.now.getTime() + 1000));
    expect((await repo.listScimTokens(h.db))[0]?.lastUsedAt).toBe('2026-09-24T12:00:01.000Z');
    expect(await repo.revokeScimToken(h.db, token.id, h.clock.now)).toBe(true);
    expect(await repo.revokeScimToken(h.db, token.id, h.clock.now)).toBe(false);
    expect(await repo.listScimTokens(h.db)).toEqual([]);
    expect((await repo.scimTokenByHash(h.db, first.hash))?.revokedAt).not.toBeNull();
    await repo.insertScimToken(h.db, {
      id: newId(),
      name: 'Entra',
      tokenHash: mintSecret().hash,
      createdBy: null,
      at: h.clock.now,
    });
  });

  it('records a user’s external id', async () => {
    const ada = await signedInUser(h, { email: 'ada@example.com' });
    expect(await repo.scimUserOf(h.db, ada.user.id)).toBeUndefined();
    await repo.upsertScimUser(h.db, ada.user.id, 'ext-1', h.clock.now);
    await repo.upsertScimUser(h.db, ada.user.id, 'ext-2', h.clock.now);
    expect(await repo.scimUserOf(h.db, ada.user.id)).toEqual({ externalId: 'ext-2' });
    await repo.upsertScimUser(h.db, ada.user.id, null, h.clock.now);
    expect(await repo.scimUserOf(h.db, ada.user.id)).toEqual({ externalId: null });
  });

  it('stores groups, unique by name in any case, with their members', async () => {
    const ada = await signedInUser(h, { email: 'ada@example.com' });
    const bob = await signedInUser(h, { email: 'bob@example.com' });
    const group = await repo.insertScimGroup(h.db, {
      id: newId(),
      displayName: 'QA',
      externalId: 'g-1',
      at: h.clock.now,
    });
    await expect(
      repo.insertScimGroup(h.db, { id: newId(), displayName: 'qa', externalId: null, at: h.clock.now }),
    ).rejects.toThrow();
    expect(await repo.addGroupMembers(h.db, group.id, [ada.user.id, bob.user.id])).toEqual(
      [ada.user.id, bob.user.id].sort(),
    );
    expect(await repo.addGroupMembers(h.db, group.id, [ada.user.id])).toEqual([]);
    expect(await repo.groupMemberIds(h.db, group.id)).toEqual([ada.user.id, bob.user.id].sort());
    expect(await repo.removeGroupMembers(h.db, group.id, [bob.user.id, 'nobody'])).toEqual([bob.user.id]);
    await repo.updateScimGroup(h.db, group.id, { displayName: 'Quality', externalId: 'g-2' }, h.clock.now);
    expect(await repo.scimGroupById(h.db, group.id)).toMatchObject({
      displayName: 'Quality',
      externalId: 'g-2',
      teamId: null,
    });
    expect((await repo.listScimGroups(h.db)).map((g) => [g.displayName, g.memberCount])).toEqual([['Quality', 1]]);
    await h.db.query('delete from users where id = $1', [ada.user.id]);
    expect(await repo.groupMemberIds(h.db, group.id)).toEqual([]);
    await repo.deleteScimGroup(h.db, group.id);
    expect(await repo.scimGroupById(h.db, group.id)).toBeUndefined();
  });

  it('a provisioned membership goes with the team membership and with its group, and a deleted team unlinks', async () => {
    const ada = await signedInUser(h, { email: 'ada@example.com' });
    const team = await teams.insertTeam(h.db, { id: newId(), name: 'QA', at: h.clock.now });
    const group = await repo.insertScimGroup(h.db, {
      id: newId(),
      displayName: 'QA',
      externalId: null,
      at: h.clock.now,
    });
    const other = await repo.insertScimGroup(h.db, {
      id: newId(),
      displayName: 'Ops',
      externalId: null,
      at: h.clock.now,
    });
    await repo.setGroupTeam(h.db, group.id, team.id, h.clock.now);
    await repo.setGroupTeam(h.db, other.id, team.id, h.clock.now);
    expect((await repo.groupsOfTeam(h.db, team.id)).map((g) => g.id).sort()).toEqual([group.id, other.id].sort());
    await teams.insertMember(h.db, { teamId: team.id, userId: ada.user.id, role: 'member', at: h.clock.now });
    await repo.insertProvisioned(h.db, { teamId: team.id, userId: ada.user.id, groupId: group.id });
    await repo.insertProvisioned(h.db, { teamId: team.id, userId: ada.user.id, groupId: other.id });
    await repo.insertProvisioned(h.db, { teamId: team.id, userId: ada.user.id, groupId: other.id });
    expect(await repo.countProvisioned(h.db, team.id, ada.user.id)).toBe(2);
    await repo.deleteProvisioned(h.db, { teamId: team.id, userId: ada.user.id, groupId: other.id });
    expect(await repo.countProvisioned(h.db, team.id, ada.user.id)).toBe(1);
    await repo.deleteScimGroup(h.db, other.id);
    await teams.deleteMember(h.db, team.id, ada.user.id);
    expect(await repo.countProvisioned(h.db, team.id, ada.user.id)).toBe(0);
    await teams.deleteTeam(h.db, team.id);
    expect((await repo.scimGroupById(h.db, group.id))?.teamId).toBeNull();
  });

  it('the audit log accepts the scim actor', async () => {
    await h.db.query(
      "insert into audit_events (id, actor_kind, actor_token_id, action, target_kind) values ($1, 'scim', 't', 'user.created', 'user')",
      [newId()],
    );
    await expect(
      h.db.query(
        "insert into audit_events (id, actor_kind, action, target_kind) values ($1, 'robot', 'user.created', 'user')",
        [newId()],
      ),
    ).rejects.toThrow();
  });
});
