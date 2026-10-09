import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';
import { SshModelError } from './errors.js';
import { resolveSettings } from './resolve.js';
import { walk } from './tree.js';

export { walk };

export const SECRET_TOKEN = /^\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;

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
  z.strictObject({ key: secretRef, passphrase: secretRef.optional() }).transform((a) => ({
    kind: 'key' as const,
    key: a.key,
    ...(a.passphrase === undefined ? {} : { passphrase: a.passphrase }),
  })),
  z.strictObject({ agent: z.literal(true) }).transform(() => ({ kind: 'agent' as const })),
]);

const settingsSchema = z
  .strictObject({
    user: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    jump: z.string().regex(ID).optional(),
    auth: authSchema.optional(),
    keepAlive: z.number().int().min(0).optional(),
    connectTimeout: z.number().int().min(1).optional(),
  })
  .default({});

const hostSchema = z.strictObject({
  id: z.string().regex(ID),
  name: z.string().min(1),
  address: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  ssh: settingsSchema,
});

export type SshAuth = z.infer<typeof authSchema>;
export type SshSettings = z.infer<typeof settingsSchema>;
export type HostEntry = z.infer<typeof hostSchema>;
export interface GroupEntry {
  id: string;
  name: string;
  tags: string[];
  ssh: SshSettings;
  groups: GroupEntry[];
  hosts: HostEntry[];
}

const groupSchema: z.ZodType<GroupEntry> = z.lazy(() =>
  z.strictObject({
    id: z.string().regex(ID),
    name: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
    ssh: settingsSchema,
    groups: z.array(groupSchema).default([]),
    hosts: z.array(hostSchema).default([]),
  }),
);

const fileSchema = z.strictObject({
  version: z.literal(1),
  groups: z.array(groupSchema).default([]),
  hosts: z.array(hostSchema).default([]),
});

export type HostsFile = z.infer<typeof fileSchema>;
export const EMPTY_HOSTS_FILE: HostsFile = { version: 1, groups: [], hosts: [] };

const pathString = (path: readonly PropertyKey[]): string =>
  path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join('');

interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly params?: Record<string, unknown> | undefined;
  readonly errors?: readonly (readonly IssueLike[])[];
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
function readYaml(text: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error;
    const line = error.linePos?.[0]?.line;
    const column = error.linePos?.[0]?.col;
    const where = line === undefined ? '' : ` at line ${line}, column ${column ?? 1}`;
    throw new SshModelError('ssh-hosts-invalid', `hosts.yaml: YAML syntax error${where}`, {
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
  checkJumps(parsed.data);
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

function settings(ssh: SshSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ssh.user !== undefined) out['user'] = ssh.user;
  if (ssh.port !== undefined) out['port'] = ssh.port;
  if (ssh.jump !== undefined) out['jump'] = ssh.jump;
  if (ssh.auth !== undefined) {
    const auth = ssh.auth;
    out['auth'] =
      auth.kind === 'password'
        ? { password: auth.password }
        : auth.kind === 'key'
          ? { key: auth.key, ...(auth.passphrase === undefined ? {} : { passphrase: auth.passphrase }) }
          : { agent: true };
  }
  if (ssh.keepAlive !== undefined) out['keepAlive'] = ssh.keepAlive;
  if (ssh.connectTimeout !== undefined) out['connectTimeout'] = ssh.connectTimeout;
  return out;
}

function head(entry: HostEntry | GroupEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { id: entry.id, name: entry.name };
  if ('address' in entry) out['address'] = entry.address;
  if (entry.tags.length > 0) out['tags'] = entry.tags;
  const ssh = settings(entry.ssh);
  if (Object.keys(ssh).length > 0) out['ssh'] = ssh;
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

export function serializeHostsFile(file: HostsFile): string {
  const out: Record<string, unknown> = { version: file.version };
  if (file.groups.length > 0) out['groups'] = file.groups.map(group);
  if (file.hosts.length > 0) out['hosts'] = file.hosts.map(host);
  return stringifyYaml(out, { lineWidth: 0 });
}
