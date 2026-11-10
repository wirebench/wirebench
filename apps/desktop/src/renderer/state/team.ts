/**
 * The teams dialog's state (teams-access §3.5): one server's teams, the selected team's members and
 * invitations, and every workspace the caller can see on that server. Nothing here is persisted; the
 * dialog reloads each time it opens. Failures toast, except a signed-out answer, which flips
 * `signedOut` so the dialog can offer *Sign in again*.
 */
import { create } from 'zustand';
import type { IpcResult } from '@shared/ipc.js';
import type {
  AccessEntryWire,
  DefaultRoleWire,
  TeamInvitationCreatedWire,
  TeamInvitationWire,
  TeamMemberWire,
  TeamRoleWire,
  TeamWire,
  TeamWorkspaceWire,
  WorkspaceRoleWire,
} from '@shared/wire-base.js';
import { showToast } from '../components/toast.js';
import { activeTeamIdOn, useActiveTeamStore } from './active-team.js';
import { ipc } from './ipc-client.js';
import { useWorkspaceStore } from './workspace.js';
import { DEFAULT_TEAM_PAGE, resolveTeamPage, type TeamSettingsPageId } from '../features/team/team-settings-model.js';
import type { TeamSettingsTarget } from './ui.js';

/** The fallback dialog's tabs; the dialog keeps which one is open itself. */
export type TeamTab = 'members' | 'workspaces' | 'invitations' | 'license' | 'audit' | 'provisioning' | 'domain';

export interface TeamState {
  readonly url: string | undefined;
  readonly serverAdmin: boolean;
  /** The server stores the desktop-recording setting; without it the switch is hidden. */
  readonly desktopActivity: boolean;
  /** The server stores team SSH session logs (#430); without it the Record SSH sessions switch is hidden. */
  readonly sessionLogs: boolean;
  /** The server stores a workspace feature policy (phase 4 spec §6.1); the Workspaces tab offers Features. */
  readonly featurePolicy: boolean;
  readonly teams: readonly TeamWire[];
  readonly teamId: string | undefined;
  /** Team settings' page; `undefined` before the first load, and for a caller with no team and no page asked. */
  readonly page: TeamSettingsPageId | undefined;
  /** The workspace the Workspace overview page (`page: 'workspace'`) shows. */
  readonly workspaceId: string | undefined;
  readonly members: readonly TeamMemberWire[];
  readonly invitations: readonly TeamInvitationWire[];
  /** Every workspace the caller can open on `url`, across teams; {@link teamWorkspaces} narrows it. */
  readonly workspaces: readonly TeamWorkspaceWire[];
  /** The access panel's workspace and its entries, while the panel is open. */
  readonly access: { readonly workspaceId: string; readonly entries: readonly AccessEntryWire[] } | undefined;
  /** The invitation just created: the only time its link is shown. */
  readonly lastInvite: TeamInvitationCreatedWire | undefined;
  readonly loading: boolean;
  readonly signedOut: boolean;
  /** A refusal of a row's last change or removal, by user id; shown on that row instead of a toast. */
  readonly rowErrors: Readonly<Record<string, string>>;
}

/** What *Add people* did: added an account, invited an email with no account, or was refused. */
export type AddPersonResult =
  | { readonly kind: 'member' }
  | { readonly kind: 'invited'; readonly invitation: TeamInvitationCreatedWire }
  | { readonly kind: 'failed'; readonly message: string };

export interface TeamStore extends TeamState {
  /** Loads `url`'s teams; `target` picks the team on this first load (team management in the browser §2.2). */
  readonly open: (url: string, target?: TeamSettingsTarget) => Promise<void>;
  readonly reset: () => void;
  readonly refresh: () => Promise<void>;
  readonly selectTeam: (teamId: string) => Promise<void>;
  readonly setPage: (page: TeamSettingsPageId) => void;
  /** Shows one workspace's overview page. */
  readonly openWorkspacePage: (workspaceId: string) => void;
  readonly createTeam: (name: string) => Promise<boolean>;
  readonly renameTeam: (name: string) => Promise<boolean>;
  readonly deleteTeam: () => Promise<boolean>;
  readonly addMember: (email: string, role: TeamRoleWire) => Promise<boolean>;
  readonly setMemberRole: (userId: string, role: TeamRoleWire) => Promise<boolean>;
  readonly removeMember: (userId: string) => Promise<boolean>;
  /** Adds an account as a member, or invites the email when no account has it (spec §3.3). */
  readonly addPerson: (email: string, role: TeamRoleWire) => Promise<AddPersonResult>;
  /** A new link for an open invitation; the old one stops working. Sets `lastInvite` to it. */
  readonly renewInvitation: (invitationId: string) => Promise<boolean>;
  readonly invite: (email: string, role: TeamRoleWire) => Promise<boolean>;
  readonly clearLastInvite: () => void;
  readonly revokeInvitation: (invitationId: string) => Promise<boolean>;
  readonly createWorkspace: (name: string, defaultRole?: DefaultRoleWire) => Promise<boolean>;
  readonly updateWorkspace: (
    workspaceId: string,
    patch: {
      readonly name?: string;
      readonly defaultRole?: DefaultRoleWire;
      readonly recordDesktopActivity?: boolean;
      readonly recordSessionLogs?: boolean;
      readonly disabledFeatures?: string[];
    },
  ) => Promise<boolean>;
  readonly deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  readonly openAccess: (workspaceId: string) => Promise<void>;
  readonly closeAccess: () => void;
  readonly setAccess: (userId: string, role: WorkspaceRoleWire) => Promise<boolean>;
  readonly clearAccess: (userId: string) => Promise<boolean>;
}

const INITIAL: TeamState = {
  url: undefined,
  serverAdmin: false,
  desktopActivity: false,
  sessionLogs: false,
  featurePolicy: false,
  teams: [],
  teamId: undefined,
  page: undefined,
  workspaceId: undefined,
  members: [],
  invitations: [],
  workspaces: [],
  access: undefined,
  lastInvite: undefined,
  loading: false,
  signedOut: false,
  rowErrors: {},
};

const SIGNED_OUT = new Set(['identity-unauthenticated', 'account-signed-out']);

export function selectedTeam(state: TeamState): TeamWire | undefined {
  return state.teams.find((team) => team.id === state.teamId);
}

export function teamWorkspaces(state: TeamState): readonly TeamWorkspaceWire[] {
  return state.workspaces.filter((workspace) => workspace.teamId === state.teamId);
}

/**
 * The page to show for what this store knows: the team and the caller's roles. Whether the server's settings and
 * domain reads answered is the page's to add, so here they are assumed (a Server page the address names is kept
 * until those reads say otherwise). With no team and no page asked, there is none: the empty state.
 */
function settledPage(state: TeamState, page: TeamSettingsPageId | undefined): TeamSettingsPageId | undefined {
  const hasTeam = selectedTeam(state) !== undefined;
  if (!hasTeam && page === undefined) return undefined;
  return resolveTeamPage(page, {
    hasTeam,
    teamAdmin: selectedTeam(state)?.myRole === 'admin',
    serverAdmin: state.serverAdmin,
    settingsAvailable: true,
    hosted: true,
    domain: true,
  });
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a === b;
  }
}

/**
 * After a change in Team settings, the title bar's teams and workspaces and the workspace list reload, so a
 * workspace renamed, added or deleted shows there at once. Only when `url` is the active account's server: the
 * title bar shows no other.
 */
async function refreshTitleBar(url: string): Promise<void> {
  const active = useActiveTeamStore.getState();
  if (active.url === undefined || active.userId === undefined || !sameOrigin(active.url, url)) return;
  await Promise.all([active.load({ url: active.url, userId: active.userId }), useWorkspaceStore.getState().list()]);
}

export const useTeamStore = create<TeamStore>((set, get) => {
  /** The team `open` was asked to show, until the first load after it has used it. */
  let preferred: TeamSettingsTarget | undefined;

  /** Unwraps an answer; a failure toasts `Could not <what>: …`, or marks the dialog signed out. */
  const run = async <T>(what: string, call: () => Promise<IpcResult<T>>): Promise<T | undefined> => {
    const result = await call();
    if (result.ok) return result.value;
    if (SIGNED_OUT.has(result.error.code)) set({ signedOut: true });
    else showToast(`Could not ${what}: ${result.error.message}`);
    return undefined;
  };

  /** A change: run it against the open server, then reload whatever it may have touched. */
  const write = async <T>(what: string, call: (url: string) => Promise<IpcResult<T>>): Promise<T | undefined> => {
    const url = get().url;
    if (url === undefined) return undefined;
    const value = await run(what, () => call(url));
    if (value !== undefined) {
      await get().refresh();
      await refreshTitleBar(url);
    }
    return value;
  };

  const loadTeam = async (): Promise<void> => {
    const { url, teamId } = get();
    const team = selectedTeam(get());
    if (url === undefined || teamId === undefined || team === undefined) {
      set({ members: [], invitations: [] });
      return;
    }
    const [members, invitations] = await Promise.all([
      run('load the members', () => ipc().team.members({ url, teamId })),
      team.myRole === 'admin'
        ? run('load the invitations', () => ipc().team.invitations({ url, teamId }))
        : Promise.resolve({ invitations: [] }),
    ]);
    if (get().url !== url || get().teamId !== teamId) return;
    set({ members: members?.members ?? [], invitations: invitations?.invitations ?? [] });
  };

  const reloadAccess = async (): Promise<void> => {
    const { url, access } = get();
    if (url === undefined || access === undefined) return;
    const value = await run('load access', () => ipc().team.access({ url, workspaceId: access.workspaceId }));
    if (value !== undefined && get().access?.workspaceId === access.workspaceId) {
      set({ access: { workspaceId: access.workspaceId, entries: value.entries } });
    }
  };

  const withTeam = async (
    what: string,
    call: (url: string, teamId: string) => Promise<IpcResult<unknown>>,
  ): Promise<boolean> => {
    const teamId = get().teamId;
    if (teamId === undefined) return false;
    return (await write(what, (url) => call(url, teamId))) !== undefined;
  };

  /** A refusal *Add people* shows in its dialog; a signed-out one still flips the page. */
  const refused = (error: { readonly code: string; readonly message: string }): AddPersonResult => {
    if (SIGNED_OUT.has(error.code)) set({ signedOut: true });
    return { kind: 'failed', message: error.message };
  };

  /** A change to one member's row: its refusal (`teams-last-admin` among them) stays on that row. */
  const onRow = async (
    userId: string,
    call: (url: string, teamId: string) => Promise<IpcResult<unknown>>,
  ): Promise<boolean> => {
    const { url, teamId } = get();
    if (url === undefined || teamId === undefined) return false;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
    const { [userId]: dropped, ...others } = get().rowErrors;
    set({ rowErrors: others });
    const result = await call(url, teamId);
    if (!result.ok) {
      if (SIGNED_OUT.has(result.error.code)) set({ signedOut: true });
      else set({ rowErrors: { ...get().rowErrors, [userId]: result.error.message } });
      return false;
    }
    await get().refresh();
    return true;
  };

  const withAccess = async (
    what: string,
    call: (url: string, workspaceId: string) => Promise<IpcResult<unknown>>,
  ): Promise<boolean> => {
    const workspaceId = get().access?.workspaceId;
    if (workspaceId === undefined) return false;
    return (await write(what, (url) => call(url, workspaceId))) !== undefined;
  };

  return {
    ...INITIAL,

    open: async (url, target) => {
      set({
        ...INITIAL,
        url,
        loading: true,
        page: target?.page,
        workspaceId: target?.page === 'workspace' ? target.workspaceId : undefined,
      });
      preferred = target;
      await get().refresh();
    },

    reset: () => {
      set(INITIAL);
    },

    refresh: async () => {
      const url = get().url;
      if (url === undefined) return;
      const [list, spaces] = await Promise.all([
        run('load teams', () => ipc().team.list({ url })),
        run('load workspaces', () => ipc().team.listWorkspaces({ url })),
      ]);
      if (get().url !== url) return;
      if (list === undefined) {
        set({ loading: false });
        return;
      }
      // A target is used once, on the first load after `open`: a team id, else the team owning a workspace,
      // else the title bar's active team (an address with no `team=`), before falling back to the first.
      const wanted =
        preferred?.teamId ??
        (preferred?.workspaceId !== undefined
          ? (spaces?.workspaces ?? []).find((workspace) => workspace.id === preferred?.workspaceId)?.teamId
          : activeTeamIdOn(url));
      preferred = undefined;
      const current = get().teamId ?? wanted;
      const teamId = list.teams.some((team) => team.id === current) ? current : list.teams[0]?.id;
      set({
        teams: list.teams,
        serverAdmin: list.serverAdmin,
        desktopActivity: list.desktopActivity === true,
        sessionLogs: list.sessionLogs === true,
        featurePolicy: list.featurePolicy === true,
        workspaces: spaces?.workspaces ?? get().workspaces,
        teamId,
      });
      set({ page: settledPage(get(), get().page) });
      await loadTeam();
      await reloadAccess();
      set({ loading: false });
    },

    selectTeam: async (teamId) => {
      // A team picked lands on its Overview (whichever page was showing).
      set({ teamId, workspaceId: undefined, members: [], invitations: [], access: undefined });
      set({ page: settledPage(get(), DEFAULT_TEAM_PAGE) });
      await loadTeam();
    },

    setPage: (page) => {
      set({ page, access: undefined, ...(page === 'workspace' ? {} : { workspaceId: undefined }) });
    },

    openWorkspacePage: (workspaceId) => {
      set({ page: 'workspace', workspaceId, access: undefined });
    },

    createTeam: async (name) => {
      const url = get().url;
      if (url === undefined) return false;
      const value = await run('create the team', () => ipc().team.create({ url, name }));
      if (value === undefined) return false;
      // Listed at once, so nothing reads a selected team that is not in the list before the reload lands.
      set({ teams: [...get().teams, value.team], teamId: value.team.id, page: DEFAULT_TEAM_PAGE });
      await get().refresh();
      return true;
    },

    renameTeam: (name) => withTeam('rename the team', (url, teamId) => ipc().team.rename({ url, teamId, name })),

    deleteTeam: () => withTeam('delete the team', (url, teamId) => ipc().team.delete({ url, teamId })),

    addMember: (email, role) =>
      withTeam('add the member', (url, teamId) => ipc().team.addMember({ url, teamId, email, role })),

    setMemberRole: (userId, role) =>
      onRow(userId, (url, teamId) => ipc().team.setMemberRole({ url, teamId, userId, role })),

    removeMember: (userId) => onRow(userId, (url, teamId) => ipc().team.removeMember({ url, teamId, userId })),

    addPerson: async (email, role) => {
      const { url, teamId } = get();
      if (url === undefined || teamId === undefined) return { kind: 'failed', message: 'No team is open.' };
      const added = await ipc().team.addMember({ url, teamId, email, role });
      if (added.ok) {
        await get().refresh();
        return { kind: 'member' };
      }
      if (added.error.code !== 'teams-user-unknown') return refused(added.error);
      const invited = await ipc().team.invite({ url, teamId, email, role });
      if (!invited.ok) return refused(invited.error);
      await get().refresh();
      return { kind: 'invited', invitation: invited.value.invitation };
    },

    renewInvitation: async (invitationId) => {
      const teamId = get().teamId;
      if (teamId === undefined) return false;
      const value = await write('renew the invitation', (url) =>
        ipc().team.renewInvitation({ url, teamId, invitationId }),
      );
      if (value === undefined) return false;
      set({ lastInvite: value.invitation });
      return true;
    },

    invite: async (email, role) => {
      const teamId = get().teamId;
      if (teamId === undefined) return false;
      const value = await write('create the invitation', (url) => ipc().team.invite({ url, teamId, email, role }));
      if (value === undefined) return false;
      set({ lastInvite: value.invitation });
      return true;
    },

    clearLastInvite: () => {
      set({ lastInvite: undefined });
    },

    revokeInvitation: (invitationId) =>
      withTeam('revoke the invitation', (url, teamId) => ipc().team.revokeInvitation({ url, teamId, invitationId })),

    createWorkspace: (name, defaultRole) =>
      withTeam('create the workspace', (url, teamId) =>
        ipc().team.createWorkspace({ url, teamId, name, ...(defaultRole !== undefined ? { defaultRole } : {}) }),
      ),

    updateWorkspace: async (workspaceId, patch) =>
      (await write('update the workspace', (url) => ipc().team.updateWorkspace({ url, workspaceId, ...patch }))) !==
      undefined,

    deleteWorkspace: async (workspaceId) => {
      if (get().access?.workspaceId === workspaceId) set({ access: undefined });
      return (
        (await write('delete the workspace', (url) => ipc().team.deleteWorkspace({ url, workspaceId }))) !== undefined
      );
    },

    openAccess: async (workspaceId) => {
      set({ access: { workspaceId, entries: [] } });
      await reloadAccess();
    },

    closeAccess: () => {
      set({ access: undefined });
    },

    setAccess: (userId, role) =>
      withAccess('change access', (url, workspaceId) => ipc().team.setAccess({ url, workspaceId, userId, role })),

    clearAccess: (userId) =>
      withAccess('change access', (url, workspaceId) => ipc().team.clearAccess({ url, workspaceId, userId })),
  };
});
