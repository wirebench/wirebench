/**
 * The *Server* page's state (hosted edition spec §22.13): the connected server's own settings, and in hosted mode its
 * billing, read when Settings opens for a signed-in server, never stored. The same read decides whether the page shows
 * at all: the server answers it to its server admins only (else `identity-forbidden`), and a server older than the
 * settings routes answers `404`. `source` tells the two modes apart: `tenant` is a hosted team, whose sections are
 * written here; `environment` is a self-hosted server, whose sections are read-only.
 *
 * Secrets never reach this state: the server answers each as `{ set }`, and a replacement typed in a field goes out
 * with its save and is dropped.
 */
import { create } from 'zustand';
import type { IpcError } from '@shared/ipc.js';
import type {
  ServerSettingsWire,
  ServerSettingsWritableSectionWire,
  TenantBillingWire,
  TenantExportWire,
} from '@shared/wire-base.js';
import { ipc } from '../../../state/ipc-client.js';

/** The pages of the *Server* group, in the nav's order; `billing` and `delete` are a hosted team's only. */
export const SERVER_PAGES = [
  'sign-in',
  'provisioning',
  'audit-forwarding',
  'email',
  'retention',
  'billing',
  'export',
  'delete',
] as const;
export type ServerPageId = (typeof SERVER_PAGES)[number];

export const HOSTED_ONLY_PAGES: ReadonlySet<ServerPageId> = new Set<ServerPageId>(['billing', 'delete']);

/** The refusals that mean the page is not for this caller on this server; any other failure is shown. */
export const NOT_FOR_YOU: ReadonlySet<string> = new Set([
  'identity-forbidden',
  'identity-unauthenticated',
  'account-signed-out',
]);

/** Where an error or a busy flag belongs: a settings section, or one of the account cards. */
export type ServerCardId = ServerSettingsWritableSectionWire | 'billing' | 'exports' | 'deletion';

interface ServerSettingsSnapshot {
  /** The server the snapshot is of. */
  readonly url: string | undefined;
  /** The server answered the read: the caller is a server admin of it. */
  readonly available: boolean;
  readonly loaded: boolean;
  readonly settings: ServerSettingsWire | undefined;
  readonly billing: TenantBillingWire | undefined;
  readonly exports: readonly TenantExportWire[];
  readonly exportsLoaded: boolean;
  readonly busy: Readonly<Partial<Record<ServerCardId, boolean>>>;
  readonly errors: Readonly<Partial<Record<ServerCardId, string | undefined>>>;
}

interface ServerSettingsStore extends ServerSettingsSnapshot {
  readonly load: (url: string) => Promise<void>;
  /** Resolves `true` when the server checked and stored the section. */
  readonly save: (
    section: ServerSettingsWritableSectionWire,
    value: Readonly<Record<string, unknown>>,
  ) => Promise<boolean>;
  readonly clear: (section: ServerSettingsWritableSectionWire) => Promise<boolean>;
  readonly loadExports: () => Promise<void>;
  readonly requestExport: () => Promise<boolean>;
  /** Saves a ready export through main's Save dialog; the path it was saved to, or `undefined`. */
  readonly downloadExport: (id: string) => Promise<string | undefined>;
  readonly requestDeletion: (slug: string) => Promise<boolean>;
  readonly cancelDeletion: () => Promise<boolean>;
  readonly clearError: (card: ServerCardId) => void;
  readonly reset: () => void;
}

const EMPTY: ServerSettingsSnapshot = {
  url: undefined,
  available: false,
  loaded: false,
  settings: undefined,
  billing: undefined,
  exports: [],
  exportsLoaded: false,
  busy: {},
  errors: {},
};

/** Whether `settings` is a hosted team's: its sections are its own, not the environment's. */
export function isHosted(settings: ServerSettingsWire | undefined): boolean {
  return settings?.source === 'tenant';
}

/** A refusal as the card shows it: the server's own words. */
export function serverErrorText(error: IpcError): string {
  return error.message;
}

const status = (error: IpcError): unknown => (error.details as { readonly status?: unknown } | undefined)?.status;

/**
 * As in `domain.ts`: a stale load, or a write that answers after `reset` or for another server, is dropped. A load for
 * another server bumps `epoch` too, so a write sent to the old server never lands on the new one's snapshot.
 */
let loads = 0;
let epoch = 0;

export const useServerSettingsStore = create<ServerSettingsStore>((set, get) => {
  /** Runs one write of `card` for the current server; `undefined` when it was dropped or there is no server. */
  async function write<T>(
    card: ServerCardId,
    call: (
      url: string,
    ) => Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: IpcError }>,
  ): Promise<T | undefined> {
    const url = get().url;
    if (url === undefined) return undefined;
    const started = epoch;
    set((s) => ({ busy: { ...s.busy, [card]: true }, errors: { ...s.errors, [card]: undefined } }));
    const result = await call(url);
    if (started !== epoch || get().url !== url) return undefined;
    if (!result.ok) {
      set((s) => ({
        busy: { ...s.busy, [card]: false },
        errors: { ...s.errors, [card]: serverErrorText(result.error) },
      }));
      return undefined;
    }
    set((s) => ({ busy: { ...s.busy, [card]: false } }));
    return result.value;
  }

  async function reloadBilling(url: string): Promise<void> {
    const started = epoch;
    const result = await ipc().tenantBilling.get({ url });
    if (started !== epoch || get().url !== url) return;
    set((s) =>
      result.ok
        ? { billing: result.value, errors: { ...s.errors, billing: undefined } }
        : { billing: undefined, errors: { ...s.errors, billing: serverErrorText(result.error) } },
    );
  }

  return {
    ...EMPTY,
    load: async (url) => {
      const mine = ++loads;
      if (get().url !== url) {
        epoch += 1;
        set({ ...EMPTY, url });
      }
      const result = await ipc().serverSettings.get({ url });
      if (mine !== loads) return;
      if (!result.ok) {
        if (NOT_FOR_YOU.has(result.error.code) || status(result.error) === 404) set({ ...EMPTY, url, loaded: true });
        else set({ loaded: true, errors: { ...get().errors, oidc: serverErrorText(result.error) } });
        return;
      }
      set({ url, available: true, loaded: true, settings: result.value });
      if (isHosted(result.value)) await reloadBilling(url);
    },
    save: async (section, value) => {
      const view = await write(section, (url) => ipc().serverSettings.save({ url, section, value: { ...value } }));
      if (view === undefined) return false;
      set({ settings: view });
      return true;
    },
    clear: async (section) => {
      const view = await write(section, (url) => ipc().serverSettings.clear({ url, section }));
      if (view === undefined) return false;
      set({ settings: view });
      return true;
    },
    loadExports: async () => {
      const answer = await write('exports', (url) => ipc().tenantExports.list({ url }));
      if (answer !== undefined) set({ exports: answer.exports, exportsLoaded: true });
    },
    requestExport: async () => {
      const answer = await write('exports', (url) => ipc().tenantExports.request({ url }));
      if (answer === undefined) return false;
      set((s) => ({ exports: [answer.export, ...s.exports.filter((one) => one.id !== answer.export.id)] }));
      return true;
    },
    downloadExport: async (id) => {
      const answer = await write('exports', (url) => ipc().tenantExports.download({ url, id }));
      return answer?.saved === true ? answer.path : undefined;
    },
    requestDeletion: async (slug) => {
      const answer = await write('deletion', (url) => ipc().tenantDeletion.request({ url, slug: slug.trim() }));
      if (answer === undefined) return false;
      set((s) => ({ billing: s.billing === undefined ? s.billing : { ...s.billing, deletion: answer.deletion } }));
      const url = get().url;
      if (url !== undefined) await reloadBilling(url);
      return true;
    },
    cancelDeletion: async () => {
      const answer = await write('deletion', (url) => ipc().tenantDeletion.cancel({ url }));
      if (answer === undefined) return false;
      set((s) => ({ billing: s.billing === undefined ? s.billing : { ...s.billing, deletion: null } }));
      return true;
    },
    clearError: (card) => {
      set((s) => ({ errors: { ...s.errors, [card]: undefined } }));
    },
    reset: () => {
      loads += 1;
      epoch += 1;
      set(EMPTY);
    },
  };
});

/** The pages the nav lists for `settings`: every page on a hosted team, all but Billing and Delete team self-hosted. */
export function serverPages(settings: ServerSettingsWire | undefined): readonly ServerPageId[] {
  return SERVER_PAGES.filter((page) => isHosted(settings) || !HOSTED_ONLY_PAGES.has(page));
}

/**
 * The name the group shows: a hosted team's slug, the first label of its address, else the server's host. A team on a
 * custom name shows that name's first label; the server still checks a typed slug against its own.
 */
export function serverLabel(url: string, hosted: boolean): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  return hosted ? (host.split('.')[0] ?? host) : host;
}
