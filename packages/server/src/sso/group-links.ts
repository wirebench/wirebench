/**
 * Group → team links (saml-scim spec §3.6), shared by `/api/v1/scim-groups` and `admin scim-group …`: the
 * list with member counts, and link / unlink through `provisioning.ts` in one transaction each.
 */
import type { ScimGroupSummary } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditSource } from '../context.js';
import { problem } from '../problem.js';
import * as teamsRepo from '../teams/repo.js';
import { teamNotFound } from '../teams/errors.js';
import { announceAccess, linkGroup, unlinkGroup, type AccessChanges, type ProvisioningEnv } from './provisioning.js';
import * as repo from './repo.js';

export const scimGroupNotFound = () => problem('sso-scim-group-not-found', 'That SCIM group was not found.', 404);

export function groupSummary(row: repo.ScimGroupListRow): ScimGroupSummary {
  return {
    id: row.id,
    displayName: row.displayName,
    memberCount: row.memberCount,
    team: row.teamId !== null && row.teamName !== null ? { id: row.teamId, name: row.teamName } : null,
  };
}

export async function listGroupSummaries(env: ProvisioningEnv): Promise<ScimGroupSummary[]> {
  return (await repo.listScimGroups(env.ctx.db)).map(groupSummary);
}

async function summaryOf(env: ProvisioningEnv, groupId: string): Promise<ScimGroupSummary> {
  const row = (await repo.listScimGroups(env.ctx.db)).find((group) => group.id === groupId);
  if (row === undefined) throw scimGroupNotFound();
  return groupSummary(row);
}

/** Links `groupId` to `teamId`, or unlinks it with `null`; access changes are announced after commit. */
export async function setGroupLink(
  env: ProvisioningEnv,
  groupId: string,
  teamId: string | null,
  source: AuditSource,
  /** The request's logger; the CLI has no live sockets to tell. */
  log?: FastifyBaseLogger,
): Promise<ScimGroupSummary> {
  const changes: AccessChanges = [];
  await env.ctx.db.transaction(async (tx) => {
    const group = await repo.scimGroupById(tx, groupId);
    if (group === undefined) throw scimGroupNotFound();
    if (teamId === null) {
      await unlinkGroup(env, tx, group, source, changes);
      return;
    }
    if ((await teamsRepo.teamById(tx, teamId)) === undefined) throw teamNotFound();
    await linkGroup(env, tx, group, teamId, source, changes);
  });
  if (log !== undefined) announceAccess(env, changes, log);
  return summaryOf(env, groupId);
}
