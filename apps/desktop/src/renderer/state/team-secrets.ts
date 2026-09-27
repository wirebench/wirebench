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

/** The rotate mark's wording (spec §3.6): the Team secrets section's row and the secret field's mark share it. */
export function rotateMessage(label: string, names: readonly string[]): string {
  return `${label}: ${names.join(', ')} had access. Change this value at its provider, then here.`;
}

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
    // Captured before the round trip: if the open workspace switches (or closes) while `status`
    // is in flight, this reply belongs to a workspace that is no longer open and must be dropped
    // rather than clobbering whatever `subscribeToTeamSecrets` has since loaded for the new one.
    const workspaceId = useWorkspaceStore.getState().workspace?.id;
    const result = await ipc().teamSecrets.status(undefined);
    if (useWorkspaceStore.getState().workspace?.id !== workspaceId) {
      return;
    }
    if (result.ok) {
      set({ status: result.value });
    } else {
      showToast(result.error.message);
    }
  },

  run: async (action, id) => {
    const workspaceId = useWorkspaceStore.getState().workspace?.id;
    set({ busy: true });
    try {
      const api = ipc().teamSecrets;
      const result =
        action === 'turnOn' || action === 'requestAccess'
          ? await api[action](undefined)
          : KEY_ACTIONS.has(action)
            ? await api[action as KeyAction]({ keyId: id ?? '' })
            : await api[action as EntryAction]({ entryId: id ?? '' });
      // Same guard as `refresh`: a workspace switch mid-flight must not apply this answer.
      if (useWorkspaceStore.getState().workspace?.id !== workspaceId) {
        return;
      }
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

  // Mirrors `subscribeToSync`'s tracking: `lastWorkspaceId` starts `null` regardless of what is
  // actually open, so a mount with a workspace already open sees no "switch" when it later
  // closes — the explicit `nextId === null` catches that close anyway.
  let lastWorkspaceId: string | null = null;
  const offWorkspace = window.wirebench.on('workspace.changed', ((payload: WorkspaceChangedEvent) => {
    const nextId = payload.workspace?.id ?? null;
    const switched = nextId !== lastWorkspaceId;
    if (switched || nextId === null) {
      useTeamSecretsStore.getState().reset();
    }
    if (switched && payload.workspace?.share !== undefined) {
      void useTeamSecretsStore.getState().refresh();
    }
    lastWorkspaceId = nextId;
  }) as (payload: unknown) => void);

  void useTeamSecretsStore.getState().refresh();
  return () => {
    offChanged();
    offWorkspace();
  };
}
