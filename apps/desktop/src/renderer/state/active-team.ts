import { create } from 'zustand';
import type { TeamWire, TeamWorkspaceWire, WorkspaceShareWire } from '@shared/wire-base.js';
import { ipc } from './ipc-client.js';

/**
 * The team you are working in, for the active account's server: the title bar's team switcher shows and
 * changes it, and the workspace list, *Open a team workspace…* and *Manage team…* follow it. Opening a team
 * workspace makes its team the active one. Remembered per account in this window's storage, a convenience
 * that falls back to the first team when storage is unavailable.
 */
export interface ActiveTeamState {
  /** The server and account the teams belong to; `undefined` while no account is active. */
  readonly url: string | undefined;
  readonly userId: string | undefined;
  readonly teams: readonly TeamWire[];
  /** Every team workspace the account can open there, to tell which team a workspace belongs to. */
  readonly workspaces: readonly TeamWorkspaceWire[];
  readonly teamId: string | undefined;
}

export interface ActiveTeamStore extends ActiveTeamState {
  /** Loads `url`'s teams for `userId` (or clears them with no account) and restores that account's choice. */
  readonly load: (account: { readonly url: string; readonly userId: string } | undefined) => Promise<void>;
  readonly setTeam: (teamId: string) => void;
  /** Makes the team owning server workspace `workspaceId` active, when it is one of this account's. */
  readonly follow: (url: string, workspaceId: string) => void;
}

const EMPTY: ActiveTeamState = { url: undefined, userId: undefined, teams: [], workspaces: [], teamId: undefined };

function storageKey(url: string, userId: string): string {
  return `wirebench.activeTeam:${url}#${userId}`;
}

function remembered(url: string, userId: string): string | undefined {
  try {
    return window.localStorage.getItem(storageKey(url, userId)) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(url: string, userId: string, teamId: string): void {
  try {
    window.localStorage.setItem(storageKey(url, userId), teamId);
  } catch {
    // Storage may be off (a private window): the choice then lasts as long as the window.
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a === b;
  }
}

export const useActiveTeamStore = create<ActiveTeamStore>()((set, get) => ({
  ...EMPTY,

  load: async (account) => {
    if (account === undefined) {
      set(EMPTY);
      return;
    }
    const { url, userId } = account;
    const [list, spaces] = await Promise.all([ipc().team.list({ url }), ipc().team.listWorkspaces({ url })]);
    if (!list.ok) {
      set({ ...EMPTY, url, userId });
      return;
    }
    const teams = list.value.teams;
    const kept = get().url === url && get().userId === userId ? get().teamId : undefined;
    const wanted = kept ?? remembered(url, userId);
    const teamId = teams.some((team) => team.id === wanted) ? wanted : teams[0]?.id;
    set({ url, userId, teams, workspaces: spaces.ok ? spaces.value.workspaces : [], teamId });
  },

  setTeam: (teamId) => {
    const { url, userId, teams } = get();
    if (!teams.some((team) => team.id === teamId)) return;
    set({ teamId });
    if (url !== undefined && userId !== undefined) remember(url, userId, teamId);
  },

  follow: (url, workspaceId) => {
    const state = get();
    if (state.url === undefined || !sameOrigin(state.url, url)) return;
    const owner = state.workspaces.find((workspace) => workspace.id === workspaceId)?.teamId;
    if (owner !== undefined && owner !== state.teamId) state.setTeam(owner);
  },
}));

/** The store's state alone, for `useShallow`: a list that follows the active team rerenders only when it changes. */
export function pickActive(state: ActiveTeamState): ActiveTeamState {
  return {
    url: state.url,
    userId: state.userId,
    teams: state.teams,
    workspaces: state.workspaces,
    teamId: state.teamId,
  };
}

/** Whether a workspace (a picker or menu row) is a team workspace of another team than the active one. */
export function ofOtherTeam(state: ActiveTeamState, row: { readonly share?: WorkspaceShareWire | undefined }): boolean {
  const server = row.share?.kind === 'server' ? row.share.server : undefined;
  return server !== undefined && inOtherTeam(state, server.url, server.workspaceId);
}

/** Whether a workspace is a team workspace of the active team itself. */
export function inTeam(state: ActiveTeamState, row: { readonly share?: WorkspaceShareWire | undefined }): boolean {
  const server = row.share?.kind === 'server' ? row.share.server : undefined;
  if (server === undefined || state.url === undefined || state.teamId === undefined) return false;
  if (!sameOrigin(state.url, server.url)) return false;
  return state.workspaces.find((workspace) => workspace.id === server.workspaceId)?.teamId === state.teamId;
}

/** The active team, if any. */
export function activeTeam(state: ActiveTeamState): TeamWire | undefined {
  return state.teams.find((team) => team.id === state.teamId);
}

/**
 * Whether a workspace on `url` with server workspace id `workspaceId` belongs to another team than the active one,
 * so a list following the active team leaves it out. A workspace of another server, or one the store does not know,
 * is never left out.
 */
export function inOtherTeam(state: ActiveTeamState, url: string, workspaceId: string): boolean {
  if (state.url === undefined || state.teamId === undefined || !sameOrigin(state.url, url)) return false;
  const owner = state.workspaces.find((workspace) => workspace.id === workspaceId)?.teamId;
  return owner !== undefined && owner !== state.teamId;
}
