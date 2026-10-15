import { SshModelError } from './errors.js';
import { defaultBind, isOffForm, parseTarget } from './forward-rules.js';
import { walk } from './tree.js';
import type { ForwardEntry, ForwardType } from './forward-rules.js';
import type { MoshSettings, SessionProtocol } from './host-mosh.js';
import type { GroupEntry, HostEntry, HostsFile, IdentityEntry, SshAuth, SshProxy, SshSettings } from './model.js';

/**
 * `preferences` is the caller's {@link SshDefaults} (Preferences → SSH in the app); `default` is the built-in
 * value, or no value at all.
 */
export type Provenance<T> = {
  readonly value: T;
  readonly from: 'host' | 'preferences' | 'default' | { readonly group: string };
};
/** `user` and `auth` may also come from the identity a level names (#416). */
export type LoginProvenance<T> = {
  readonly value: T;
  readonly from: Provenance<T>['from'] | { readonly identity: string };
};

export interface ForwardRule {
  readonly id: string;
  readonly type: ForwardType;
  readonly port: number;
  /** The default filled in. */
  readonly bind: string;
  readonly target?: { readonly host: string; readonly port: number };
  readonly autoStart: boolean;
}
export type ForwardFrom = 'host' | { readonly group: string };
export interface ResolvedForward {
  readonly rule: ForwardRule;
  readonly from: ForwardFrom;
  readonly enabled: boolean;
  /** The level whose off form (or `enabled: false`) switched it off. */
  readonly offBy?: ForwardFrom;
}

/** A variable after inheritance: its value as written (literal or a `${secret:NAME}` token) and its level. */
export interface ResolvedEnvVar {
  readonly name: string;
  readonly value: string;
  readonly from: ForwardFrom;
}

export interface ResolvedHost {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly tags: readonly string[];
  /** Group ids, root first. */
  readonly path: readonly string[];
  /** Whether a run touching this host confirms first; nearest wins, `false` by default. */
  readonly protected: Provenance<boolean>;
  readonly ssh: {
    /** The nearest `identity:` (#416); it supplies `user` and `auth` where its own level sets neither. */
    readonly identity: Provenance<string | undefined>;
    readonly user: LoginProvenance<string | undefined>;
    readonly port: Provenance<number>;
    readonly auth: LoginProvenance<SshAuth | undefined>;
    readonly jump: Provenance<string | undefined>;
    readonly keepAlive: Provenance<number>;
    readonly connectTimeout: Provenance<number>;
    /** Whether the target's shell forwards the local agent; never a jump host's. */
    readonly forwardAgent: Provenance<boolean>;
    /** `ssh` by default; `mosh` bootstraps a mosh server over SSH, then runs over UDP (#419). */
    readonly protocol: Provenance<SessionProtocol>;
    /** The nearest level's block, whole; read only when the protocol is `mosh`. */
    readonly mosh: Provenance<MoshSettings | undefined>;
    /**
     * The proxy this host is dialled through when it is the first hop; `undefined` connects directly (a
     * nearer `proxy: false` gives that, with its level as `from`). A jump host's own setting is the one used
     * for it, never the target's.
     */
    readonly proxy: Provenance<SshProxy | undefined>;
  };
  readonly incomplete?: { readonly field: 'user' | 'auth' };
  /** Merged by id root to leaf: a nearer rule replaces a farther one whole; an off form switches it off. */
  readonly forwards: readonly ResolvedForward[];
  /** Merged by name root to leaf: a nearer level wins per variable; a re-set name keeps its first position. */
  readonly env: readonly ResolvedEnvVar[];
  /** Nearest level wins per field; `default` (value unset) means the app's Terminal preferences apply. */
  readonly terminal: {
    readonly scheme: Provenance<string | undefined>;
    readonly fontSize: Provenance<number | undefined>;
  };
}

const DEFAULTS = { port: 22, keepAlive: 15, connectTimeout: 20, forwardAgent: false, protocol: 'ssh' } as const;

/**
 * The last level a setting resolves to, after the host, its groups and their identities (#571): the app passes
 * its Preferences → SSH. A field left unset falls through to the built-in value (no user at all).
 */
export interface SshDefaults {
  readonly user?: string;
  readonly keepAlive?: number;
  readonly connectTimeout?: number;
}

interface Located {
  readonly host: HostEntry;
  readonly chain: readonly GroupEntry[];
  readonly identities: ReadonlyMap<string, IdentityEntry>;
  readonly defaults: SshDefaults;
}

/** `code` tells the asked-for host (`ssh-host-unknown`) from a hop on its jump chain (`ssh-jump-unknown`). */
function locate(
  file: HostsFile,
  id: string,
  defaults: SshDefaults = {},
  code: 'ssh-host-unknown' | 'ssh-jump-unknown' = 'ssh-host-unknown',
): Located {
  const groups = new Map<string, GroupEntry>();
  const items = walk(file);
  for (const item of items) if (item.kind === 'group') groups.set(item.entry.id, item.entry as GroupEntry);
  const found = items.find((item) => item.kind === 'host' && item.entry.id === id);
  if (!found) throw new SshModelError(code, `"${id}" is not a host`, { id });
  return {
    host: found.entry as HostEntry,
    chain: found.path.map((gid) => groups.get(gid) as GroupEntry),
    identities: new Map((file.identities ?? []).map((i) => [i.id, i])),
    defaults,
  };
}

/**
 * Nearest level first; at each level its own value wins, then the identity it names. An identity that
 * leaves the field unset passes on to the levels further out; past them the default user (`preferences`),
 * and none at all means no value (`default`).
 */
function pickLogin<K extends 'user' | 'auth'>(located: Located, key: K): LoginProvenance<SshSettings[K]> {
  const levels: Array<{ ssh: SshSettings; from: Provenance<unknown>['from'] }> = [
    { ssh: located.host.ssh, from: 'host' },
    ...[...located.chain].reverse().map((g) => ({ ssh: g.ssh, from: { group: g.id } })),
  ];
  for (const { ssh, from } of levels) {
    if (ssh[key] !== undefined) return { value: ssh[key], from };
    const identity = ssh.identity === undefined ? undefined : located.identities.get(ssh.identity);
    if (identity?.[key] !== undefined) return { value: identity[key], from: { identity: identity.id } };
  }
  if (key === 'user' && located.defaults.user !== undefined) {
    return { value: located.defaults.user as SshSettings[K], from: 'preferences' };
  }
  return { value: undefined, from: 'default' };
}

function pick<K extends keyof SshSettings>(
  located: Located,
  key: K,
  fallback: SshSettings[K],
): Provenance<SshSettings[K]> {
  if (located.host.ssh[key] !== undefined) return { value: located.host.ssh[key], from: 'host' };
  for (let i = located.chain.length - 1; i >= 0; i -= 1) {
    const group = located.chain[i] as GroupEntry;
    if (group.ssh[key] !== undefined) return { value: group.ssh[key], from: { group: group.id } };
  }
  const { defaults } = located;
  const preferred =
    key === 'keepAlive' ? defaults.keepAlive : key === 'connectTimeout' ? defaults.connectTimeout : undefined;
  if (preferred !== undefined) return { value: preferred as SshSettings[K], from: 'preferences' };
  return { value: fallback, from: 'default' };
}

function pickProtected(located: Located): Provenance<boolean> {
  if (located.host.protected !== undefined) return { value: located.host.protected, from: 'host' };
  for (let i = located.chain.length - 1; i >= 0; i -= 1) {
    const group = located.chain[i] as GroupEntry;
    if (group.protected !== undefined) return { value: group.protected, from: { group: group.id } };
  }
  return { value: false, from: 'default' };
}

function pickTerminal<K extends 'scheme' | 'fontSize'>(
  located: Located,
  key: K,
): Provenance<NonNullable<GroupEntry['terminal']>[K]> {
  const own = located.host.terminal?.[key];
  if (own !== undefined) return { value: own, from: 'host' };
  for (let i = located.chain.length - 1; i >= 0; i -= 1) {
    const group = located.chain[i] as GroupEntry;
    const value = group.terminal?.[key];
    if (value !== undefined) return { value, from: { group: group.id } };
  }
  return { value: undefined, from: 'default' };
}

/** Walks root to leaf; a re-set id keeps its first position, so new ids append. */
function resolveForwards(located: Located): ResolvedForward[] {
  const levels: Array<{ entries: readonly ForwardEntry[]; from: ForwardFrom }> = [
    ...located.chain.map((g) => ({ entries: g.forwards ?? [], from: { group: g.id } })),
    { entries: located.host.forwards ?? [], from: 'host' as const },
  ];
  const out = new Map<string, ResolvedForward>();
  for (const { entries, from } of levels) {
    for (const entry of entries) {
      if (isOffForm(entry)) {
        const above = out.get(entry.id);
        if (above) out.set(entry.id, { rule: above.rule, from: above.from, enabled: false, offBy: from });
        continue;
      }
      const rule: ForwardRule = {
        id: entry.id,
        type: entry.type,
        port: entry.port,
        bind: entry.bind ?? defaultBind(entry.type),
        ...(entry.target === undefined ? {} : { target: parseTarget(entry.target) }),
        autoStart: entry.autoStart === true,
      };
      const enabled = entry.enabled !== false;
      out.set(entry.id, { rule, from, enabled, ...(enabled ? {} : { offBy: from }) });
    }
  }
  return [...out.values()];
}

function resolveEnv(located: Located): ResolvedEnvVar[] {
  const levels: Array<{ env: Readonly<Record<string, string>>; from: ForwardFrom }> = [
    ...located.chain.map((g) => ({ env: g.env ?? {}, from: { group: g.id } })),
    { env: located.host.env ?? {}, from: 'host' as const },
  ];
  const out = new Map<string, ResolvedEnvVar>();
  for (const { env, from } of levels) {
    for (const [name, value] of Object.entries(env)) out.set(name, { name, value, from });
  }
  return [...out.values()];
}

/** `false` (connect directly) resolves to no proxy, keeping the level that said so. */
function proxyOf(picked: Provenance<SshSettings['proxy']>): Provenance<SshProxy | undefined> {
  return picked.value === false ? { value: undefined, from: picked.from } : { value: picked.value, from: picked.from };
}

/**
 * Merged values, nearest wins; `auth` is replaced whole, never merged, and `user` and `auth` take the
 * identities into account. No defaults, no provenance.
 */
export function resolveSettings(file: HostsFile, id: string): SshSettings {
  const located = locate(file, id);
  const out: Record<string, unknown> = {};
  for (const key of ['user', 'auth'] as const) {
    const { value } = pickLogin(located, key);
    if (value !== undefined) out[key] = value;
  }
  for (const key of [
    'identity',
    'port',
    'jump',
    'keepAlive',
    'connectTimeout',
    'forwardAgent',
    'protocol',
    'mosh',
    'proxy',
  ] as const) {
    const { value } = pick(located, key, undefined);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** @throws SshModelError `ssh-host-unknown` when `id` is not a host. */
export function resolveHost(file: HostsFile, id: string, defaults?: SshDefaults): ResolvedHost {
  return resolveLocated(locate(file, id, defaults));
}

function resolveLocated(located: Located): ResolvedHost {
  const ssh = {
    identity: pick(located, 'identity', undefined),
    user: pickLogin(located, 'user'),
    port: pick(located, 'port', DEFAULTS.port) as Provenance<number>,
    auth: pickLogin(located, 'auth'),
    jump: pick(located, 'jump', undefined),
    keepAlive: pick(located, 'keepAlive', DEFAULTS.keepAlive) as Provenance<number>,
    connectTimeout: pick(located, 'connectTimeout', DEFAULTS.connectTimeout) as Provenance<number>,
    forwardAgent: pick(located, 'forwardAgent', DEFAULTS.forwardAgent) as Provenance<boolean>,
    protocol: pick(located, 'protocol', DEFAULTS.protocol) as Provenance<SessionProtocol>,
    mosh: pick(located, 'mosh', undefined),
    proxy: proxyOf(pick(located, 'proxy', undefined)),
  };
  const incomplete =
    ssh.user.value === undefined
      ? { field: 'user' as const }
      : ssh.auth.value === undefined
        ? { field: 'auth' as const }
        : undefined;
  return {
    id: located.host.id,
    name: located.host.name,
    address: located.host.address,
    tags: located.host.tags,
    path: located.chain.map((g) => g.id),
    protected: pickProtected(located),
    ssh,
    ...(incomplete ? { incomplete } : {}),
    forwards: resolveForwards(located),
    env: resolveEnv(located),
    terminal: { scheme: pickTerminal(located, 'scheme'), fontSize: pickTerminal(located, 'fontSize') },
  };
}

/** Every host, in document order. */
export function listResolvedHosts(file: HostsFile, defaults?: SshDefaults): readonly ResolvedHost[] {
  return walk(file)
    .filter((i) => i.kind === 'host')
    .map((i) => resolveHost(file, i.entry.id, defaults));
}

/**
 * `[outermost hop, …, target]`.
 * @throws SshModelError `ssh-host-unknown` when `id` is not a host; `ssh-jump-unknown` when a hop is not.
 */
export function jumpChain(file: HostsFile, id: string, defaults?: SshDefaults): readonly ResolvedHost[] {
  const chain: ResolvedHost[] = [];
  let current: string | undefined = id;
  while (current !== undefined && !chain.some((h) => h.id === current)) {
    const host = resolveLocated(
      locate(file, current, defaults, current === id ? 'ssh-host-unknown' : 'ssh-jump-unknown'),
    );
    chain.unshift(host);
    current = host.ssh.jump.value;
  }
  return chain;
}
