/**
 * The Provisioning tab's state (saml-scim spec §3.7): SAML details, SCIM tokens and SCIM groups, read from
 * the server when the tab opens or on Refresh, never stored. A created token lives here only until the
 * person closes its panel.
 */
import { create } from 'zustand';
import type {
  SamlInfoWire,
  ScimGroupSummaryWire,
  ScimTokenCreatedWire,
  ScimTokenSummaryWire,
} from '@shared/wire-base.js';
import { ipc } from './ipc-client.js';

interface ProvisioningSnapshot {
  readonly info: SamlInfoWire | undefined;
  readonly tokens: readonly ScimTokenSummaryWire[];
  readonly groups: readonly ScimGroupSummaryWire[];
  readonly loaded: boolean;
  readonly busy: boolean;
  /** `licensing-feature-required` shows the Enterprise note instead of the sections. */
  readonly errorCode: string | undefined;
  readonly error: string | undefined;
  /** The token just created, shown once in a copy field. */
  readonly created: ScimTokenCreatedWire | undefined;
  /** A link or unlink that failed, by group id, shown on its row. */
  readonly groupErrors: Readonly<Record<string, string>>;
}

interface ProvisioningStore extends ProvisioningSnapshot {
  readonly load: (url: string) => Promise<void>;
  /** Resolves `true` when the server made the token; it is then in `created`. */
  readonly createToken: (url: string, name: string) => Promise<boolean>;
  readonly dismissCreated: () => void;
  readonly revokeToken: (url: string, tokenId: string) => Promise<void>;
  /** `null` unlinks. */
  readonly linkGroup: (url: string, groupId: string, teamId: string | null) => Promise<void>;
  readonly reset: () => void;
}

const EMPTY: ProvisioningSnapshot = {
  info: undefined,
  tokens: [],
  groups: [],
  loaded: false,
  busy: false,
  errorCode: undefined,
  error: undefined,
  created: undefined,
  groupErrors: {},
};

/** As in `license.ts`: a stale load, or a write that answers after `reset`, is dropped. */
let loads = 0;
let epoch = 0;

export const useProvisioningStore = create<ProvisioningStore>((set, get) => ({
  ...EMPTY,
  load: async (url) => {
    const mine = ++loads;
    const [info, tokens, groups] = await Promise.all([
      ipc().provisioning.info({ url }),
      ipc().provisioning.listTokens({ url }),
      ipc().provisioning.listGroups({ url }),
    ]);
    if (mine !== loads) return;
    const failure = [info, tokens, groups].find((result) => !result.ok);
    set({
      loaded: true,
      info: info.ok ? info.value : undefined,
      tokens: tokens.ok ? tokens.value.tokens : [],
      groups: groups.ok ? groups.value.groups : [],
      errorCode: failure !== undefined && !failure.ok ? failure.error.code : undefined,
      error: failure !== undefined && !failure.ok ? failure.error.message : undefined,
      groupErrors: {},
    });
  },
  createToken: async (url, name) => {
    const started = epoch;
    set({ busy: true });
    const result = await ipc().provisioning.createToken({ url, name: name.trim() });
    if (started !== epoch) return false;
    if (!result.ok) {
      set({ busy: false, error: result.error.message });
      return false;
    }
    set({ busy: false, created: result.value, error: undefined });
    await get().load(url);
    return true;
  },
  dismissCreated: () => {
    set({ created: undefined });
  },
  revokeToken: async (url, tokenId) => {
    const started = epoch;
    set({ busy: true });
    const result = await ipc().provisioning.revokeToken({ url, tokenId });
    if (started !== epoch) return;
    set({ busy: false, ...(result.ok ? {} : { error: result.error.message }) });
    if (result.ok) await get().load(url);
  },
  linkGroup: async (url, groupId, teamId) => {
    const started = epoch;
    const result = await ipc().provisioning.linkGroup({ url, groupId, teamId });
    if (started !== epoch) return;
    if (!result.ok) {
      set((s) => ({ groupErrors: { ...s.groupErrors, [groupId]: result.error.message } }));
      return;
    }
    const linked = result.value;
    set((s) => {
      const groupErrors = { ...s.groupErrors };
      delete groupErrors[groupId];
      return { groups: s.groups.map((group) => (group.id === groupId ? linked : group)), groupErrors };
    });
  },
  reset: () => {
    loads += 1;
    epoch += 1;
    set(EMPTY);
  },
}));
