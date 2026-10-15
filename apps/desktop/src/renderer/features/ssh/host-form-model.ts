import type {
  GroupEntryWire,
  HostsFileWire,
  IdentityWire,
  SshAuthWire,
  SshSettingsWire,
} from '../../../shared/ssh-wire.js';
import { SSH_DEFAULTS } from '../../../shared/ssh-defaults.js';
import { ancestorsOf, findGroup } from './hosts-store.js';
import type { Provenance } from './inherited-field.js';

/** Where `field` comes from for an entry inside `chain` (outermost group first): nearest group that sets it. */
export function inheritedFrom<K extends keyof SshSettingsWire>(
  chain: readonly GroupEntryWire[],
  field: K,
): Provenance<NonNullable<SshSettingsWire[K]>> {
  for (const g of [...chain].reverse()) {
    const value = g.ssh[field];
    if (value !== undefined) return { value, from: { group: g.name } };
  }
  const fallback = (SSH_DEFAULTS as Record<string, number>)[field];
  return { value: fallback as NonNullable<SshSettingsWire[K]> | undefined, from: 'default' };
}

/**
 * Where `user` or `auth` comes from for an entry naming identity `own` inside `chain` (#416), as main resolves
 * it: the entry's own identity first, then each group nearest first, its own value before the identity it
 * names. An identity leaving the field unset passes on outwards; nothing anywhere is `default` with no value.
 */
export function inheritedLogin<K extends 'user' | 'auth'>(
  identities: readonly IdentityWire[] | undefined,
  chain: readonly GroupEntryWire[],
  own: string | undefined,
  field: K,
): Provenance<NonNullable<SshSettingsWire[K]>> {
  const viaIdentity = (id: string | undefined): Provenance<NonNullable<SshSettingsWire[K]>> | undefined => {
    const identity = id === undefined ? undefined : identities?.find((i) => i.id === id);
    const value = identity?.[field] as NonNullable<SshSettingsWire[K]> | undefined;
    return identity === undefined || value === undefined ? undefined : { value, from: { identity: identity.name } };
  };
  const ownIdentity = viaIdentity(own);
  if (ownIdentity !== undefined) return ownIdentity;
  for (const g of [...chain].reverse()) {
    const value = g.ssh[field];
    if (value !== undefined) return { value, from: { group: g.name } };
    const fromGroupIdentity = viaIdentity(g.ssh.identity);
    if (fromGroupIdentity !== undefined) return fromGroupIdentity;
  }
  return { value: undefined, from: 'default' };
}

/** Whether the enclosing groups make an entry protected: the nearest group that says, else off by default. */
export function inheritedProtected(chain: readonly GroupEntryWire[]): Provenance<boolean> {
  for (const g of [...chain].reverse()) {
    if (g.protected !== undefined) return { value: g.protected, from: { group: g.name } };
  }
  return { value: false, from: 'default' };
}

/** The groups an entry placed in `groupId` sits under, outermost first; empty at the top level. */
export function chainOf(file: HostsFileWire, groupId: string | undefined): GroupEntryWire[] {
  if (groupId === undefined) return [];
  const group = findGroup(file, groupId);
  return group === undefined ? [] : [...ancestorsOf(file, 'group', groupId), group];
}

/**
 * The group a new entry goes in: the one the dialog was opened from, else the group the Hosts tab is
 * narrowed to. A group no longer in the file means the top level.
 */
export function initialGroup(
  file: HostsFileWire,
  opened: string | undefined,
  groupFilter: string | undefined,
): string | undefined {
  const wanted = opened ?? groupFilter;
  return wanted !== undefined && findGroup(file, wanted) !== undefined ? wanted : undefined;
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'host'
  );
}

/**
 * The secret an inline password is stored as: `<id>_password` (`<id>_proxy_password` for the proxy's), made a valid secret name (ids may hold `-`),
 * and numbered past any name already taken so another entry's password is never overwritten.
 */
export function passwordSecretName(id: string, taken: readonly string[], suffix = 'password'): string {
  const safe = id.replace(/[^A-Za-z0-9_]/g, '_');
  const base = `${/^[A-Za-z_]/.test(safe) ? safe : `_${safe}`}_${suffix}`;
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}_${String(n)}`;
  return name;
}

/** An override left empty is not saved: it would be a literal empty string in the file. */
export function dropEmpty(ssh: SshSettingsWire): SshSettingsWire {
  return Object.fromEntries(Object.entries(ssh).filter(([, v]) => v !== ''));
}

export function withField(ssh: SshSettingsWire, key: keyof SshSettingsWire, value: unknown): SshSettingsWire {
  const { [key]: dropped, ...rest } = ssh;
  void dropped;
  return value === undefined ? rest : { ...rest, [key]: value };
}

/** What the form knows when Save is pressed; `user` and `auth` are this entry's own values (undefined inherits). */
export interface SaveCheck {
  readonly isHost: boolean;
  /**
   * Whether a user and a way to sign in are required: for a new host, since a connect refuses one without.
   * Editing does not ask for them, so an older entry stays editable.
   */
  readonly needsLogin: boolean;
  readonly name: string;
  readonly address: string;
  readonly user: string | undefined;
  readonly inheritedUser: string | undefined;
  readonly auth: SshAuthWire | undefined;
  readonly inheritedAuth: SshAuthWire | undefined;
  /** The password typed inline, stored as a secret on Save. */
  readonly password: string;
  /** Problems the Advanced sections report (forwarding, environment, terminal). */
  readonly sectionProblems: readonly string[];
}

/**
 * Why Save is disabled, one line per gap, in the order the form shows the fields; empty when it can save.
 * A group may leave every setting to its hosts.
 */
export function missingFields(check: SaveCheck): string[] {
  const out: string[] = [];
  if (check.name.trim() === '') out.push('Name is required');
  if (check.isHost && check.address.trim() === '') out.push('Address is required');
  const user = check.user === undefined || check.user === '' ? check.inheritedUser : check.user;
  if (check.needsLogin && (user === undefined || user.trim() === '')) out.push('User is required');
  const auth = check.auth ?? check.inheritedAuth;
  if (check.auth?.kind === 'password' && check.auth.secret === '' && check.password === '') {
    out.push('Password is required');
  } else if (check.auth?.kind === 'key' && check.auth.secret === '') {
    out.push('Choose a private key');
  } else if (check.needsLogin && auth === undefined) {
    out.push('Choose how to sign in');
  }
  return [...out, ...check.sectionProblems];
}
