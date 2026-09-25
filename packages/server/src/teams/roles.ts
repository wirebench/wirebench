/**
 * Who may do what in a workspace (teams-access spec §3.1, §3.3). `resolveRole` is the whole rule,
 * pure and table-tested; `effectiveRole` feeds it one query; the guards turn its answer into a
 * `404` (none) or a `403` (too low) before a handler runs. Every route and `server-sync` decide
 * through here and nowhere else.
 */
import type { DefaultRole, RoleSource, TeamRole, WorkspaceRole } from '@wirebench/engine';
import type { preHandlerAsyncHookHandler } from 'fastify';
import type { Querier } from '../context.js';
import { unauthenticated } from '../identity/errors.js';
import { forbidden, teamNotFound, workspaceNotFound } from './errors.js';
import * as repo from './repo.js';

export type Effective = { readonly role: WorkspaceRole; readonly source: RoleSource } | { readonly role: 'none' };

export interface RoleFacts {
  readonly disabled: boolean;
  readonly serverAdmin: boolean;
  /** The user's role on the workspace's team; `undefined` when they are not on it. */
  readonly teamRole: TeamRole | undefined;
  readonly grant: WorkspaceRole | undefined;
  readonly defaultRole: DefaultRole;
}

/**
 * §3.1, first match wins. A grant counts only for a team member: removal from the team deletes
 * grants in the same transaction, and this check keeps a stray row from ever granting access.
 */
export function resolveRole(facts: RoleFacts): Effective {
  if (facts.disabled) return { role: 'none' };
  if (facts.serverAdmin) return { role: 'admin', source: 'server-admin' };
  if (facts.teamRole === 'admin') return { role: 'admin', source: 'team-admin' };
  if (facts.teamRole === undefined) return { role: 'none' };
  if (facts.grant !== undefined) return { role: facts.grant, source: 'grant' };
  return facts.defaultRole === 'none' ? { role: 'none' } : { role: facts.defaultRole, source: 'default' };
}

/** A query row (`null` for a missing join) as `resolveRole` facts. */
export function factsOf(row: {
  readonly disabled: boolean;
  readonly serverAdmin: boolean;
  readonly teamRole: TeamRole | null;
  readonly grant: WorkspaceRole | null;
  readonly defaultRole: DefaultRole;
}): RoleFacts {
  return {
    disabled: row.disabled,
    serverAdmin: row.serverAdmin,
    teamRole: row.teamRole ?? undefined,
    grant: row.grant ?? undefined,
    defaultRole: row.defaultRole,
  };
}

const RANK: Readonly<Record<WorkspaceRole, number>> = { viewer: 1, editor: 2, admin: 3 };

export function atLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return RANK[role] >= RANK[min];
}

type Capability = 'pull' | 'send' | 'push' | 'manage' | 'delete';

/** §3.1's capability table as data: what `server-sync` and the app enforce per role. */
export const CAPABILITIES = {
  viewer: { pull: true, send: true, push: false, manage: false, delete: false },
  editor: { pull: true, send: true, push: true, manage: false, delete: false },
  admin: { pull: true, send: true, push: true, manage: true, delete: true },
} as const satisfies Readonly<Record<WorkspaceRole, Readonly<Record<Capability, boolean>>>>;

export async function effectiveRole(db: Querier, userId: string, workspaceId: string): Promise<Effective> {
  const row = await repo.workspaceFacts(db, userId, workspaceId);
  return row === undefined ? { role: 'none' } : resolveRole(factsOf(row));
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by {@link requireWorkspaceRole}: what the caller may do in `:workspaceId`, and why. */
    workspaceAccess?: { readonly workspaceId: string; readonly role: WorkspaceRole; readonly source: RoleSource };
    /** Set by {@link requireTeamRole}: the caller's role on `:teamId` (a server admin counts as admin). */
    teamAccess?: { readonly teamId: string; readonly role: TeamRole };
  }
}

/**
 * `preHandler` for routes with a `:workspaceId` param. `none` → `404 teams-workspace-not-found`
 * (an id reveals nothing, §3.1); below `min` → `403 teams-forbidden`. Fastify has validated the
 * param as a ULID before this runs.
 */
export function requireWorkspaceRole(db: Querier, min: WorkspaceRole): preHandlerAsyncHookHandler {
  return async (request) => {
    const caller = request.caller;
    if (caller === undefined) throw unauthenticated();
    const { workspaceId } = request.params as { readonly workspaceId: string };
    const found = await effectiveRole(db, caller.id, workspaceId);
    if (found.role === 'none') throw workspaceNotFound();
    if (!atLeast(found.role, min)) throw forbidden();
    request.workspaceAccess = { workspaceId, role: found.role, source: found.source };
  };
}

/**
 * `preHandler` for routes with a `:teamId` param. Not on the team (and not a server admin) →
 * `404 teams-team-not-found`; a member where an admin is needed → `403 teams-forbidden`.
 */
export function requireTeamRole(db: Querier, min: TeamRole): preHandlerAsyncHookHandler {
  return async (request) => {
    const caller = request.caller;
    if (caller === undefined) throw unauthenticated();
    const { teamId } = request.params as { readonly teamId: string };
    if ((await repo.teamById(db, teamId)) === undefined) throw teamNotFound();
    const role = caller.serverAdmin ? 'admin' : await repo.memberRole(db, teamId, caller.id);
    if (role === undefined) throw teamNotFound();
    if (min === 'admin' && role !== 'admin') throw forbidden();
    request.teamAccess = { teamId, role };
  };
}
