import { create } from 'zustand';
import type { ResolvedHostWire, SshQuickTarget } from '../../../shared/ssh-wire.js';

/**
 * One-off servers (#537): typed as `[user@]host[:port]` in Connect to host and connected to with the SSH
 * agent, without a host in hosts.yaml. Each gets an id of its own (`quick-…`) for its panes, kept in this
 * window's memory only; Save as host… turns one into a saved host.
 */

const QUICK_PREFIX = 'quick-';
const DEFAULT_PORT = 22;

// `[user@]host[:port]`, the host a name, an IPv4 address or a bracketed IPv6 one.
const TARGET = /^(?:([^\s@\p{Cc}]+)@)?(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9][A-Za-z0-9._-]*)(?::(\d{1,5}))?$/u;

/**
 * The server a search names, or `undefined` while it reads as a search: a bare word could be any host's
 * name, so it needs a dot, a user, a port or brackets (or be `localhost`) to be a server.
 */
export function parseQuickTarget(text: string): SshQuickTarget | undefined {
  const match = TARGET.exec(text.trim());
  if (match === null) return undefined;
  const [, user, host = '', portText] = match;
  const bracketed = host.startsWith('[');
  if (user === undefined && portText === undefined && !bracketed && !host.includes('.') && host !== 'localhost') {
    return undefined;
  }
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (port < 1 || port > 65535) return undefined;
  const address = bracketed ? host.slice(1, -1) : host;
  if (address === '' || address.length > 253) return undefined;
  return { address, port, ...(user === undefined ? {} : { user }) };
}

/**
 * The saved hosts a typed server is (#594): the same address and port, and the same user when one was typed.
 * The palette lists them above the one-off Connect, so a known server opens as its saved host.
 */
export function savedHostsFor<T extends Pick<ResolvedHostWire, 'address' | 'ssh'>>(
  target: SshQuickTarget,
  hosts: readonly T[],
): T[] {
  const address = target.address.toLowerCase();
  return hosts.filter(
    (host) =>
      host.address.toLowerCase() === address &&
      host.ssh.port.value === target.port &&
      (target.user === undefined || host.ssh.user.value === target.user),
  );
}

/** `user@host`, with `:port` when it is not 22. */
export function quickTargetName(target: SshQuickTarget): string {
  const host = target.address.includes(':') ? `[${target.address}]` : target.address;
  const port = target.port === DEFAULT_PORT ? '' : `:${String(target.port)}`;
  return `${target.user === undefined ? '' : `${target.user}@`}${host}${port}`;
}

export function isQuickHostId(hostId: string): boolean {
  return hostId.startsWith(QUICK_PREFIX);
}

interface QuickHostsState {
  readonly targets: Readonly<Record<string, SshQuickTarget>>;
  /** The id for the server: the one it already has in this window, or a new one. */
  add: (target: SshQuickTarget) => string;
}

export const useQuickHostsStore = create<QuickHostsState>((set, get) => ({
  targets: {},
  add: (target) => {
    const name = quickTargetName(target);
    const known = Object.entries(get().targets).find(([, each]) => quickTargetName(each) === name)?.[0];
    if (known !== undefined) return known;
    const id = `${QUICK_PREFIX}${crypto.randomUUID()}`;
    set((state) => ({ targets: { ...state.targets, [id]: target } }));
    return id;
  },
}));

/** The one-off server a pane's host id stands for, if it is one. */
export function quickTargetOf(hostId: string): SshQuickTarget | undefined {
  return isQuickHostId(hostId) ? useQuickHostsStore.getState().targets[hostId] : undefined;
}

/** A one-off server's name as its tab and pane show it, or `undefined` for a saved host. */
export function quickHostName(hostId: string): string | undefined {
  const target = quickTargetOf(hostId);
  return target === undefined ? undefined : quickTargetName(target);
}
