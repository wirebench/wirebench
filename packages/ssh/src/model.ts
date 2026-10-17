import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';
import { SshModelError } from './errors.js';
import { forwardsSchema, isOffForm, serializeForward } from './forward-rules.js';
import type { ForwardEntry } from './forward-rules.js';
import {
  checkForwardGroups,
  FORWARD_GROUPS_VERSION,
  forwardGroupSchema,
  serializeForwardGroup,
} from './forward-groups.js';
import { envSchema } from './host-env.js';
import { moshSchema, protocolSchema } from './host-mosh.js';
import { serialSchema } from './host-serial.js';
import { terminalSchema } from './host-terminal.js';
import type { TerminalEntry } from './host-terminal.js';
import { resolveSettings } from './resolve.js';
import { SECRET_NAME, SECRET_TOKEN } from './secret-token.js';
import { walk } from './tree.js';

export { walk };

export { SECRET_NAME, SECRET_TOKEN };
const ID = /^[a-z0-9][a-z0-9-]*$/;
/** The workspace id grammar, shared with `snippets.yaml`. */
export const ENTRY_ID = ID;

export function secretNameOf(token: string): string {
  const match = SECRET_TOKEN.exec(token);
  if (!match?.[1]) throw new SshModelError('ssh-literal-secret', 'expected a ${secret:NAME} token');
  return match[1];
}

/** A credential as written: a `${secret:NAME}` token. The issue never echoes the value. */
const secretRef = z.string().superRefine((value, ctx) => {
  if (!SECRET_TOKEN.test(value)) {
    ctx.addIssue({ code: 'custom', message: 'must be a ${secret:NAME} token', params: { literalSecret: true } });
  }
});

const authSchema = z.union([
  z.strictObject({ password: secretRef }).transform((a) => ({ kind: 'password' as const, password: a.password })),
  z
    .strictObject({ key: secretRef, certificate: secretRef.optional(), passphrase: secretRef.optional() })
    .transform((a) => ({
      kind: 'key' as const,
      key: a.key,
      /** An OpenSSH user certificate for the key (#421): offered first, then the key alone. */
      ...(a.certificate === undefined ? {} : { certificate: a.certificate }),
      ...(a.passphrase === undefined ? {} : { passphrase: a.passphrase }),
    })),
  z.strictObject({ agent: z.literal(true) }).transform(() => ({ kind: 'agent' as const })),
]);

/**
 * A SOCKS5 or HTTP CONNECT proxy the first hop of a connection is dialled through (#417). The password is a
 * `${secret:NAME}` token only, like every credential here.
 */
const proxySchema = z.strictObject({
  type: z.enum(['socks5', 'http']),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1).optional(),
  password: secretRef.optional(),
});

const settingsSchema = z
  .strictObject({
    /** A named identity (#416) supplying `user` and `auth`; a `user` or `auth` set at this level still wins. */
    identity: z.string().regex(ID).optional(),
    user: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    jump: z.string().regex(ID).optional(),
    auth: authSchema.optional(),
    keepAlive: z.number().int().min(0).optional(),
    connectTimeout: z.number().int().min(1).optional(),
    /** Off by default; a nearer `false` turns an inherited `true` off. */
    forwardAgent: z.boolean().optional(),
    /** `mosh` starts a mosh server over SSH and runs the session over UDP (#419); `telnet` is plain text (#425); `ssh` by default. */
    protocol: protocolSchema,
    /** Taken whole from the nearest level that sets it. */
    mosh: moshSchema,
    /** A serial console's line settings (#426), taken whole from the nearest level; the device is per machine. */
    serial: serialSchema,
    /** `false` connects directly though a group above sets a proxy. */
    proxy: z.union([z.literal(false), proxySchema]).optional(),
  })
  .default({});

/**
 * A user and a way to sign in, kept once and named by hosts and groups in different places (#416). Its
 * credentials are `${secret:NAME}` tokens, like every credential here.
 */
const identitySchema = z.strictObject({
  id: z.string().regex(ID),
  name: z.string().min(1),
  user: z.string().min(1).optional(),
  auth: authSchema.optional(),
});

const hostSchema = z.strictObject({
  id: z.string().regex(ID),
  name: z.string().min(1),
  /** Required unless the host is a serial console (#426), which has none: `''` then. */
  address: z
    .string()
    .min(1)
    .optional()
    .transform((a) => a ?? ''),
  tags: z.array(z.string().min(1)).default([]),
  protected: z.boolean().optional(),
  ssh: settingsSchema,
  env: envSchema,
  terminal: terminalSchema,
  forwards: forwardsSchema,
});

export type SshAuth = z.infer<typeof authSchema>;
export type SshSettings = z.infer<typeof settingsSchema>;
export type SshProxy = z.infer<typeof proxySchema>;
export type IdentityEntry = z.infer<typeof identitySchema>;
export type HostEntry = z.infer<typeof hostSchema>;
export interface GroupEntry {
  id: string;
  name: string;
  tags: string[];
  /** Runs touching a protected host always confirm; inherited, a nearer `false` lifts it. */
  protected?: boolean | undefined;
  ssh: SshSettings;
  /** Merged by name down the tree; a nearer level wins per variable. */
  env?: Record<string, string> | undefined;
  /** Per field, the nearest level wins; unset falls through to the app preferences. */
  terminal?: TerminalEntry | undefined;
  forwards?: ForwardEntry[] | undefined;
  groups: GroupEntry[];
  hosts: HostEntry[];
}

const groupSchema: z.ZodType<GroupEntry> = z.lazy(() =>
  z.strictObject({
    id: z.string().regex(ID),
    name: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
    protected: z.boolean().optional(),
    ssh: settingsSchema,
    env: envSchema,
    terminal: terminalSchema,
    forwards: forwardsSchema,
    groups: z.array(groupSchema).default([]),
    hosts: z.array(hostSchema).default([]),
  }),
);

const fileSchema = z
  .strictObject({
    /** 2 once the file holds forwarding groups (#583); a file without them is still written as 1. */
    version: z.union([z.literal(1), z.literal(2)]),
    /** Left out when there are none, so files written before #416 read and write unchanged. */
    identities: z.array(identitySchema).optional(),
    groups: z.array(groupSchema).default([]),
    hosts: z.array(hostSchema).default([]),
    /** Named sets of rules started together (#583); version 2 only, left out when there are none. */
    forwardGroups: z.array(forwardGroupSchema).optional(),
  })
  .superRefine((file, ctx) => {
    if (file.forwardGroups !== undefined && file.version < FORWARD_GROUPS_VERSION) {
      ctx.addIssue({
        code: 'custom',
        path: ['forwardGroups'],
        message: `needs version: ${String(FORWARD_GROUPS_VERSION)}`,
      });
    }
  });

export type HostsFile = z.infer<typeof fileSchema>;
export const EMPTY_HOSTS_FILE: HostsFile = { version: 1, groups: [], hosts: [] };

export const pathString = (path: readonly PropertyKey[]): string =>
  path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join('');

interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly params?: Record<string, unknown> | undefined;
  readonly message?: string;
  readonly errors?: readonly (readonly IssueLike[])[];
}

/** A refused forwarding rule (see `forwardEntrySchema`): its path, field and rule id. */
function findForwardInvalid(
  issues: readonly IssueLike[],
): { path: string; field: string; id?: string; message: string } | undefined {
  for (const issue of issues) {
    if (issue.params?.['forwardInvalid'] !== true) continue;
    const id = issue.params['id'];
    return {
      path: pathString(issue.path),
      field: String(issue.params['field']),
      ...(typeof id === 'string' ? { id } : {}),
      message: issue.message ?? 'is invalid',
    };
  }
  return undefined;
}

/** The literal-secret issue may sit inside the branches of the `auth` union, whose paths are relative to it. */
function findLiteralSecret(issues: readonly IssueLike[], prefix: readonly PropertyKey[] = []): string | undefined {
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.params?.['literalSecret'] === true) return pathString(path);
    for (const branch of issue.errors ?? []) {
      const found = findLiteralSecret(branch, path);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Never forwards the library's message: it quotes the offending source line, which may hold a credential. */
export function readYaml(
  text: string,
  file = 'hosts.yaml',
  code: 'ssh-hosts-invalid' | 'snippets-invalid' = 'ssh-hosts-invalid',
): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error;
    const line = error.linePos?.[0]?.line;
    const column = error.linePos?.[0]?.col;
    const where = line === undefined ? '' : ` at line ${line}, column ${column ?? 1}`;
    throw new SshModelError(code, `${file}: YAML syntax error${where}`, {
      ...(line === undefined ? {} : { line, column: column ?? 1 }),
    });
  }
}

export function parseHostsFile(text: string): HostsFile {
  const document = readYaml(text);
  const raw: unknown = document === null || document === undefined ? { version: 1 } : document;
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const literal = findLiteralSecret(parsed.error.issues);
    if (literal !== undefined) {
      throw new SshModelError('ssh-literal-secret', `${literal} must be a \${secret:NAME} token`, { path: literal });
    }
    const forward = findForwardInvalid(parsed.error.issues);
    if (forward !== undefined) {
      const rule = forward.id === undefined ? 'a forwarding rule' : `forwarding rule "${forward.id}"`;
      throw new SshModelError('ssh-forward-invalid', `hosts.yaml: ${rule}: ${forward.field} ${forward.message}`, {
        path: forward.path,
        field: forward.field,
        ...(forward.id === undefined ? {} : { id: forward.id }),
      });
    }
    const first = parsed.error.issues[0];
    throw new SshModelError(
      'ssh-hosts-invalid',
      `hosts.yaml: ${pathString(first?.path ?? [])} ${first?.message ?? 'invalid'}`,
      {
        path: pathString(first?.path ?? []),
        issues: parsed.error.issues.map((i) => ({ path: pathString(i.path), message: i.message })),
      },
    );
  }
  checkIds(parsed.data);
  checkAddresses(parsed.data);
  checkIdentities(parsed.data);
  checkJumps(parsed.data);
  checkForwards(parsed.data);
  checkForwardGroups(parsed.data.forwardGroups ?? []);
  return parsed.data;
}

function checkIds(file: HostsFile): void {
  const seen = new Map<string, readonly string[]>();
  for (const { entry, path } of walk(file)) {
    const previous = seen.get(entry.id);
    if (previous) {
      throw new SshModelError('ssh-duplicate-id', `id "${entry.id}" is used twice`, {
        id: entry.id,
        paths: [[...previous, entry.id].join('/'), [...path, entry.id].join('/')],
      });
    }
    seen.set(entry.id, path);
  }
}

/** Every host has an address, except a serial console (#426): its protocol, its own or inherited, says so. */
function checkAddresses(file: HostsFile): void {
  for (const { entry, kind, path } of walk(file)) {
    if (kind !== 'host' || (entry as HostEntry).address !== '') continue;
    if (resolveSettings(file, entry.id).protocol === 'serial') continue;
    const where = pathString([...path, entry.id]);
    throw new SshModelError('ssh-hosts-invalid', `hosts.yaml: host "${entry.id}" needs an address`, {
      path: where,
      issues: [{ path: where, message: 'needs an address' }],
    });
  }
}

/** Identity ids are their own namespace: unique among identities, and every `identity:` names one. */
function checkIdentities(file: HostsFile): void {
  const known = new Set<string>();
  for (const identity of file.identities ?? []) {
    if (known.has(identity.id)) {
      throw new SshModelError('ssh-duplicate-id', `identity id "${identity.id}" is used twice`, {
        id: identity.id,
        paths: [`identities/${identity.id}`],
      });
    }
    known.add(identity.id);
  }
  for (const { entry, kind } of walk(file)) {
    const identity = entry.ssh.identity;
    if (identity !== undefined && !known.has(identity)) {
      throw new SshModelError('ssh-identity-unknown', `${kind} "${entry.id}" uses unknown identity "${identity}"`, {
        id: entry.id,
        identity,
      });
    }
  }
}

function checkJumps(file: HostsFile): void {
  const items = walk(file);
  const hosts = new Set(items.filter((i) => i.kind === 'host').map((i) => i.entry.id));
  for (const { entry, kind } of items) {
    const jump = entry.ssh.jump;
    if (jump !== undefined && !hosts.has(jump)) {
      throw new SshModelError('ssh-jump-unknown', `${kind} "${entry.id}" jumps through unknown host "${jump}"`, {
        id: entry.id,
        jump,
      });
    }
  }
  for (const id of hosts) {
    const chain = [id];
    let next = resolveSettings(file, id).jump;
    while (next !== undefined) {
      if (chain.includes(next)) {
        throw new SshModelError('ssh-jump-cycle', `jump chain loops: ${[...chain, next].join(' → ')}`, {
          cycle: [...chain, next],
        });
      }
      chain.push(next);
      next = resolveSettings(file, next).jump;
    }
  }
}

/** One id per level's list; an off form must name a rule defined on a group above it. */
function checkForwards(file: HostsFile): void {
  const items = walk(file);
  const groups = new Map<string, GroupEntry>();
  for (const item of items) if (item.kind === 'group') groups.set(item.entry.id, item.entry as GroupEntry);
  for (const { entry, kind, path } of items) {
    const seen = new Set<string>();
    for (const rule of entry.forwards ?? []) {
      if (seen.has(rule.id)) {
        throw new SshModelError('ssh-forward-duplicate-id', `${kind} "${entry.id}" lists forward "${rule.id}" twice`, {
          id: rule.id,
          level: entry.id,
        });
      }
      seen.add(rule.id);
      if (!isOffForm(rule)) continue;
      const above = path.some((gid) => groups.get(gid)?.forwards?.some((r) => r.id === rule.id && !isOffForm(r)));
      if (!above) {
        const where = path.length === 0 ? 'it has no group above it' : `no rule "${rule.id}" in ${path.join(', ')}`;
        throw new SshModelError(
          'ssh-forward-unknown',
          `${kind} "${entry.id}" switches off forward "${rule.id}", but ${where}`,
          { id: rule.id, level: entry.id, lookedIn: [...path] },
        );
      }
    }
  }
}

function authOut(auth: SshAuth): Record<string, unknown> {
  return auth.kind === 'password'
    ? { password: auth.password }
    : auth.kind === 'key'
      ? {
          key: auth.key,
          ...(auth.certificate === undefined ? {} : { certificate: auth.certificate }),
          ...(auth.passphrase === undefined ? {} : { passphrase: auth.passphrase }),
        }
      : { agent: true };
}

function settings(ssh: SshSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ssh.identity !== undefined) out['identity'] = ssh.identity;
  if (ssh.user !== undefined) out['user'] = ssh.user;
  if (ssh.port !== undefined) out['port'] = ssh.port;
  if (ssh.jump !== undefined) out['jump'] = ssh.jump;
  if (ssh.auth !== undefined) out['auth'] = authOut(ssh.auth);
  if (ssh.keepAlive !== undefined) out['keepAlive'] = ssh.keepAlive;
  if (ssh.connectTimeout !== undefined) out['connectTimeout'] = ssh.connectTimeout;
  if (ssh.forwardAgent !== undefined) out['forwardAgent'] = ssh.forwardAgent;
  if (ssh.protocol !== undefined) out['protocol'] = ssh.protocol;
  if (ssh.mosh !== undefined) out['mosh'] = { ...ssh.mosh };
  if (ssh.serial !== undefined) out['serial'] = { ...ssh.serial };
  if (ssh.proxy === false) out['proxy'] = false;
  else if (ssh.proxy !== undefined) {
    const { type, host, port, user, password } = ssh.proxy;
    out['proxy'] = {
      type,
      host,
      port,
      ...(user === undefined ? {} : { user }),
      ...(password === undefined ? {} : { password }),
    };
  }
  return out;
}

function head(entry: HostEntry | GroupEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { id: entry.id, name: entry.name };
  if ('address' in entry && entry.address !== '') out['address'] = entry.address;
  if (entry.tags.length > 0) out['tags'] = entry.tags;
  if (entry.protected !== undefined) out['protected'] = entry.protected;
  const ssh = settings(entry.ssh);
  if (Object.keys(ssh).length > 0) out['ssh'] = ssh;
  if (entry.env !== undefined && Object.keys(entry.env).length > 0) out['env'] = { ...entry.env };
  if (entry.terminal !== undefined) out['terminal'] = { ...entry.terminal };
  if (entry.forwards !== undefined && entry.forwards.length > 0) out['forwards'] = entry.forwards.map(serializeForward);
  return out;
}

function host(h: HostEntry): Record<string, unknown> {
  return head(h);
}

function group(g: GroupEntry): Record<string, unknown> {
  const out = head(g);
  if (g.groups.length > 0) out['groups'] = g.groups.map(group);
  if (g.hosts.length > 0) out['hosts'] = g.hosts.map(host);
  return out;
}

/** The lowest version that can hold the file, so a file without forwarding groups stays readable by older builds. */
export function hostsFileVersion(file: Pick<HostsFile, 'forwardGroups'>): 1 | 2 {
  return file.forwardGroups !== undefined && file.forwardGroups.length > 0 ? FORWARD_GROUPS_VERSION : 1;
}

export function serializeHostsFile(file: HostsFile): string {
  const out: Record<string, unknown> = { version: hostsFileVersion(file) };
  if (file.identities !== undefined && file.identities.length > 0) {
    out['identities'] = file.identities.map((i) => ({
      id: i.id,
      name: i.name,
      ...(i.user === undefined ? {} : { user: i.user }),
      ...(i.auth === undefined ? {} : { auth: authOut(i.auth) }),
    }));
  }
  if (file.groups.length > 0) out['groups'] = file.groups.map(group);
  if (file.hosts.length > 0) out['hosts'] = file.hosts.map(host);
  if (file.forwardGroups !== undefined && file.forwardGroups.length > 0) {
    out['forwardGroups'] = file.forwardGroups.map(serializeForwardGroup);
  }
  return stringifyYaml(out, { lineWidth: 0 });
}
