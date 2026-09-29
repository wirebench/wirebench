/**
 * The open server workspace's CI tokens (callback-assertion §5). A new token's value is held only
 * while its panel is open: `dismissCreated` (or `reset`) drops it, and nothing here writes it
 * anywhere else — no other store, no `localStorage`.
 */
import { create } from 'zustand';
import type { CiTokenCreatedWire, CiTokenSummaryWire } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

export { CI_TOKEN_NAME_MAX } from './ci-token-bounds.js';

export interface CiTokenServer {
  readonly url: string;
  readonly workspaceId: string;
}

interface CiTokensSnapshot {
  readonly tokens: readonly CiTokenSummaryWire[];
  readonly loaded: boolean;
  readonly error: string | undefined;
  readonly created: CiTokenCreatedWire | undefined;
}

interface CiTokensStore extends CiTokensSnapshot {
  readonly load: (server: CiTokenServer) => Promise<void>;
  /** Resolves `true` when the token was created; its value is then in `created`. */
  readonly create: (server: CiTokenServer, name: string) => Promise<boolean>;
  readonly revoke: (server: CiTokenServer, tokenId: string) => Promise<void>;
  readonly dismissCreated: () => void;
  readonly reset: () => void;
}

const EMPTY: CiTokensSnapshot = { tokens: [], loaded: false, error: undefined, created: undefined };

/**
 * `loads` is bumped by every `load` and `reset`, so a list that answers after a newer load — or
 * after the section closed or the workspace changed — is dropped rather than shown. `epoch` is
 * bumped only by `reset`: a create or revoke that answers after it is dropped too.
 */
let loads = 0;
let epoch = 0;

export const useCiTokensStore = create<CiTokensStore>((set, get) => ({
  ...EMPTY,
  load: async (server) => {
    const mine = ++loads;
    const result = await ipc().ciTokens.list({ url: server.url, workspaceId: server.workspaceId });
    if (mine !== loads) return;
    set(
      result.ok
        ? { tokens: result.value.tokens, loaded: true, error: undefined }
        : { loaded: true, error: result.error.message },
    );
  },
  create: async (server, name) => {
    const started = epoch;
    const result = await ipc().ciTokens.create({ url: server.url, workspaceId: server.workspaceId, name: name.trim() });
    if (started !== epoch) return false;
    if (!result.ok) {
      set({ error: result.error.message });
      return false;
    }
    set({ created: result.value, error: undefined });
    await get().load(server);
    return true;
  },
  revoke: async (server, tokenId) => {
    const started = epoch;
    const result = await ipc().ciTokens.revoke({ url: server.url, workspaceId: server.workspaceId, tokenId });
    if (started !== epoch) return;
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    await get().load(server);
  },
  dismissCreated: () => set({ created: undefined }),
  reset: () => {
    loads += 1;
    epoch += 1;
    set(EMPTY);
  },
}));
