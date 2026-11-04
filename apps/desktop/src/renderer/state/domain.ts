/**
 * The Domain tab's state (hosted edition spec §23.6): a hosted tenant's one custom name, read from the server when the
 * team dialog opens for a server admin, never stored. The same read decides whether the tab shows at all: the server
 * answers it only in hosted mode (else `custom-domains-hosted-only`) and only with the `custom-domains` feature (else
 * `licensing-feature-required`), and neither its meta nor the license state tells the desktop which mode it runs in.
 */
import { create } from 'zustand';
import type { IpcError } from '@shared/ipc.js';
import type { CustomDomainWire } from '@shared/wire-base.js';
import { ipc } from './ipc-client.js';

/** `POST …/check` within a minute of the last (spec §23.2). */
export const CHECK_RATE_LIMITED = 'custom-domains-check-rate-limited';

/**
 * The refusals that mean the tab is not for this caller on this server: self-hosted, no feature, not a server admin,
 * or not signed in. Any other failure (unreachable, a bad answer) leaves the tab as it was and shows the error.
 */
export const NOT_FOR_YOU: ReadonlySet<string> = new Set([
  'custom-domains-hosted-only',
  'licensing-feature-required',
  'identity-forbidden',
  'identity-unauthenticated',
]);

interface DomainSnapshot {
  /** The server the snapshot is of. */
  readonly url: string | undefined;
  /** The server answered the read: hosted, with the feature, and the caller a server admin. */
  readonly available: boolean;
  readonly loaded: boolean;
  /** `undefined`: no name claimed. */
  readonly domain: CustomDomainWire | undefined;
  readonly busy: boolean;
  readonly error: string | undefined;
  /** The last read failed for a reason other than {@link NOT_FOR_YOU}: the tab offers Retry. */
  readonly loadFailed: boolean;
}

interface DomainStore extends DomainSnapshot {
  readonly load: (url: string) => Promise<void>;
  /** Resolves `true` when the server took the claim; it is then in `domain`. */
  readonly claim: (url: string, name: string) => Promise<boolean>;
  readonly check: (url: string) => Promise<void>;
  /** Resolves `true` when the server dropped the claim. */
  readonly remove: (url: string) => Promise<boolean>;
  readonly clearError: () => void;
  readonly reset: () => void;
}

const EMPTY: DomainSnapshot = {
  url: undefined,
  available: false,
  loaded: false,
  domain: undefined,
  busy: false,
  error: undefined,
  loadFailed: false,
};

/** What a refusal shows: a `429` as the seconds to wait, anything else as the server's own words. */
export function domainErrorText(error: IpcError): string {
  if (error.code === CHECK_RATE_LIMITED) {
    const ms = (error.details as { readonly retryAfterMs?: unknown } | undefined)?.retryAfterMs;
    if (typeof ms === 'number' && ms > 0) {
      const seconds = Math.ceil(ms / 1000);
      return `This name was checked less than a minute ago. Try again in ${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}.`;
    }
  }
  return error.message;
}

/**
 * As in `provisioning.ts`: a stale load, or a write that answers after `reset`, is dropped. A load for another server
 * bumps `epoch` too, so a claim, check or removal sent to the old server never lands on the new one's snapshot.
 */
let loads = 0;
let epoch = 0;

/** The write started under `started` for `url` still belongs to the snapshot. */
const current = (started: number, url: string): boolean => started === epoch && useDomainStore.getState().url === url;

export const useDomainStore = create<DomainStore>((set) => ({
  ...EMPTY,
  load: async (url) => {
    const mine = ++loads;
    if (useDomainStore.getState().url !== url) {
      epoch += 1;
      set({ ...EMPTY, url });
    }
    const result = await ipc().domain.get({ url });
    if (mine !== loads) return;
    if (result.ok) {
      set({
        url,
        available: true,
        loaded: true,
        domain: result.value.domain ?? undefined,
        error: undefined,
        loadFailed: false,
      });
    } else if (NOT_FOR_YOU.has(result.error.code)) {
      set({ ...EMPTY, url, loaded: true });
    } else {
      set({ loaded: true, error: domainErrorText(result.error), loadFailed: true });
    }
  },
  claim: async (url, name) => {
    const started = epoch;
    set({ busy: true, error: undefined });
    const result = await ipc().domain.claim({ url, name: name.trim() });
    if (!current(started, url)) return false;
    if (!result.ok) {
      set({ busy: false, error: domainErrorText(result.error) });
      return false;
    }
    set({ busy: false, domain: result.value.domain ?? undefined, error: undefined });
    return true;
  },
  check: async (url) => {
    const started = epoch;
    set({ busy: true, error: undefined });
    const result = await ipc().domain.check({ url });
    if (!current(started, url)) return;
    set(
      result.ok
        ? { busy: false, domain: result.value.domain ?? undefined, error: undefined }
        : { busy: false, error: domainErrorText(result.error) },
    );
  },
  remove: async (url) => {
    const started = epoch;
    set({ busy: true, error: undefined });
    const result = await ipc().domain.remove({ url });
    if (!current(started, url)) return false;
    if (!result.ok) {
      set({ busy: false, error: domainErrorText(result.error) });
      return false;
    }
    set({ busy: false, domain: undefined, error: undefined });
    return true;
  },
  clearError: () => {
    set({ error: undefined });
  },
  reset: () => {
    loads += 1;
    epoch += 1;
    set(EMPTY);
  },
}));
