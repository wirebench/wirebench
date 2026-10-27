/**
 * The open workspace's schedules (#517). It follows the workspace like the webhooks store: shared on an
 * Enterprise server that runs schedules, it watches the workspace's `schedule-run` messages through main
 * and keeps the list current without polling. Everything from `shared/` is imported as a type: a value
 * import pulls zod into the renderer, which the CSP refuses.
 */
import { create } from 'zustand';
import type { WorkspaceChangedEvent, WorkspaceWire } from '@shared/wire-base.js';
import type { SchedulesChangedEventWire, ScheduleWire } from '@shared/schedules-wire.js';
import { ipc } from './ipc-client.js';
import { useSyncStore } from './sync.js';
import { sameServer, serverOf, type WebhooksServer } from './webhooks.js';
import { useWorkspaceStore } from './workspace.js';

export type SchedulesServer = WebhooksServer;

/** The code a server without the license feature answers every schedules call with. */
export const LICENSE_REQUIRED = 'licensing-feature-required';

interface SchedulesSnapshot {
  readonly server: SchedulesServer | undefined;
  /** Whether the server runs schedules: `undefined` while unknown (or unreachable). */
  readonly available: boolean | undefined;
  readonly schedules: readonly ScheduleWire[];
  readonly loaded: boolean;
  readonly error: { readonly code: string; readonly message: string } | undefined;
  /** Counts up each time a schedule's runs change, so its open tab re-reads them. */
  readonly runsVersion: Readonly<Record<string, number>>;
}

export interface SchedulesStore extends SchedulesSnapshot {
  /** Follows the open workspace's server share; `undefined` for none. A repeat is a no-op. */
  readonly follow: (server: SchedulesServer | undefined) => Promise<void>;
  /** Asks the server again when it was unreachable, or re-lists after a failed list. */
  readonly retry: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  /** A run of `scheduleId` ended (or was asked for): re-read the schedule and tell its tab. */
  readonly runChanged: (scheduleId: string) => Promise<void>;
  readonly reset: () => void;
}

const EMPTY: SchedulesSnapshot = {
  server: undefined,
  available: undefined,
  schedules: [],
  loaded: false,
  error: undefined,
  runsVersion: {},
};

/** Whether the Schedules node shows: the server runs schedules and its license still covers them. */
export function schedulesShown(state: Pick<SchedulesSnapshot, 'available' | 'error'>): boolean {
  return state.available === true && state.error?.code !== LICENSE_REQUIRED;
}

/** The dot a schedule's row shows. */
export type ScheduleState = 'paused' | 'failing' | 'ok' | 'never';

export function scheduleStateOf(schedule: Pick<ScheduleWire, 'enabled' | 'alertState' | 'lastRun'>): ScheduleState {
  if (!schedule.enabled) return 'paused';
  if (schedule.alertState === 'failing') return 'failing';
  return schedule.lastRun === null ? 'never' : 'ok';
}

export const useSchedulesStore = create<SchedulesStore>((set, get) => {
  /** Asks whether the server runs schedules, then watches and lists when it does. */
  const connect = async (server: SchedulesServer): Promise<void> => {
    const status = await ipc().schedules.available({ url: server.url });
    if (!sameServer(get().server, server)) return;
    if (!status.ok) {
      set({ available: undefined, error: status.error });
      return;
    }
    set({ available: status.value.available, error: undefined });
    if (!status.value.available) return;
    void ipc().schedules.watch(server);
    await get().refresh();
  };

  const bump = (scheduleIds: readonly string[]): void => {
    set((state) => ({
      runsVersion: {
        ...state.runsVersion,
        ...Object.fromEntries(scheduleIds.map((id) => [id, (state.runsVersion[id] ?? 0) + 1])),
      },
    }));
  };

  return {
    ...EMPTY,

    follow: async (server) => {
      if (sameServer(get().server, server)) return;
      get().reset();
      if (server === undefined) return;
      set({ server });
      await connect(server);
    },

    retry: async () => {
      const { server, available, error } = get();
      if (server === undefined) return;
      if (available === undefined) await connect(server);
      else if (available && error !== undefined) await get().refresh();
    },

    refresh: async () => {
      const server = get().server;
      if (server === undefined || get().available !== true) return;
      const result = await ipc().schedules.list(server);
      if (!sameServer(get().server, server)) return;
      if (!result.ok) {
        set({ loaded: true, error: result.error });
        return;
      }
      set({ schedules: result.value.schedules, loaded: true, error: undefined });
    },

    runChanged: async (scheduleId) => {
      const server = get().server;
      if (server === undefined || get().available !== true) return;
      bump([scheduleId]);
      const result = await ipc().schedules.get({ ...server, scheduleId });
      if (!sameServer(get().server, server)) return;
      if (!result.ok) {
        // Gone, or out of reach: the list says which.
        await get().refresh();
        return;
      }
      const fresh = result.value.schedule;
      set((state) => ({
        schedules: state.schedules.some((schedule) => schedule.id === fresh.id)
          ? state.schedules.map((schedule) => (schedule.id === fresh.id ? fresh : schedule))
          : [...state.schedules, fresh],
      }));
    },

    reset: () => {
      const { server, available } = get();
      if (server !== undefined && available === true) void ipc().schedules.unwatch(server);
      set(EMPTY);
    },
  };
});

/** Keeps the store on the open workspace; mounted once in the shell next to `subscribeToWebhooks`. */
export function subscribeToSchedules(): () => void {
  const store = useSchedulesStore.getState;
  const follow = (workspace: WorkspaceWire | null | undefined): void => {
    void store().follow(serverOf(workspace));
  };

  const offWorkspace = window.wirebench.on('workspace.changed', ((payload: WorkspaceChangedEvent) => {
    follow(payload.workspace);
  }) as (payload: unknown) => void);
  const offChanged = window.wirebench.on('schedules.changed', ((payload: SchedulesChangedEventWire) => {
    if (!sameServer(store().server, payload)) return;
    if (payload.scheduleId !== undefined) {
      void store().runChanged(payload.scheduleId);
      return;
    }
    // Back after a drop: anything may have run meanwhile.
    void store()
      .refresh()
      .then(() => {
        const ids = store().schedules.map((schedule) => schedule.id);
        useSchedulesStore.setState((state) => ({
          runsVersion: Object.fromEntries(ids.map((id) => [id, (state.runsVersion[id] ?? 0) + 1])),
        }));
      });
  }) as (payload: unknown) => void);
  // A sign-in can make a failed list succeed.
  const offAccount = window.wirebench.on('account.changed', () => {
    void store().retry();
  });
  // The socket reaching the server means it can be asked again.
  const offSync = useSyncStore.subscribe((state, previous) => {
    if (state.status.live === 'connected' && previous.status.live !== 'connected') void store().retry();
  });

  follow(useWorkspaceStore.getState().workspace);
  return () => {
    offWorkspace();
    offChanged();
    offAccount();
    offSync();
    store().reset();
  };
}
