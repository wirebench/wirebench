/**
 * The teams dialog's state (teams-access §3.5): one server's teams, the selected team's members and
 * invitations, and every workspace the caller can see on that server. Nothing here is persisted; the
 * dialog reloads each time it opens. Failures toast, except a signed-out answer, which flips
 * `signedOut` so the dialog can offer *Sign in again*.
 */
import { create } from 'zustand';
import type { IpcResult } from '../../shared/ipc.js';
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
} from '../../shared/wire-types.js';
import { showToast } from '../components/toast.js';
import { ipc } from './ipc-client.js';

export type TeamTab = 'members' | 'workspaces' | 'invitations';

export interface TeamState {
  readonly url: string | undefined;
  readonly serverAdmin: boolean;
  readonly teams: readonly TeamWire[];
  readonly teamId: string | undefined;
  readonly tab: TeamTab;
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
}

export interface TeamStore extends TeamState {
  readonly open: (url: string) => Promise<void>;
  readonly reset: () => void;
  readonly refresh: () => Promise<void>;
  readonly selectTeam: (teamId: string) => Promise<void>;
  readonly setTab: (tab: TeamTab) => void;
  readonly createTeam: (name: string) => Promise<boolean>;
  readonly renameTeam: (name: string) => Promise<boolean>;
  readonly deleteTeam: () => Promise<boolean>;
  readonly addMember: (email: string, role: TeamRoleWire) => Promise<boolean>;
  readonly setMemberRole: (userId: string, role: TeamRoleWire) => Promise<boolean>;
  readonly removeMember: (userId: string) => Promise<boolean>;
  readonly invite: (email: string, role: TeamRoleWire) => Promise<boolean>;
  readonly clearLastInvite: () => void;
  readonly revokeInvitation: (invitationId: string) => Promise<boolean>;
  readonly createWorkspace: (name: string, defaultRole?: DefaultRoleWire) => Promise<boolean>;
  readonly updateWorkspace: (
    workspaceId: string,
    patch: { readonly name?: string; readonly defaultRole?: DefaultRoleWire },
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
  teams: [],
  teamId: undefined,
  tab: 'members',
  members: [],
  invitations: [],
  workspaces: [],
  access: undefined,
  lastInvite: undefined,
  loading: false,
  signedOut: false,
};

const SIGNED_OUT = new Set(['identity-unauthenticated', 'account-signed-out']);

export function selectedTeam(state: TeamState): TeamWire | undefined {
  return state.teams.find((team) => team.id === state.teamId);
}

export function teamWorkspaces(state: TeamState): readonly TeamWorkspaceWire[] {
  return state.workspaces.filter((workspace) => workspace.teamId === state.teamId);
}

export const useTeamStore = create<TeamStore>((set, get) => {
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
    if (value !== undefined) await get().refresh();
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

    open: async (url) => {
      set({ ...INITIAL, url, loading: true });
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
      const current = get().teamId;
      const teamId = list.teams.some((team) => team.id === current) ? current : list.teams[0]?.id;
      set({
        teams: list.teams,
        serverAdmin: list.serverAdmin,
        workspaces: spaces?.workspaces ?? get().workspaces,
        teamId,
      });
      await loadTeam();
      await reloadAccess();
      set({ loading: false });
    },

    selectTeam: async (teamId) => {
      set({ teamId, members: [], invitations: [], access: undefined });
      if (get().tab === 'invitations' && selectedTeam(get())?.myRole !== 'admin') set({ tab: 'members' });
      await loadTeam();
    },

    setTab: (tab) => {
      set({ tab, access: undefined });
    },

    createTeam: async (name) => {
      const url = get().url;
      if (url === undefined) return false;
      const value = await run('create the team', () => ipc().team.create({ url, name }));
      if (value === undefined) return false;
      set({ teamId: value.team.id, tab: 'members' });
      await get().refresh();
      return true;
    },

    renameTeam: (name) => withTeam('rename the team', (url, teamId) => ipc().team.rename({ url, teamId, name })),

    deleteTeam: () => withTeam('delete the team', (url, teamId) => ipc().team.delete({ url, teamId })),

    addMember: (email, role) =>
      withTeam('add the member', (url, teamId) => ipc().team.addMember({ url, teamId, email, role })),

    setMemberRole: (userId, role) =>
      withTeam('change the role', (url, teamId) => ipc().team.setMemberRole({ url, teamId, userId, role })),

    removeMember: (userId) =>
      withTeam('remove the member', (url, teamId) => ipc().team.removeMember({ url, teamId, userId })),

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
