/**
 * The `team.*` channels (teams-access spec §3.5, §5.2). Each resolves the account's token for
 * `url`, calls the server through `ServerClient`, and answers in the renderer's wire shapes. A
 * server that answers `identity-unauthenticated` marks the account signed out, the rule
 * `AccountService.refresh` applies at launch; the token never crosses the bridge.
 */
import { channels } from '../../shared/ipc.js';
import type { ServerClient } from '../server-client.js';
import { withToken as withTokenUnguarded, type TokenSource } from '../server-token.js';
import { registerHandler, type HandlerTable } from './register.js';

export interface TeamChannelDeps {
  /** Refuses every call when `server-sync` is off (phase 4 spec §7); absent, nothing is refused. */
  readonly requireFeature?: (feature: string) => void;
  readonly client: Pick<
    ServerClient,
    | 'me'
    | 'meta'
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

/** `GET /meta` lists it when the server stores the workspace `recordDesktopActivity` setting. */
const DESKTOP_ACTIVITY_CAPABILITY = 'desktop-activity';
/** `GET /meta` lists it when the server stores team SSH session logs and their workspace switch (#430). */
const SESSION_LOGS_CAPABILITY = 'session-logs';
/** `GET /meta` lists it when the server stores a workspace feature policy (phase 4 spec §6.1). */
const FEATURE_POLICY_CAPABILITY = 'feature-policy';

const DONE = { done: true } as const;

/** `withToken`, after the feature guard: a server call is a `server-sync` use. */
const withToken: typeof withTokenUnguarded = (deps, url, fn) => {
  (deps as TeamChannelDeps).requireFeature?.('server-sync');
  return withTokenUnguarded(deps, url, fn);
};

export function registerTeamChannels(table: HandlerTable, deps: TeamChannelDeps): void {
  const c = deps.client;

  registerHandler(table, channels.team.list, (r) =>
    withToken(deps, r.url, async (url, token) => {
      const [teams, me, meta] = await Promise.all([
        c.listTeams(url, token),
        c.me(url, token),
        c.meta(url).catch(() => undefined),
      ]);
      return {
        teams,
        serverAdmin: me.user.serverAdmin,
        desktopActivity: meta?.capabilities.includes(DESKTOP_ACTIVITY_CAPABILITY) === true,
        sessionLogs: meta?.capabilities.includes(SESSION_LOGS_CAPABILITY) === true,
        featurePolicy: meta?.capabilities.includes(FEATURE_POLICY_CAPABILITY) === true,
      };
    }),
  );
  registerHandler(table, channels.team.create, (r) =>
    withToken(deps, r.url, async (url, token) => ({ team: await c.createTeam(url, token, r.name) })),
  );
  registerHandler(table, channels.team.rename, (r) =>
    withToken(deps, r.url, async (url, token) => ({ team: await c.renameTeam(url, token, r.teamId, r.name) })),
  );
  registerHandler(table, channels.team.delete, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.deleteTeam(url, token, r.teamId);
      return DONE;
    }),
  );
  registerHandler(table, channels.team.members, (r) =>
    withToken(deps, r.url, async (url, token) => ({ members: await c.listMembers(url, token, r.teamId) })),
  );
  registerHandler(table, channels.team.addMember, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      member: await c.addMember(url, token, r.teamId, { email: r.email, role: r.role }),
    })),
  );
  registerHandler(table, channels.team.setMemberRole, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      member: await c.setMemberRole(url, token, r.teamId, r.userId, r.role),
    })),
  );
  registerHandler(table, channels.team.removeMember, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.removeMember(url, token, r.teamId, r.userId);
      return DONE;
    }),
  );
  registerHandler(table, channels.team.invitations, (r) =>
    withToken(deps, r.url, async (url, token) => ({ invitations: await c.listTeamInvitations(url, token, r.teamId) })),
  );
  registerHandler(table, channels.team.invite, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      invitation: await c.inviteToTeam(url, token, r.teamId, { email: r.email, role: r.role }),
    })),
  );
  registerHandler(table, channels.team.revokeInvitation, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.revokeTeamInvitation(url, token, r.teamId, r.invitationId);
      return DONE;
    }),
  );
  registerHandler(table, channels.team.listWorkspaces, (r) =>
    withToken(deps, r.url, async (url, token) => ({ workspaces: await c.listWorkspaces(url, token) })),
  );
  registerHandler(table, channels.team.createWorkspace, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      workspace: await c.createWorkspace(url, token, r.teamId, {
        name: r.name,
        ...(r.defaultRole !== undefined ? { defaultRole: r.defaultRole } : {}),
      }),
    })),
  );
  registerHandler(table, channels.team.updateWorkspace, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      workspace: await c.updateWorkspace(url, token, r.workspaceId, {
        ...(r.name !== undefined ? { name: r.name } : {}),
        ...(r.defaultRole !== undefined ? { defaultRole: r.defaultRole } : {}),
        ...(r.recordDesktopActivity !== undefined ? { recordDesktopActivity: r.recordDesktopActivity } : {}),
        ...(r.recordSessionLogs !== undefined ? { recordSessionLogs: r.recordSessionLogs } : {}),
        ...(r.disabledFeatures !== undefined ? { disabledFeatures: r.disabledFeatures } : {}),
      }),
    })),
  );
  registerHandler(table, channels.team.deleteWorkspace, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.deleteWorkspace(url, token, r.workspaceId);
      return DONE;
    }),
  );
  registerHandler(table, channels.team.access, (r) =>
    withToken(deps, r.url, async (url, token) => ({ entries: await c.workspaceAccess(url, token, r.workspaceId) })),
  );
  registerHandler(table, channels.team.setAccess, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.setAccess(url, token, r.workspaceId, r.userId, r.role);
      return DONE;
    }),
  );
  registerHandler(table, channels.team.clearAccess, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.clearAccess(url, token, r.workspaceId, r.userId);
      return DONE;
    }),
  );
}
