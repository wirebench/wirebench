import type { ResolvedHostWire, SshProtocolWire } from '@shared/ssh-wire.js';
import { useHostsStore } from './hosts-store.js';

/** Telnet's port when a host sets none (#425), as main resolves it. */
export const TELNET_PORT = 23;

/** A host's protocol after inheritance; SSH for one main has not resolved (a quick connect). */
export const protocolOf = (host: ResolvedHostWire | undefined): SshProtocolWire => host?.ssh.protocol?.value ?? 'ssh';

/**
 * Whether the host is reached over SSH itself: only then do Files, port forwarding, keys, the agent and the
 * `ssh` command apply. A Mosh host signs in over SSH, so it has them; a Telnet host (#425) or a serial console
 * (#426) does not.
 */
export const hasSshFeatures = (protocol: SshProtocolWire): boolean => protocol === 'ssh' || protocol === 'mosh';

/**
 * "Telnet · admin@10.1.1.1" (#688): a Telnet host's target on its card, row and draft card, leaving out what
 * is not set and Telnet's own port.
 */
export function telnetTargetText(address: string, user: string | undefined, port: number | undefined): string {
  const login = user === undefined || user === '' ? '' : `${user}@`;
  return `Telnet · ${login}${address}${port === undefined || port === TELNET_PORT ? '' : `:${String(port)}`}`;
}

/** The protocol of `hostId` as the hosts store has it now. */
export function hostProtocol(hostId: string): SshProtocolWire {
  return protocolOf(useHostsStore.getState().resolved.find((h) => h.id === hostId));
}

/** {@link hostProtocol}, re-rendering when it changes. */
export function useHostProtocol(hostId: string): SshProtocolWire {
  return useHostsStore((s) => protocolOf(s.resolved.find((h) => h.id === hostId)));
}
