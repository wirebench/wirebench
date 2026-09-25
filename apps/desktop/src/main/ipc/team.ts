/**
 * The `team.*` channels (teams-access spec §3.5, §5.2). Each resolves the account's token for
 * `url`, calls the server through `ServerClient`, and answers in the renderer's wire shapes. A
 * server that answers `identity-unauthenticated` marks the account signed out, the rule
 * `AccountService.refresh` applies at launch; the token never crosses the bridge.
 */
import { channels } from '../../shared/ipc.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import { registerHandler } from './register.js';

export interface TeamChannelDeps {
  readonly client: Pick<
    ServerClient,
    | 'me'
    | 'listTeams'
    | 'createTeam'
    | 'renameTeam'
    | 'deleteTeam'
    | 'listMembers'
    | 'addMember'
    | 'setMemberRole'
    | 'removeMember'
    | 'listTeamInvitations'
    | 'inviteToTeam'
    | 'revokeTeamInvitation'
    | 'listWorkspaces'
    | 'createWorkspace'
    | 'updateWorkspace'
    | 'deleteWorkspace'
    | 'workspaceAccess'
    | 'setAccess'
    | 'clearAccess'
  >;
  readonly accounts: TokenSource;
}

const DONE = { done: true } as const;

export function registerTeamChannels(deps: TeamChannelDeps): void {
  const c = deps.client;

  registerHandler(channels.team.list, (r) =>
    withToken(deps, r.url, async (url, token) => {
      const [teams, me] = await Promise.all([c.listTeams(url, token), c.me(url, token)]);
      return { teams, serverAdmin: me.user.serverAdmin };
    }),
  );
  registerHandler(channels.team.create, (r) =>
    withToken(deps, r.url, async (url, token) => ({ team: await c.createTeam(url, token, r.name) })),
  );
  registerHandler(channels.team.rename, (r) =>
    withToken(deps, r.url, async (url, token) => ({ team: await c.renameTeam(url, token, r.teamId, r.name) })),
  );
  registerHandler(channels.team.delete, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.deleteTeam(url, token, r.teamId);
      return DONE;
    }),
  );
  registerHandler(channels.team.members, (r) =>
    withToken(deps, r.url, async (url, token) => ({ members: await c.listMembers(url, token, r.teamId) })),
  );
  registerHandler(channels.team.addMember, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      member: await c.addMember(url, token, r.teamId, { email: r.email, role: r.role }),
    })),
  );
  registerHandler(channels.team.setMemberRole, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      member: await c.setMemberRole(url, token, r.teamId, r.userId, r.role),
    })),
  );
  registerHandler(channels.team.removeMember, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.removeMember(url, token, r.teamId, r.userId);
      return DONE;
    }),
  );
  registerHandler(channels.team.invitations, (r) =>
    withToken(deps, r.url, async (url, token) => ({ invitations: await c.listTeamInvitations(url, token, r.teamId) })),
  );
  registerHandler(channels.team.invite, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      invitation: await c.inviteToTeam(url, token, r.teamId, { email: r.email, role: r.role }),
    })),
  );
  registerHandler(channels.team.revokeInvitation, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.revokeTeamInvitation(url, token, r.teamId, r.invitationId);
      return DONE;
    }),
  );
  registerHandler(channels.team.listWorkspaces, (r) =>
    withToken(deps, r.url, async (url, token) => ({ workspaces: await c.listWorkspaces(url, token) })),
  );
  registerHandler(channels.team.createWorkspace, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      workspace: await c.createWorkspace(url, token, r.teamId, {
        name: r.name,
        ...(r.defaultRole !== undefined ? { defaultRole: r.defaultRole } : {}),
      }),
    })),
  );
  registerHandler(channels.team.updateWorkspace, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      workspace: await c.updateWorkspace(url, token, r.workspaceId, {
        ...(r.name !== undefined ? { name: r.name } : {}),
        ...(r.defaultRole !== undefined ? { defaultRole: r.defaultRole } : {}),
      }),
    })),
  );
  registerHandler(channels.team.deleteWorkspace, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.deleteWorkspace(url, token, r.workspaceId);
      return DONE;
    }),
  );
  registerHandler(channels.team.access, (r) =>
    withToken(deps, r.url, async (url, token) => ({ entries: await c.workspaceAccess(url, token, r.workspaceId) })),
  );
  registerHandler(channels.team.setAccess, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.setAccess(url, token, r.workspaceId, r.userId, r.role);
      return DONE;
    }),
  );
  registerHandler(channels.team.clearAccess, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.clearAccess(url, token, r.workspaceId, r.userId);
      return DONE;
    }),
  );
}
