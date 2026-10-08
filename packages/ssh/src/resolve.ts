import { SshModelError } from './errors.js';
import { walk } from './tree.js';
import type { GroupEntry, HostEntry, HostsFile, SshAuth, SshSettings } from './model.js';

export type Provenance<T> = { readonly value: T; readonly from: 'host' | 'default' | { readonly group: string } };

export interface ResolvedHost {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly tags: readonly string[];
  /** Group ids, root first. */
  readonly path: readonly string[];
  readonly ssh: {
    readonly user: Provenance<string | undefined>;
    readonly port: Provenance<number>;
    readonly auth: Provenance<SshAuth | undefined>;
    readonly jump: Provenance<string | undefined>;
    readonly keepAlive: Provenance<number>;
    readonly connectTimeout: Provenance<number>;
  };
  readonly incomplete?: { readonly field: 'user' | 'auth' };
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
    ssh,
    ...(incomplete ? { incomplete } : {}),
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
