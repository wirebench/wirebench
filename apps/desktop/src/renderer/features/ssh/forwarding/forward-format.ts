import type { ResolvedForwardWire, ResolvedHostWire } from '../../../../shared/ssh-wire.js';

/**
 * Plain helpers for showing forwarding rules. The renderer does not import `@wirebench/ssh`, so
 * {@link isNetworkBind} mirrors the package's (a desktop test pins the two equal).
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True for any address other than `127.0.0.0/8`, `::1` and `localhost`: other machines can reach it. */
export function isNetworkBind(bind: string): boolean {
  if (bind === 'localhost' || bind === '::1') return false;
  const v4 = IPV4.exec(bind);
  return !(v4 !== null && v4.slice(1).every((part) => Number(part) <= 255) && bind.startsWith('127.'));
}

/** The key a forward is kept under in the store and named by in commands: `hostId/ruleId`. */
export function forwardKey(hostId: string, ruleId: string): string {
  return `${hostId}/${ruleId}`;
}

/** `local` → Local, `remote` → Remote, `dynamic` → Dynamic. */
export function typeWord(type: ResolvedForwardWire['rule']['type']): string {
  return type === 'local' ? 'Local' : type === 'remote' ? 'Remote' : 'Dynamic';
}

/** `[::1]` for an IPv6 literal, so `address:port` reads unambiguously. */
function hostPart(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

/** `bind:port`, with an IPv6 bind in brackets. */
export function listenAddress(bind: string, port: number): string {
  return `${hostPart(bind)}:${String(port)}`;
}

/** `bind:port → target`, or `→ SOCKS` for a dynamic rule; `port` is the one it runs on when that differs. */
export function routeOf(rule: ResolvedForwardWire['rule'], port = rule.port): string {
  const target =
    rule.type === 'dynamic' || rule.target === undefined
      ? 'SOCKS'
      : `${hostPart(rule.target.host)}:${String(rule.target.port)}`;
  return `${listenAddress(rule.bind, port)} → ${target}`;
}

/** The name of where a rule came from, or which level switched it off: the host's name or the group's. */
export function levelName(
  level: ResolvedForwardWire['from'],
  host: Pick<ResolvedHostWire, 'name'>,
  groupName: (id: string) => string,
): string {
  return level === 'host' ? host.name : groupName(level.group);
}
