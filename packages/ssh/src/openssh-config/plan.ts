import { SshModelError } from '../errors.js';
import type { HostsFile } from '../model.js';
import { listResolvedHosts, resolveSettings } from '../resolve.js';
import { walk } from '../tree.js';
import { allHosts, concreteAliases, effective, type Effective } from './evaluate.js';
import { displayPath, pathsFor, type SshConfigDocument } from './load.js';
import type { SshConfigLine, SshConfigProblem } from './types.js';

/** How a planned host or the group authenticates: the agent, or whatever the user picks for a key row. */
export type PlannedAuth = { readonly kind: 'agent' } | { readonly kind: 'key'; readonly ref: string };

/** The fields a host or the group writes; a host leaves out what equals the group's. */
export interface PlannedSettings {
  readonly user?: string;
  readonly port?: number;
  readonly jump?: string;
  readonly auth?: PlannedAuth;
  readonly keepAlive?: number;
  readonly connectTimeout?: number;
}

export interface PlannedHost {
  /** The `Host` alias, or the hop as written for a host created for a jump. */
  readonly alias: string;
  readonly id: string;
  /** The plain slug, when it had to be suffixed to be unique. */
  readonly idChangedFrom?: string;
  readonly status: 'new' | 'duplicate' | 'created-for-jump' | 'skipped';
  readonly duplicateOf?: string;
  readonly reason?: string;
  readonly address: string;
  readonly ssh: PlannedSettings;
}

export interface PlannedKey {
  /** Opaque and stable within the plan; a renderer names keys by it, never by path. */
  readonly ref: string;
  /** Absolute. Stays in the main process. */
  readonly path: string;
  /** `~/.ssh/id_ed25519`, for the dialog. */
  readonly display: string;
  /** Ids of the hosts (or the group) that use it. */
  readonly hosts: readonly string[];
  readonly proposedSecret: string;
}

export interface SshConfigReport {
  /** Lines and files that could not be read. */
  readonly problems: readonly SshConfigProblem[];
  /** Lines not carried across: keyword, file and line, never the value. */
  readonly skipped: readonly { file: string; line: number; keyword: string; why: string }[];
  /** Options with no meaning in Wirebench, counted. */
  readonly ignored: readonly { keyword: string; count: number }[];
  readonly notes: readonly string[];
}

export interface SshConfigImportPlan {
  readonly group: { readonly id: string; readonly name: string; readonly ssh: PlannedSettings };
  readonly hosts: readonly PlannedHost[];
  readonly keys: readonly PlannedKey[];
  readonly report: SshConfigReport;
}

export interface SshConfigImportInput {
  readonly document: SshConfigDocument;
  readonly existing: HostsFile;
  /** Secret names that already resolve in the workspace; a proposal never reuses one. */
  readonly existingSecretNames: readonly string[];
}

export const DEFAULT_GROUP_NAME = 'SSH config';
const GROUP_ID = 'ssh-config';

const MAPPED = new Set([
  'host',
  'match',
  'hostname',
  'port',
  'user',
  'proxyjump',
  'proxycommand',
  'identityfile',
  'serveraliveinterval',
  'connecttimeout',
]);
/** Options with no meaning for Wirebench: counted, not reported line by line. */
export const IGNORED_KEYWORDS = new Set([
  'identitiesonly',
  'identityagent',
  'addkeystoagent',
  'usekeychain',
  'serveralivecountmax',
  'stricthostkeychecking',
  'userknownhostsfile',
  'hostkeyalias',
  'loglevel',
  'compression',
  'preferredauthentications',
]);

/** `Web.Prod_1` → `web-prod-1`; nothing usable → `host`. */
export function slugId(alias: string): string {
  return (
    alias
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'host'
  );
}

function unique(base: string, taken: Set<string>, joiner: string): string {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}${joiner}${n}`;
  taken.add(candidate);
  return candidate;
}

/** `%h` → the alias, `%%` → `%`; `undefined` when another `%` token is left. */
function expandTokens(value: string, tokens: Readonly<Record<string, string>>): string | undefined {
  let failed = false;
  const out = value.replace(/%(.)/g, (_, ch: string) => {
    if (ch === '%') return '%';
    const replacement = tokens[ch];
    if (replacement === undefined) failed = true;
    return replacement ?? '';
  });
  return failed ? undefined : out;
}

const PROXY_W = (args: readonly string[]): string | undefined => {
  if (args[0] !== 'ssh') return undefined;
  const rest = args.slice(1).filter((a) => a !== '-q');
  return rest.length === 3 && rest[0] === '-W' && rest[1] === '%h:%p' ? rest[2] : undefined;
};

/** `[user@]host[:port]` or `[user@][v6]:port`; `undefined` for anything else (an `ssh://` URI). */
function parseHop(hop: string): { user?: string; host: string; port?: number } | undefined {
  if (hop.includes('://')) return undefined;
  const at = hop.lastIndexOf('@');
  const user = at === -1 ? undefined : hop.slice(0, at);
  const rest = at === -1 ? hop : hop.slice(at + 1);
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  const plain = /^([^:[\]]+)(?::(\d+))?$/.exec(rest);
  const match = v6 ?? plain;
  if (!match?.[1] || user === '') return undefined;
  const port = match[2] === undefined ? undefined : Number(match[2]);
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;
  return { host: match[1], ...(user === undefined ? {} : { user }), ...(port === undefined ? {} : { port }) };
}

interface Mapped {
  readonly address?: string;
  readonly reason?: string;
  readonly user?: string;
  readonly port?: number;
  readonly keepAlive?: number;
  readonly connectTimeout?: number;
  /** The hops as written, outermost first; `[]` for none. */
  readonly hops: readonly string[];
  readonly identity?: string;
}

const intArg = (line: SshConfigLine | undefined, min: number, max: number): number | undefined => {
  const raw = line?.args[0];
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= min && value <= max ? value : undefined;
};

/** Turns one alias's (or the all-hosts) effective settings into fields; notes what could not be used. */
function mapEffective(
  eff: Effective,
  alias: string | undefined,
  home: string,
  note: (message: string) => void,
): Mapped {
  const who = alias === undefined ? 'Host *' : alias;
  const out: { -readonly [K in keyof Mapped]: Mapped[K] } = { hops: [] };

  const hostName = eff.values.get('hostname')?.args[0];
  if (alias !== undefined) {
    if (hostName === undefined) out.address = alias;
    else {
      const address = expandTokens(hostName, { h: alias });
      if (address === undefined) out.reason = 'HostName uses a % token Wirebench cannot expand';
      else out.address = address;
    }
  }

  const user = eff.values.get('user')?.args[0];
  if (user !== undefined) {
    const expanded = expandTokens(user, {});
    if (expanded === undefined) note(`${who}: User uses a % token Wirebench cannot expand; not imported`);
    else out.user = expanded;
  }

  const port = intArg(eff.values.get('port'), 1, 65535);
  if (port !== undefined) out.port = port;
  else if (eff.values.has('port')) note(`${who}: Port is not a number from 1 to 65535; not imported`);

  const keepAlive = intArg(eff.values.get('serveraliveinterval'), 0, 2 ** 31 - 1);
  if (keepAlive !== undefined) out.keepAlive = keepAlive;

  const timeout = intArg(eff.values.get('connecttimeout'), 1, 2 ** 31 - 1);
  if (timeout !== undefined) out.connectTimeout = timeout;

  // ProxyJump and ProxyCommand exclude each other: the first one obtained wins, as in `ssh`.
  const keys = [...eff.values.keys()];
  const jumpAt = keys.indexOf('proxyjump');
  const commandAt = keys.indexOf('proxycommand');
  if (jumpAt !== -1 && (commandAt === -1 || jumpAt < commandAt)) {
    const value = eff.values.get('proxyjump')?.args[0] ?? 'none';
    out.hops = value.toLowerCase() === 'none' ? [] : value.split(',');
  } else if (commandAt !== -1) {
    const line = eff.values.get('proxycommand') as SshConfigLine;
    const hop = PROXY_W(line.args);
    if (hop !== undefined) out.hops = [hop];
  }

  const [first, ...more] = eff.identityFiles;
  if (first?.args[0] !== undefined) {
    const paths = pathsFor(home);
    const raw = first.args[0];
    const tilde = raw === '~' ? home : raw.startsWith('~/') ? paths.join(home, raw.slice(2)) : raw;
    const expanded = expandTokens(tilde, { d: home });
    if (expanded === undefined || !paths.isAbsolute(expanded)) {
      note(`${who}: IdentityFile ${raw} could not be resolved to a file; the host uses the group's authentication`);
    } else {
      out.identity = expanded;
    }
    if (more.length > 0) note(`${who}: only the first IdentityFile is used; ${more.length} more not carried`);
  }
  return out;
}

function reportLines(doc: SshConfigDocument): Pick<SshConfigReport, 'skipped' | 'ignored'> {
  const skipped: { file: string; line: number; keyword: string; why: string }[] = [];
  const ignored = new Map<string, number>();
  for (const block of doc.blocks) {
    if (block.kind === 'match') {
      skipped.push({
        ...block.at,
        keyword: 'match',
        why: `Match block not applied (${block.lines.length} line${block.lines.length === 1 ? '' : 's'})`,
      });
      continue;
    }
    for (const line of block.lines) {
      if (IGNORED_KEYWORDS.has(line.keyword)) ignored.set(line.keyword, (ignored.get(line.keyword) ?? 0) + 1);
      else if (!MAPPED.has(line.keyword)) {
        skipped.push({ file: line.file, line: line.line, keyword: line.keyword, why: 'not imported' });
      } else if (line.keyword === 'proxycommand' && line.args[0]?.toLowerCase() !== 'none' && !PROXY_W(line.args)) {
        skipped.push({
          file: line.file,
          line: line.line,
          keyword: line.keyword,
          why: 'not imported; the host will probably not connect the way it does today',
        });
      }
    }
  }
  return { skipped, ignored: [...ignored].map(([keyword, count]) => ({ keyword, count })) };
}

const sameAuth = (a: PlannedAuth | undefined, b: PlannedAuth | undefined): boolean =>
  a?.kind === b?.kind && (a?.kind !== 'key' || a.ref === (b as { ref: string }).ref);

/**
 * What importing `document` into `existing` would do. Pure: reads no file, writes nothing. Every key row
 * starts at the SSH agent; the caller asks the user before any key is read.
 * @throws SshModelError `ssh-config-empty` when the file names no host.
 */
export function planSshConfigImport(input: SshConfigImportInput): SshConfigImportPlan {
  const { document: doc, existing } = input;
  const aliases = concreteAliases(doc);
  if (aliases.length === 0) throw new SshModelError('ssh-config-empty', 'The SSH config names no host to import');

  const notes: string[] = [...doc.notes];
  const note = (message: string): void => {
    if (!notes.includes(message)) notes.push(message);
  };
  const taken = new Set(walk(existing).map((i) => i.entry.id));
  const groupId = unique(GROUP_ID, taken, '-');

  // Key rows, one per distinct file.
  const keyRows = new Map<string, { ref: string; hosts: string[]; proposedSecret: string }>();
  const secretsTaken = new Set(input.existingSecretNames);
  const paths = pathsFor(doc.home);
  const keyFor = (path: string, owner: string): PlannedAuth => {
    let row = keyRows.get(path);
    if (!row) {
      const base = `ssh_key_${paths.basename(path).replace(/[^A-Za-z0-9_]/g, '_')}`;
      row = { ref: `k${keyRows.size + 1}`, hosts: [], proposedSecret: unique(base, secretsTaken, '_') };
      keyRows.set(path, row);
    }
    if (!row.hosts.includes(owner)) row.hosts.push(owner);
    return { kind: 'key', ref: row.ref };
  };

  const mapped = aliases.map((alias) => ({ alias, m: mapEffective(effective(doc, alias), alias, doc.home, note) }));
  const usable = mapped.filter((x) => x.m.reason === undefined);
  const all = mapEffective(allHosts(doc), undefined, doc.home, note);

  // Group defaults (M1): a Host * value every usable host also ends up with a value for.
  const everyone = <K extends keyof Mapped>(key: K): boolean => usable.every((x) => x.m[key] !== undefined);
  const group: { -readonly [K in keyof PlannedSettings]: PlannedSettings[K] } = {};
  if (all.user !== undefined && everyone('user')) group.user = all.user;
  if (all.port !== undefined && everyone('port')) group.port = all.port;
  if (all.keepAlive !== undefined && everyone('keepAlive')) group.keepAlive = all.keepAlive;
  if (all.connectTimeout !== undefined && everyone('connectTimeout')) group.connectTimeout = all.connectTimeout;
  const groupAuth: PlannedAuth =
    all.identity !== undefined && everyone('identity') ? keyFor(all.identity, groupId) : { kind: 'agent' };
  group.auth = groupAuth;

  // Ids (M2), in document order, after the group's.
  const ids = new Map<string, { id: string; changed?: string }>();
  for (const { alias } of mapped) {
    const slug = slugId(alias);
    const id = unique(slug, taken, '-');
    ids.set(alias.toLowerCase(), id === slug ? { id } : { id, changed: slug });
  }

  // Duplicates (M3): same address, port and user as an existing host.
  const existingResolved = listResolvedHosts(existing);
  const duplicateOf = (address: string, port: number, user: string | undefined): string | undefined =>
    existingResolved.find(
      (h) =>
        h.address.toLowerCase() === address.toLowerCase() && h.ssh.port.value === port && h.ssh.user.value === user,
    )?.id;

  const hosts: PlannedHost[] = [];
  const agentHosts: string[] = [];
  const byAlias = new Map<string, PlannedHost>();
  for (const { alias, m } of mapped) {
    const { id, changed } = ids.get(alias.toLowerCase()) as { id: string; changed?: string };
    const base = { alias, id, ...(changed === undefined ? {} : { idChangedFrom: changed }) };
    if (m.reason !== undefined) {
      const skipped: PlannedHost = { ...base, status: 'skipped', reason: m.reason, address: '', ssh: {} };
      hosts.push(skipped);
      byAlias.set(alias.toLowerCase(), skipped);
      continue;
    }
    const ssh: { -readonly [K in keyof PlannedSettings]: PlannedSettings[K] } = {};
    if (m.user !== undefined && m.user !== group.user) ssh.user = m.user;
    if (m.port !== undefined && m.port !== group.port) ssh.port = m.port;
    if (m.keepAlive !== undefined && m.keepAlive !== group.keepAlive) ssh.keepAlive = m.keepAlive;
    if (m.connectTimeout !== undefined && m.connectTimeout !== group.connectTimeout) {
      ssh.connectTimeout = m.connectTimeout;
    }
    const auth: PlannedAuth =
      m.identity === undefined || (groupAuth.kind === 'key' && m.identity === all.identity)
        ? groupAuth
        : keyFor(m.identity, id);
    if (!sameAuth(auth, groupAuth)) ssh.auth = auth;
    if (m.identity === undefined && groupAuth.kind === 'agent') agentHosts.push(alias);
    const address = m.address as string;
    const dup = duplicateOf(address, m.port ?? group.port ?? 22, m.user ?? group.user);
    const host: PlannedHost = {
      ...base,
      status: dup === undefined ? 'new' : 'duplicate',
      ...(dup === undefined ? {} : { duplicateOf: dup, reason: `already in hosts.yaml as ${dup}` }),
      address,
      ssh,
    };
    hosts.push(host);
    byAlias.set(alias.toLowerCase(), host);
  }

  // Jumps (M5, M6). A chain `a,b` to T needs T → b and b → a; an alias hop must already jump that way, a hop
  // created for a jump takes it on. A chain that does not fit leaves T without a jump.
  const own = new Map(mapped.map(({ alias, m }) => [alias.toLowerCase(), m.hops]));
  type Hop =
    | { readonly kind: 'alias'; readonly id: string; readonly alias?: string }
    | { readonly kind: 'created'; readonly key: string; readonly id: string };
  const createdHosts = new Map<string, { host: PlannedHost; used: boolean }>();
  const createdJump = new Map<string, string | null>(); // null: must be reached directly
  const resolveHop = (hop: string): Hop | undefined => {
    const parsed = parseHop(hop);
    if (!parsed) return undefined;
    if (parsed.user === undefined && parsed.port === undefined) {
      const known = byAlias.get(parsed.host.toLowerCase());
      if (known?.status === 'skipped') return undefined;
      if (known?.status === 'duplicate') return { kind: 'alias', id: known.duplicateOf as string };
      if (known) return { kind: 'alias', id: known.id, alias: known.alias.toLowerCase() };
    }
    const key = hop.toLowerCase();
    let entry = createdHosts.get(key);
    if (!entry) {
      const slug = slugId(parsed.host);
      const id = unique(slug, taken, '-');
      const ssh: { -readonly [K in keyof PlannedSettings]: PlannedSettings[K] } = {};
      if (parsed.user !== undefined && parsed.user !== group.user) ssh.user = parsed.user;
      if (parsed.port !== undefined && parsed.port !== group.port) ssh.port = parsed.port;
      entry = {
        host: {
          alias: hop,
          id,
          ...(id === slug ? {} : { idChangedFrom: slug }),
          status: 'created-for-jump',
          address: parsed.host,
          ssh,
        },
        used: false,
      };
      createdHosts.set(key, entry);
    }
    return { kind: 'created', key, id: entry.host.id };
  };
  /** The id an alias hop already jumps through: its own chain's last hop, or the existing host's jump. */
  const jumpOfAlias = (hop: Extract<Hop, { kind: 'alias' }>): string | undefined => {
    if (hop.alias === undefined) return resolveSettings(existing, hop.id).jump;
    const last = own.get(hop.alias)?.at(-1);
    return last === undefined ? undefined : resolveHop(last)?.id;
  };

  const jumps = new Map<string, string>(); // planned host id → jump id
  const accepted = new Map<string, { alias: string; written: readonly string[]; hops: readonly Hop[] }>();
  for (const host of hosts) {
    if (host.status !== 'new' && host.status !== 'duplicate') continue;
    const written = own.get(host.alias.toLowerCase()) ?? [];
    if (written.length === 0) continue;
    const chain = written.map(resolveHop);
    if (chain.some((h) => h === undefined)) {
      note(`${host.alias}: the jump ${written.join(',')} could not be mapped; imported without a jump`);
      continue;
    }
    const hops = chain as Hop[];
    const assign = new Map<string, string | null>();
    let fits = !hops.some((h) => h.id === host.id);
    hops.forEach((hop, i) => {
      const need = i === 0 ? null : (hops[i - 1] as Hop).id;
      if (hop.kind === 'alias') {
        if (i > 0 && jumpOfAlias(hop) !== need) fits = false;
        return;
      }
      const current = assign.get(hop.key) ?? createdJump.get(hop.key);
      if (current !== undefined && current !== need) fits = false;
      assign.set(hop.key, need);
    });
    if (!fits) {
      note(`${host.alias}: the jump chain ${written.join(',')} does not fit hosts.yaml; imported without a jump`);
      continue;
    }
    for (const [key, need] of assign) {
      createdJump.set(key, need);
      (createdHosts.get(key) as { used: boolean }).used = true;
    }
    jumps.set(host.id, (hops.at(-1) as Hop).id);
    accepted.set(host.id, { alias: host.alias, written, hops });
  }
  for (const { host } of createdHosts.values()) {
    const need = createdJump.get(host.alias.toLowerCase());
    if (need) jumps.set(host.id, need);
  }

  const drop = (id: string, why: string): void => {
    jumps.delete(id);
    accepted.delete(id);
    note(why);
  };
  // A loop through several chains would fail the model's check on Import; drop the jump that closes it.
  const existingJump = (id: string): string | undefined => {
    try {
      return resolveSettings(existing, id).jump;
    } catch {
      return undefined;
    }
  };
  for (const [id] of jumps) {
    const seen = new Set([id]);
    for (let at = jumps.get(id); at !== undefined; at = jumps.get(at) ?? existingJump(at)) {
      if (seen.has(at)) {
        drop(id, `${hosts.find((h) => h.id === id)?.alias ?? id}: its jump chain loops; imported without a jump`);
        break;
      }
      seen.add(at);
    }
  }

  // An alias hop whose own chain was dropped no longer leads where a chain through it needs: drop that chain too.
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, { alias, written, hops }] of accepted) {
      const broken = hops.some(
        (hop, i) => i > 0 && hop.kind === 'alias' && hop.alias !== undefined && jumps.get(hop.id) !== hops[i - 1]?.id,
      );
      if (broken) {
        drop(id, `${alias}: the jump chain ${written.join(',')} does not fit hosts.yaml; imported without a jump`);
        changed = true;
      }
    }
  }

  const withJumps = (host: PlannedHost): PlannedHost => {
    const jump = jumps.get(host.id);
    return jump === undefined || jump === group.jump ? host : { ...host, ssh: { ...host.ssh, jump } };
  };
  const created = [...createdHosts.values()].filter((e) => e.used).map((e) => e.host);
  for (const host of created) note(`${host.id} (${host.alias}) was created for a jump`);

  if (agentHosts.length > 0) note(`Authenticate through the SSH agent (no IdentityFile): ${agentHosts.join(', ')}`);
  const lines = reportLines(doc);
  return {
    group: { id: groupId, name: DEFAULT_GROUP_NAME, ssh: group },
    hosts: [...hosts, ...created].map(withJumps),
    keys: [...keyRows].map(([path, row]) => ({
      ref: row.ref,
      path,
      display: displayPath(path, doc.home),
      hosts: row.hosts,
      proposedSecret: row.proposedSecret,
    })),
    report: { problems: doc.problems, ...lines, notes },
  };
}
