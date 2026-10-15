import type {
  GroupEntryWire,
  HostEntryWire,
  HostsFileWire,
  IdentityWire,
  ResolvedHostWire,
  SshAuthWire,
  SshSettingsWire,
} from '../../../shared/ssh-wire.js';

/** The identities a file defines, in file order (#416). */
export function identitiesOf(file: HostsFileWire): readonly IdentityWire[] {
  return file.identities ?? [];
}

export function findIdentity(file: HostsFileWire, id: string): IdentityWire | undefined {
  return identitiesOf(file).find((identity) => identity.id === id);
}

/** Replaces the identity with the same id in place; a new id is appended. */
export function upsertIdentity(file: HostsFileWire, identity: IdentityWire): HostsFileWire {
  const list = identitiesOf(file);
  const next = list.some((i) => i.id === identity.id)
    ? list.map((i) => (i.id === identity.id ? identity : i))
    : [...list, identity];
  return { ...file, identities: next };
}

function withoutIdentity<T extends { ssh: SshSettingsWire }>(entry: T, id: string): T {
  if (entry.ssh.identity !== id) return entry;
  const { identity: dropped, ...ssh } = entry.ssh;
  void dropped;
  return { ...entry, ssh };
}

/**
 * Drops the identity and every `identity:` that names it. The hosts and groups keep their own settings, and
 * lose the user and sign-in the identity gave them.
 */
export function removeIdentity(file: HostsFileWire, id: string): HostsFileWire {
  const groups = (list: readonly GroupEntryWire[]): GroupEntryWire[] =>
    list.map((g) => ({
      ...withoutIdentity(g, id),
      groups: groups(g.groups),
      hosts: g.hosts.map((h) => withoutIdentity(h, id)),
    }));
  return {
    ...file,
    identities: identitiesOf(file).filter((i) => i.id !== id),
    groups: groups(file.groups),
    hosts: file.hosts.map((h) => withoutIdentity(h, id)),
  };
}

/** The hosts and groups whose own settings name the identity, by name, in file order: what a delete changes. */
export function identityReferences(file: HostsFileWire, id: string): string[] {
  const out: string[] = [];
  const visit = (groups: readonly GroupEntryWire[], hosts: readonly HostEntryWire[]): void => {
    for (const g of groups) {
      if (g.ssh.identity === id) out.push(g.name);
      visit(g.groups, g.hosts);
    }
    for (const h of hosts) if (h.ssh.identity === id) out.push(h.name);
  };
  visit(file.groups, file.hosts);
  return out;
}

const fromIdentity = (from: ResolvedHostWire['ssh']['user']['from'], id: string): boolean =>
  typeof from === 'object' && 'identity' in from && from.identity === id;

/** The hosts that sign in with the identity: their user or their sign-in comes from it. */
export function identityHosts(resolved: readonly ResolvedHostWire[], id: string): string[] {
  return resolved
    .filter((h) => fromIdentity(h.ssh.user.from, id) || fromIdentity(h.ssh.auth.from, id))
    .map((h) => h.name);
}

/** `base`, or `base-2`, `base-3`, …: the first id no identity uses. Identity ids are their own namespace. */
export function freeIdentityId(file: HostsFileWire, base: string): string {
  const taken = new Set(identitiesOf(file).map((i) => i.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${String(n)}`;
  return id;
}

/** "key deploy_key", "password web_pw", "SSH agent", or "no sign-in". */
export function authSummary(auth: SshAuthWire | undefined): string {
  if (auth === undefined) return 'no sign-in';
  return auth.kind === 'agent' ? 'SSH agent' : `${auth.kind === 'key' ? 'key' : 'password'} ${auth.secret}`;
}
