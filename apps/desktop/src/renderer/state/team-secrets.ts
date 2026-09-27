/**
 * The renderer's mirror of the open shared workspace's team secrets (team-secrets spec §4): what
 * `teamSecrets.status` answers, kept current by `teamSecrets.changed`. Nothing here ever holds a
 * value — the status carries ids, names, fingerprints and labels only.
 */
import { create } from 'zustand';
import type { TeamSecretsStatusWire, TeamSecretsChangedEvent, WorkspaceChangedEvent } from '../../shared/wire-types.js';
import { showToast } from '../components/toast.js';
import { ipc } from './ipc-client.js';
import { useWorkspaceStore } from './workspace.js';

export const TEAM_SECRETS_OFF_STATUS: TeamSecretsStatusWire = {
  on: false,
  canTurnOn: false,
  canManage: false,
  me: { state: 'none', admin: false },
  pending: [],
  approved: [],
  formerMembers: [],
  rotate: [],
  untrusted: [],
  replaced: [],
  localOnly: [],
};

type KeyAction = 'approve' | 'decline' | 'remove' | 'grantAdmin' | 'revokeAdmin';
type EntryAction = 'restoreMine' | 'dismissReplaced';
export type TeamSecretsAction = 'turnOn' | 'requestAccess' | KeyAction | EntryAction;

interface TeamSecretsState {
  readonly status: TeamSecretsStatusWire;
  readonly busy: boolean;
  readonly refresh: () => Promise<void>;
  readonly run: (action: TeamSecretsAction, id?: string) => Promise<void>;
  readonly applyChanged: (workspaceId: string, status: TeamSecretsStatusWire) => void;
  readonly reset: () => void;
}

const KEY_ACTIONS: ReadonlySet<TeamSecretsAction> = new Set([
  'approve',
  'decline',
  'remove',
  'grantAdmin',
  'revokeAdmin',
]);

export const useTeamSecretsStore = create<TeamSecretsState>((set) => ({
  status: TEAM_SECRETS_OFF_STATUS,
  busy: false,

  refresh: async () => {
    const result = await ipc().teamSecrets.status(undefined);
    if (result.ok) {
      set({ status: result.value });
    }
  },

  run: async (action, id) => {
    set({ busy: true });
    try {
      const api = ipc().teamSecrets;
      const result =
        action === 'turnOn' || action === 'requestAccess'
          ? await api[action](undefined)
          : KEY_ACTIONS.has(action)
            ? await api[action as KeyAction]({ keyId: id ?? '' })
            : await api[action as EntryAction]({ entryId: id ?? '' });
      if (result.ok) {
        set({ status: result.value });
      } else {
        showToast(result.error.message);
      }
    } finally {
      set({ busy: false });
    }
  },

  applyChanged: (workspaceId, status) => {
    if (workspaceId === useWorkspaceStore.getState().workspace?.id) {
      set({ status });
    }
  },

  reset: () => {
    set({ status: TEAM_SECRETS_OFF_STATUS, busy: false });
  },
}));

/** Keeps the mirror current; called once from the shell next to `subscribeToSync`. */
export function subscribeToTeamSecrets(): () => void {
  const offChanged = window.wirebench.on('teamSecrets.changed', ((payload: TeamSecretsChangedEvent) => {
    useTeamSecretsStore.getState().applyChanged(payload.workspaceId, payload.status);
  }) as (payload: unknown) => void);

  let lastWorkspaceId: string | null = null;
  const offWorkspace = window.wirebench.on('workspace.changed', ((payload: WorkspaceChangedEvent) => {
    const nextId = payload.workspace?.id ?? null;
    if (nextId !== lastWorkspaceId) {
      useTeamSecretsStore.getState().reset();
      if (payload.workspace?.share !== undefined) {
        void useTeamSecretsStore.getState().refresh();
      }
    }
    lastWorkspaceId = nextId;
  }) as (payload: unknown) => void);

  void useTeamSecretsStore.getState().refresh();
  return () => {
    offChanged();
    offWorkspace();
  };
}
