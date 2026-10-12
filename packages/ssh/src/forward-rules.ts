import { isIP, isIPv4 } from 'node:net';
import { z } from 'zod';
import { SshModelError } from './errors.js';

export type ForwardType = 'local' | 'remote' | 'dynamic';

/** The off form: switches off a rule of that id from a level above. */
export interface ForwardOff {
  readonly id: string;
  readonly enabled: false;
}

/** As written in hosts.yaml. Parsing drops values equal to their defaults, so the file round-trips. */
export type ForwardEntry =
  | {
      readonly id: string;
      readonly type: ForwardType;
      readonly port: number;
      readonly bind?: string;
      /** 'host:port' or '[v6]:port'. */
      readonly target?: string;
      readonly autoStart?: boolean;
      readonly enabled?: boolean;
    }
  | ForwardOff;

const ID = /^[a-z0-9][a-z0-9-]*$/;
const TYPES = ['local', 'remote', 'dynamic'] as const;
const KEYS = ['id', 'type', 'port', 'bind', 'target', 'autoStart', 'enabled'] as const;
const HOST_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isOffForm(entry: ForwardEntry): entry is ForwardOff {
  return !('type' in entry) && entry.enabled === false;
}

/** '127.0.0.1' for local and dynamic, 'localhost' (the server's loopback) for remote. */
export function defaultBind(type: ForwardType): string {
  return type === 'remote' ? 'localhost' : '127.0.0.1';
}

/** True for any address other than `127.0.0.0/8`, `::1` and `localhost`. */
export function isNetworkBind(bind: string): boolean {
  if (bind === 'localhost' || bind === '::1') return false;
  return !(isIPv4(bind) && bind.startsWith('127.'));
}

/** `localhost`, an IPv4 or an IPv6 literal; a host name is refused because what it resolves to can change. */
function isBind(bind: string): boolean {
  return bind === 'localhost' || isIP(bind) !== 0;
}

const isPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;

function readTarget(target: string): { host: string; port: number } | undefined {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(target);
  if (!match) return undefined;
  const port = Number(match[3]);
  if (!isPort(port)) return undefined;
  if (match[1] !== undefined) return isIP(match[1]) === 6 ? { host: match[1], port } : undefined;
  const host = match[2] as string;
  return HOST_NAME.test(host) ? { host, port } : undefined;
}

/** @throws SshModelError `ssh-forward-invalid` */
export function parseTarget(target: string): { host: string; port: number } {
  const parsed = readTarget(target);
  if (!parsed) {
    throw new SshModelError('ssh-forward-invalid', `target "${target}" must be host:port or [v6]:port`, {
      field: 'target',
    });
  }
  return parsed;
}

/** One refusal: the field it names and the form expected there. */
type Refusal = { readonly field: string; readonly expected: string };

function check(value: unknown): ForwardEntry | Refusal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { field: 'id', expected: 'a rule (a mapping with id, type and port)' };
  }
  const raw = value as Record<string, unknown>;
  const id = raw['id'];
  if (typeof id !== 'string' || !ID.test(id)) {
    return { field: 'id', expected: 'an id of lower-case letters, digits and dashes' };
  }
  const keys = Object.keys(raw);
  if (raw['enabled'] === false && keys.length === 2) return { id, enabled: false };
  const unknown = keys.find((k) => !(KEYS as readonly string[]).includes(k));
  if (unknown !== undefined) return { field: unknown, expected: `absent: a rule has ${KEYS.join(', ')}` };
  const type = raw['type'];
  if (!TYPES.includes(type as ForwardType)) return { field: 'type', expected: 'local, remote or dynamic' };
  const t = type as ForwardType;
  const port = raw['port'];
  if (typeof port !== 'number' || !isPort(port)) return { field: 'port', expected: 'an integer from 1 to 65535' };
  const { bind, target, autoStart, enabled } = raw;
  if (bind !== undefined && (typeof bind !== 'string' || !isBind(bind))) {
    return { field: 'bind', expected: 'localhost, an IPv4 or an IPv6 address (not a host name)' };
  }
  if (t === 'dynamic' && target !== undefined) return { field: 'target', expected: 'absent on a dynamic rule' };
  if (t !== 'dynamic' && (typeof target !== 'string' || readTarget(target) === undefined)) {
    return { field: 'target', expected: 'host:port or [v6]:port' };
  }
  if (autoStart !== undefined && typeof autoStart !== 'boolean')
    return { field: 'autoStart', expected: 'true or false' };
  if (enabled !== undefined && typeof enabled !== 'boolean') return { field: 'enabled', expected: 'true or false' };
  return {
    id,
    type: t,
    port,
    ...(bind === undefined || bind === defaultBind(t) ? {} : { bind }),
    ...(target === undefined ? {} : { target: target as string }),
    ...(autoStart === true ? { autoStart: true } : {}),
    ...(enabled === false ? { enabled: false } : {}),
  };
}

/**
 * One rule of a `forwards` list. A refusal is a custom issue at the offending field carrying
 * `params.forwardInvalid`, which `parseHostsFile` turns into `ssh-forward-invalid`.
 */
export const forwardEntrySchema: z.ZodType<ForwardEntry> = z.unknown().transform((value, ctx) => {
  const result = check(value);
  if (!('field' in result)) return result;
  const id = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['id'] : undefined;
  ctx.addIssue({
    code: 'custom',
    path: [result.field],
    message: `must be ${result.expected}`,
    params: { forwardInvalid: true, field: result.field, ...(typeof id === 'string' ? { id } : {}) },
  });
  return z.NEVER;
});

/** `forwards` on a host or group; an empty list is the same as none. */
export const forwardsSchema = z
  .array(forwardEntrySchema)
  .transform((list) => (list.length === 0 ? undefined : list))
  .optional();

/** The YAML form, keys in order, defaults omitted. */
export function serializeForward(entry: ForwardEntry): Record<string, unknown> {
  if (isOffForm(entry)) return { id: entry.id, enabled: false };
  const out: Record<string, unknown> = { id: entry.id, type: entry.type, port: entry.port };
  if (entry.bind !== undefined && entry.bind !== defaultBind(entry.type)) out['bind'] = entry.bind;
  if (entry.target !== undefined) out['target'] = entry.target;
  if (entry.autoStart === true) out['autoStart'] = true;
  if (entry.enabled === false) out['enabled'] = false;
  return out;
}
