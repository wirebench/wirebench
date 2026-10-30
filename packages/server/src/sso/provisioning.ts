/**
 * Group membership and the teams it reaches (saml-scim spec §3.5, §3.6). Every change to a group's members,
 * from any SCIM route, goes through {@link setGroupMembers}, and every link through {@link linkGroup} /
 * {@link unlinkGroup}, so a linked team follows from one place.
 *
 * SCIM only ever touches what it added: a join it makes is recorded per (team, user, group), a person an
 * admin added is left alone, and a provisioned person leaves the team only when no linked group still
 * holds them and their role is still `member`.
 *
 * Each runs in the caller's tenant unit, since identity's repository takes one (tenancy Task 8; the rest of
 * this module moves in Task 15).
 */
import type { TeamRole } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import { announce, recordAudit, type AuditSource, type ServerContext } from '../context.js';
import * as identityRepo from '../identity/repo.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import * as teamsRepo from '../teams/repo.js';
import * as repo from './repo.js';

export interface ProvisioningEnv {
  readonly ctx: Pick<ServerContext, 'db' | 'tenancy' | 'hooks'>;
  readonly now: () => Date;
}

export interface MemberDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/** Whose team access changed, to announce once the transaction has committed. */
export type AccessChanges = { teamId: string; userId: string }[];

/** `scope` is the tenant the changes were made in. */
export function announceAccess(
  env: ProvisioningEnv,
  scope: TenantScope,
  changes: AccessChanges,
  log: FastifyBaseLogger,
): void {
  for (const change of changes)
    announce(env.ctx.hooks.accessChanged, { ...change, tenantId: scope.tenantId, tenant: scope }, log);
}

/** Plan ruling 8: a provisioned person leaves only when nothing provisions them and nobody promoted them. */
export function decideProvisionedRemoval(input: {
  readonly remainingRowsForTeam: number;
  readonly role: TeamRole;
}): 'remove' | 'keep' {
  return input.remainingRowsForTeam === 0 && input.role === 'member' ? 'remove' : 'keep';
}

async function joinTeam(
  env: ProvisioningEnv,
  tx: TenantQuerier,
  key: { readonly teamId: string; readonly groupId: string; readonly userId: string },
  source: AuditSource,
  changes: AccessChanges,
): Promise<void> {
  const user = await identityRepo.findUserById(tx, key.userId);
  if (user === undefined || user.disabledAt !== null) return; // §3.6: enabled members only
  if (await teamsRepo.insertMember(tx, { teamId: key.teamId, userId: key.userId, role: 'member', at: env.now() })) {
    await repo.insertProvisioned(tx, key);
    await recordAudit(env.ctx.hooks, tx, {
      ...source,
      action: 'team.member_added',
      target: { kind: 'user', id: key.userId },
      teamId: key.teamId,
      details: { role: 'member', via: 'scim', groupId: key.groupId },
    });
    changes.push({ teamId: key.teamId, userId: key.userId });
    return;
  }
  // Already on the team. Provisioned through another group: this group holds them too, so losing one
  // group keeps the membership. Added by hand: theirs, never recorded.
  if ((await repo.countProvisioned(tx, key.teamId, key.userId)) > 0) await repo.insertProvisioned(tx, key);
}

async function leaveTeam(
  env: ProvisioningEnv,
  tx: TenantQuerier,
  key: { readonly teamId: string; readonly groupId: string; readonly userId: string },
  source: AuditSource,
  changes: AccessChanges,
): Promise<void> {
  if (!(await repo.deleteProvisioned(tx, key))) return; // this group never added them
  const role = await teamsRepo.memberRole(tx, key.teamId, key.userId);
  if (role === undefined) return;
  const remaining = await repo.countProvisioned(tx, key.teamId, key.userId);
  if (decideProvisionedRemoval({ remainingRowsForTeam: remaining, role }) === 'keep') return;
  // teams-access §6: their access to every team workspace ends with the membership.
  await teamsRepo.deleteGrantsInTeam(tx, key.teamId, key.userId);
  await teamsRepo.deleteMember(tx, key.teamId, key.userId);
  await recordAudit(env.ctx.hooks, tx, {
    ...source,
    action: 'team.member_removed',
    target: { kind: 'user', id: key.userId },
    teamId: key.teamId,
    details: { role, via: 'scim', groupId: key.groupId },
  });
  changes.push({ teamId: key.teamId, userId: key.userId });
}

/** Adds and removes `groupId`'s members, and follows through on its linked team; answers who changed. */
export async function setGroupMembers(
  env: ProvisioningEnv,
  tx: TenantQuerier,
  groupId: string,
  added: readonly string[],
  removed: readonly string[],
  source: AuditSource,
  changes: AccessChanges,
): Promise<MemberDelta> {
  const delta = {
    added: await repo.addGroupMembers(tx, groupId, added),
    removed: await repo.removeGroupMembers(tx, groupId, removed),
  };
  const group = await repo.scimGroupById(tx, groupId);
  const teamId = group?.teamId ?? null;
  if (teamId !== null && (delta.added.length > 0 || delta.removed.length > 0)) {
    await teamsRepo.lockTeam(tx, teamId);
    for (const userId of delta.added) await joinTeam(env, tx, { teamId, groupId, userId }, source, changes);
    for (const userId of delta.removed) await leaveTeam(env, tx, { teamId, groupId, userId }, source, changes);
  }
  return delta;
}

/** Links `groupId` to `teamId` (moving it off any other team) and adds its enabled members. */
export async function linkGroup(
  env: ProvisioningEnv,
  tx: TenantQuerier,
  group: repo.ScimGroupRow,
  teamId: string,
  source: AuditSource,
  changes: AccessChanges,
): Promise<void> {
  if (group.teamId === teamId) return;
  if (group.teamId !== null) await unlinkGroup(env, tx, group, source, changes);
  await teamsRepo.lockTeam(tx, teamId);
  await repo.setGroupTeam(tx, group.id, teamId, env.now());
  for (const userId of await repo.groupMemberIds(tx, group.id))
    await joinTeam(env, tx, { teamId, groupId: group.id, userId }, source, changes);
  await recordAudit(env.ctx.hooks, tx, {
    ...source,
    action: 'scim.group_linked',
    target: { kind: 'scim-group', id: group.id },
    teamId,
    details: { displayName: group.displayName },
  });
}

/** Unlinks `group` from its team; the members this group added leave, those added by hand stay. */
export async function unlinkGroup(
  env: ProvisioningEnv,
  tx: TenantQuerier,
  group: repo.ScimGroupRow,
  source: AuditSource,
  changes: AccessChanges,
): Promise<void> {
  const teamId = group.teamId;
  if (teamId === null) return;
  await teamsRepo.lockTeam(tx, teamId);
  for (const userId of await repo.groupMemberIds(tx, group.id))
    await leaveTeam(env, tx, { teamId, groupId: group.id, userId }, source, changes);
  await repo.setGroupTeam(tx, group.id, null, env.now());
  await recordAudit(env.ctx.hooks, tx, {
    ...source,
    action: 'scim.group_unlinked',
    target: { kind: 'scim-group', id: group.id },
    teamId,
    details: { displayName: group.displayName },
  });
}
