/**
 * Group membership changes (saml-scim spec §3.5, §3.6). Every change to a group's members, from any SCIM
 * route, goes through {@link setGroupMembers}, so the team side of a linked group follows from one place.
 */
import type { Querier } from '../context.js';
import * as repo from './repo.js';

export interface MemberDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/** Adds and removes `groupId`'s members; answers who actually changed. */
export async function setGroupMembers(
  tx: Querier,
  groupId: string,
  added: readonly string[],
  removed: readonly string[],
): Promise<MemberDelta> {
  return {
    added: await repo.addGroupMembers(tx, groupId, added),
    removed: await repo.removeGroupMembers(tx, groupId, removed),
  };
}
