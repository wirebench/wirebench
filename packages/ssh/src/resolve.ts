import { SshModelError } from './errors.js';
import { defaultBind, isOffForm, parseTarget } from './forward-rules.js';
import { walk } from './tree.js';
import type { ForwardEntry, ForwardType } from './forward-rules.js';
import type { GroupEntry, HostEntry, HostsFile, SshAuth, SshSettings } from './model.js';

export type Provenance<T> = { readonly value: T; readonly from: 'host' | 'default' | { readonly group: string } };

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
    readonly user: Provenance<string | undefined>;
    readonly port: Provenance<number>;
    readonly auth: Provenance<SshAuth | undefined>;
    readonly jump: Provenance<string | undefined>;
    readonly keepAlive: Provenance<number>;
    readonly connectTimeout: Provenance<number>;
  };
  readonly incomplete?: { readonly field: 'user' | 'auth' };
  /** Merged by id root to leaf: a nearer rule replaces a farther one whole; an off form switches it off. */
  readonly forwards: readonly ResolvedForward[];
  /** Merged by name root to leaf: a nearer level wins per variable; a re-set name keeps its first position. */
  readonly env: readonly ResolvedEnvVar[];
}

const DEFAULTS = { port: 22, keepAlive: 15, connectTimeout: 20 } as const;

interface Located {
  readonly host: HostEntry;
  readonly chain: readonly GroupEntry[];
}

/** `code` tells the asked-for host (`ssh-host-unknown`) from a hop on its jump chain (`ssh-jump-unknown`). */
function locate(
  file: HostsFile,
  id: string,
  code: 'ssh-host-unknown' | 'ssh-jump-unknown' = 'ssh-host-unknown',
): Located {
  const groups = new Map<string, GroupEntry>();
  const items = walk(file);
  for (const item of items) if (item.kind === 'group') groups.set(item.entry.id, item.entry as GroupEntry);
  const found = items.find((item) => item.kind === 'host' && item.entry.id === id);
  if (!found) throw new SshModelError(code, `"${id}" is not a host`, { id });
  return { host: found.entry as HostEntry, chain: found.path.map((gid) => groups.get(gid) as GroupEntry) };
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

/** Merged values, nearest wins; `auth` is replaced whole, never merged. No defaults, no provenance. */
export function resolveSettings(file: HostsFile, id: string): SshSettings {
  const located = locate(file, id);
  const out: Record<string, unknown> = {};
  for (const key of ['user', 'port', 'jump', 'auth', 'keepAlive', 'connectTimeout'] as const) {
    const { value } = pick(located, key, undefined);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** @throws SshModelError `ssh-host-unknown` when `id` is not a host. */
export function resolveHost(file: HostsFile, id: string): ResolvedHost {
  return resolveLocated(locate(file, id));
}

function resolveLocated(located: Located): ResolvedHost {
  const ssh = {
    user: pick(located, 'user', undefined),
    port: pick(located, 'port', DEFAULTS.port) as Provenance<number>,
    auth: pick(located, 'auth', undefined),
    jump: pick(located, 'jump', undefined),
    keepAlive: pick(located, 'keepAlive', DEFAULTS.keepAlive) as Provenance<number>,
    connectTimeout: pick(located, 'connectTimeout', DEFAULTS.connectTimeout) as Provenance<number>,
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
  };
}

/** Every host, in document order. */
export function listResolvedHosts(file: HostsFile): readonly ResolvedHost[] {
  return walk(file)
    .filter((i) => i.kind === 'host')
    .map((i) => resolveHost(file, i.entry.id));
}

/**
 * `[outermost hop, …, target]`.
 * @throws SshModelError `ssh-host-unknown` when `id` is not a host; `ssh-jump-unknown` when a hop is not.
 */
export function jumpChain(file: HostsFile, id: string): readonly ResolvedHost[] {
  const chain: ResolvedHost[] = [];
  let current: string | undefined = id;
  while (current !== undefined && !chain.some((h) => h.id === current)) {
    const host = resolveLocated(locate(file, current, current === id ? 'ssh-host-unknown' : 'ssh-jump-unknown'));
    chain.unshift(host);
    current = host.ssh.jump.value;
  }
  return chain;
}
