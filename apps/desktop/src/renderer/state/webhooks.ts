/**
 * The open workspace's catch URLs (webhook-capture spec §4.2). It follows the workspace: shared on a
 * server whose `/meta` has `hooks.enabled`, it watches the workspace's live nudges through main and
 * keeps the list and each catch URL's unseen count current. Everything from `shared/` is imported
 * as a type: a value import pulls zod into the renderer, which the CSP refuses.
 */
import { create } from 'zustand';
import type {
  CatchUrlWire,
  HooksCapturedEventWire,
  HooksChangedEventWire,
  HooksMetaWire,
  WorkspaceChangedEvent,
  WorkspaceWire,
} from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';
import { useSyncStore } from './sync.js';
import { readSeen, writeSeen } from './webhooks-seen.js';
import { useWorkspaceStore } from './workspace.js';

export interface WebhooksServer {
  readonly url: string;
  readonly workspaceId: string;
}

export interface Unseen {
  readonly count: number;
  readonly more: boolean;
}

const ZERO: Unseen = { count: 0, more: false };

interface WebhooksSnapshot {
  readonly server: WebhooksServer | undefined;
  /** `/meta` `hooks`: `undefined` while unknown (or unreachable), `null` for a server without the module. */
  readonly meta: HooksMetaWire | null | undefined;
  readonly hooks: readonly CatchUrlWire[];
  readonly loaded: boolean;
  readonly error: { readonly code: string; readonly message: string } | undefined;
  readonly unseen: Readonly<Record<string, Unseen>>;
}

export interface WebhooksStore extends WebhooksSnapshot {
  /** Follows the open workspace's server share; `undefined` for none. A repeat is a no-op. */
  readonly follow: (server: WebhooksServer | undefined) => Promise<void>;
  /** Asks `/meta` again when it was unreachable, or re-lists after a failed list. */
  readonly retry: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly recount: (hookId: string) => Promise<void>;
  /** The newest capture the user has now seen; `null` when the catch URL has none. */
  readonly markSeen: (hookId: string, captureId: string | null) => void;
  readonly reset: () => void;
}

const EMPTY: WebhooksSnapshot = {
  server: undefined,
  meta: undefined,
  hooks: [],
  loaded: false,
  error: undefined,
  unseen: {},
};

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function sameServer(
  a: { readonly url: string; readonly workspaceId: string } | undefined,
  b: { readonly url: string; readonly workspaceId: string } | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.workspaceId === b.workspaceId && originOf(a.url) === originOf(b.url);
}

export function serverOf(workspace: WorkspaceWire | null | undefined): WebhooksServer | undefined {
  const share = workspace?.share;
  if (share?.kind !== 'server' || share.server === undefined) return undefined;
  return { url: share.server.url, workspaceId: share.server.workspaceId };
}

export const useWebhooksStore = create<WebhooksStore>((set, get) => {
  /** Asks `/meta`, then watches and lists when the module is on. */
  const connect = async (server: WebhooksServer): Promise<void> => {
    const status = await ipc().hooks.status({ url: server.url });
    if (!sameServer(get().server, server)) return;
    if (!status.ok) {
      set({ meta: undefined, error: status.error });
      return;
    }
    set({ meta: status.value.hooks, error: undefined });
    if (status.value.hooks?.enabled !== true) return;
    void ipc().hooks.watch(server);
    await get().refresh();
  };

  return {
    ...EMPTY,

    follow: async (server) => {
      const before = get().server;
      if (sameServer(before, server)) return;
      get().reset();
      if (server === undefined) return;
      set({ server });
      await connect(server);
    },

    retry: async () => {
      const { server, meta, error } = get();
      if (server === undefined) return;
      if (meta === undefined) await connect(server);
      else if (meta?.enabled === true && error !== undefined) await get().refresh();
    },

    refresh: async () => {
      const server = get().server;
      if (server === undefined || get().meta?.enabled !== true) return;
      const result = await ipc().hooks.list(server);
      if (!sameServer(get().server, server)) return;
      if (!result.ok) {
        set({ loaded: true, error: result.error });
        return;
      }
      const hooks = result.value.hooks;
      const unseen: Record<string, Unseen> = {};
      const stale: string[] = [];
      for (const hook of hooks) {
        const newest = hook.newestCaptureId ?? '';
        const seen = readSeen(server.url, hook.id);
        if (seen === undefined) {
          // First sight on this device: what came before is history, not news.
          writeSeen(server.url, hook.id, newest);
          unseen[hook.id] = ZERO;
        } else if (seen === newest) {
          unseen[hook.id] = ZERO;
        } else {
          unseen[hook.id] = get().unseen[hook.id] ?? ZERO;
          stale.push(hook.id);
        }
      }
      set({ hooks, loaded: true, error: undefined, unseen });
      for (const hookId of stale) void get().recount(hookId);
    },

    recount: async (hookId) => {
      const server = get().server;
      if (server === undefined) return;
      // Remembered so an answer can be dropped if `markSeen` moved the marker while this was in
      // flight (an open tab marking captures seen meanwhile): the reply no longer matches what
      // this device has now seen, so applying it would resurrect a badge the user just cleared.
      const seenAtRequest = readSeen(server.url, hookId);
      const result = await ipc().hooks.unseen({
        url: server.url,
        workspaceId: server.workspaceId,
        hookId,
        after: seenAtRequest === undefined || seenAtRequest === '' ? null : seenAtRequest,
      });
      if (!result.ok || !sameServer(get().server, server)) return;
      if (readSeen(server.url, hookId) !== seenAtRequest) return;
      set((state) => ({ unseen: { ...state.unseen, [hookId]: result.value } }));
    },

    markSeen: (hookId, captureId) => {
      const server = get().server;
      if (server === undefined) return;
      writeSeen(server.url, hookId, captureId ?? '');
      set((state) => ({ unseen: { ...state.unseen, [hookId]: ZERO } }));
    },

    reset: () => {
      const { server, meta } = get();
      if (server !== undefined && meta?.enabled === true) void ipc().hooks.unwatch(server);
      set(EMPTY);
    },
  };
});

/** Keeps the store on the open workspace; mounted once in the shell next to `subscribeToTeamSecrets`. */
export function subscribeToWebhooks(): () => void {
  const store = useWebhooksStore.getState;
  const follow = (workspace: WorkspaceWire | null | undefined): void => {
    void store().follow(serverOf(workspace));
  };
  const ours = (payload: { readonly url: string; readonly workspaceId: string }): boolean =>
    sameServer(store().server, payload);

  const offWorkspace = window.wirebench.on('workspace.changed', ((payload: WorkspaceChangedEvent) => {
    follow(payload.workspace);
  }) as (payload: unknown) => void);
  const offChanged = window.wirebench.on('hooks.changed', ((payload: HooksChangedEventWire) => {
    if (ours(payload)) void store().refresh();
  }) as (payload: unknown) => void);
  const offCaptured = window.wirebench.on('hooks.captured', ((payload: HooksCapturedEventWire) => {
    if (ours(payload)) void store().recount(payload.hookId);
  }) as (payload: unknown) => void);
  // A sign-in can make a failed list succeed.
  const offAccount = window.wirebench.on('account.changed', () => {
    void store().retry();
  });
  // The socket reaching the server means `/meta` can be asked again.
  const offSync = useSyncStore.subscribe((state, previous) => {
    if (state.status.live === 'connected' && previous.status.live !== 'connected') void store().retry();
  });

  follow(useWorkspaceStore.getState().workspace);
  return () => {
    offWorkspace();
    offChanged();
    offCaptured();
    offAccount();
    offSync();
    store().reset();
  };
}
