/**
 * Where a `${secret:name}` comes from when it is not in this machine's store: a mapping, in the shared
 * `workspace.yaml` and the machine-local `local.yaml`, from a name to an entry in an external manager.
 * See docs/specs/2026-10-05-secret-sources-design.md (D1).
 *
 * Every field is a value, never a flag: none may start with `-`, so `argvFor` (kinds.ts) can place it
 * anywhere in argv. An entry that fails is kept as `invalid`, with its raw value, so a send that needs it
 * is refused rather than falling through to another store, and a save writes it back untouched.
 *
 * Pure module: no `node:` imports (the renderer does not import it, but nothing here needs Node).
 */

import { z } from 'zod';
import { SECRET_NAME_PATTERN } from '../secret-token.js';

export const SECRET_SOURCE_KINDS = ['vault', 'aws', 'gcp', 'azure', '1password', 'keychain'] as const;
export type SecretSourceKind = (typeof SECRET_SOURCE_KINDS)[number];

export interface VaultSource {
  readonly kind: 'vault';
  readonly path: string;
  readonly field: string;
  readonly mount?: string;
  readonly namespace?: string;
}
export interface AwsSource {
  readonly kind: 'aws';
  readonly secretId: string;
  readonly jsonKey?: string;
  readonly region?: string;
  readonly profile?: string;
}
export interface GcpSource {
  readonly kind: 'gcp';
  readonly secret: string;
  readonly project?: string;
  readonly version?: string;
}
export interface AzureSource {
  readonly kind: 'azure';
  readonly vault: string;
  readonly name: string;
}
export interface OnePasswordSource {
  readonly kind: '1password';
  readonly ref: string;
}
export interface KeychainSource {
  readonly kind: 'keychain';
  readonly service: string;
  readonly account: string;
}
export type SecretSource = VaultSource | AwsSource | GcpSource | AzureSource | OnePasswordSource | KeychainSource;
export interface InvalidSecretSource {
  readonly kind: 'invalid';
  readonly raw: unknown;
  readonly field?: string;
  readonly reason: string;
}
export type SharedSecretSource = SecretSource | InvalidSecretSource;
export type LocalSecretSource = SharedSecretSource | { readonly kind: 'none' };
export type SharedSecretSources = Readonly<Record<string, SharedSecretSource>>;
export type LocalSecretSources = Readonly<Record<string, LocalSecretSource>>;
export interface EffectiveSecretSource {
  readonly source: SharedSecretSource;
  readonly origin: 'shared' | 'local';
}
export type EffectiveSecretSources = ReadonlyMap<string, EffectiveSecretSource>;
export interface SecretSourceIssue {
  readonly name: string;
  readonly field?: string;
  readonly reason: string;
}

/** Longest value any field may hold. */
export const SECRET_SOURCE_FIELD_MAX = 512;

/** No C0/C1 control character, DEL included. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A field: non-empty, bounded, printable, and never a flag; `pattern` narrows it further. */
function field(pattern?: RegExp, hint?: string) {
  return z
    .string()
    .min(1, 'must not be empty')
    .max(SECRET_SOURCE_FIELD_MAX, `must be at most ${String(SECRET_SOURCE_FIELD_MAX)} characters`)
    .refine((value) => !CONTROL.test(value), 'must not contain control characters')
    .refine((value) => !value.startsWith('-'), 'must not start with "-"')
    .refine(
      (value) => pattern === undefined || pattern.test(value),
      hint ?? 'has characters this field does not allow',
    );
}

const SLUG = /^[A-Za-z0-9._-]+$/;

const kindSchemas = {
  vault: z.strictObject({
    kind: z.literal('vault'),
    path: field(),
    field: field(),
    mount: field(SLUG).optional(),
    namespace: field().optional(),
  }),
  aws: z.strictObject({
    kind: z.literal('aws'),
    secretId: field(/^[A-Za-z0-9/_+=.@:-]+$/, 'must be a secret name or ARN').refine(
      (value) => !value.includes('://'),
      'must be a secret name or ARN',
    ),
    jsonKey: field().optional(),
    region: field(/^[a-z0-9-]+$/, 'must be lower-case letters, digits and "-"').optional(),
    profile: field(SLUG).optional(),
  }),
  gcp: z.strictObject({
    kind: z.literal('gcp'),
    secret: field(SLUG),
    project: field(SLUG).optional(),
    version: field(SLUG).optional(),
  }),
  azure: z.strictObject({ kind: z.literal('azure'), vault: field(SLUG), name: field(SLUG) }),
  '1password': z.strictObject({ kind: z.literal('1password'), ref: field(/^op:\/\//, 'must start with "op://"') }),
  keychain: z.strictObject({ kind: z.literal('keychain'), service: field(), account: field() }),
} as const;

/**
 * The field names of each kind, required then optional, read from the schemas above. A form that cannot load
 * the schemas (the desktop renderer) keeps its own copy and a test holds it to this one.
 */
export const SECRET_SOURCE_KIND_FIELDS: Readonly<
  Record<SecretSourceKind, { readonly required: readonly string[]; readonly optional: readonly string[] }>
> = Object.fromEntries(
  SECRET_SOURCE_KINDS.map((kind) => {
    const shape = kindSchemas[kind].shape as Record<string, z.ZodType>;
    const names = Object.keys(shape).filter((name) => name !== 'kind');
    return [
      kind,
      {
        required: names.filter((name) => !shape[name]?.safeParse(undefined).success),
        optional: names.filter((name) => shape[name]?.safeParse(undefined).success === true),
      },
    ];
  }),
) as unknown as Record<
  SecretSourceKind,
  { readonly required: readonly string[]; readonly optional: readonly string[] }
>;

function invalid(raw: unknown, reason: string, fieldName?: string): InvalidSecretSource {
  return { kind: 'invalid', raw, reason, ...(fieldName !== undefined ? { field: fieldName } : {}) };
}

/** One entry, validated; never throws. */
export function parseSecretSource(raw: unknown): SharedSecretSource {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid(raw, 'must be a mapping with a kind');
  }
  const kind = (raw as Record<string, unknown>)['kind'];
  if (typeof kind !== 'string' || !Object.hasOwn(kindSchemas, kind)) {
    return invalid(raw, `kind must be one of ${SECRET_SOURCE_KINDS.join(', ')}`, 'kind');
  }
  const result = kindSchemas[kind as SecretSourceKind].safeParse(raw);
  if (result.success) {
    return result.data as SecretSource;
  }
  const issue = result.error.issues[0];
  if (issue?.code === 'unrecognized_keys') {
    return invalid(raw, `unknown field ${issue.keys.join(', ')}`, issue.keys[0]);
  }
  const at = issue?.path[0];
  const fieldName = typeof at === 'string' ? at : undefined;
  const message = issue?.message ?? 'is not valid';
  return invalid(raw, fieldName !== undefined ? `${fieldName} ${message}` : message, fieldName);
}

/** Names that would set or shadow a prototype member of the plain-object maps. */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A `secretSources` value that is present but not a mapping: kept raw by the loaders, never lost on save. */
export function isNonMappingSecretSources(raw: unknown): boolean {
  return raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw));
}

function parseMap(
  raw: unknown,
  allowNone: boolean,
): { sources: Record<string, LocalSecretSource>; issues: SecretSourceIssue[] } {
  if (raw === undefined || raw === null) {
    return { sources: {}, issues: [] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { sources: {}, issues: [{ name: '', reason: 'secretSources must be a mapping' }] };
  }
  const sources: Record<string, LocalSecretSource> = {};
  const issues: SecretSourceIssue[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    let entry: LocalSecretSource;
    const isNone = typeof value === 'object' && value !== null && (value as Record<string, unknown>)['kind'] === 'none';
    if (FORBIDDEN_NAMES.has(name)) {
      entry = invalid(value, `"${name}" is not a usable name`);
    } else if (!SECRET_NAME_PATTERN.test(name)) {
      entry = invalid(value, 'the name must be letters, digits and "_", not starting with a digit');
    } else if (allowNone && isNone) {
      entry = Object.keys(value).length === 1 ? { kind: 'none' } : invalid(value, 'none takes no other field');
    } else {
      entry = parseSecretSource(value);
    }
    Object.defineProperty(sources, name, { value: entry, enumerable: true, writable: true, configurable: true });
    if (entry.kind === 'invalid') {
      issues.push({ name, reason: entry.reason, ...(entry.field !== undefined ? { field: entry.field } : {}) });
    }
  }
  return { sources, issues };
}

/** The shared map from `workspace.yaml`. `{ kind: none }` is not allowed here. */
export function parseSecretSources(raw: unknown): { sources: SharedSecretSources; issues: SecretSourceIssue[] } {
  const { sources, issues } = parseMap(raw, false);
  return { sources: sources as SharedSecretSources, issues };
}

/** The machine-local map from `local.yaml`, where `{ kind: none }` unmaps a shared name. */
export function parseLocalSecretSources(raw: unknown): { sources: LocalSecretSources; issues: SecretSourceIssue[] } {
  return parseMap(raw, true);
}

/** Shared entries, each replaced by a local one of the same name; a local `none` removes the name. */
export function effectiveSecretSources(
  shared: SharedSecretSources | undefined,
  local: LocalSecretSources | undefined,
): EffectiveSecretSources {
  const effective = new Map<string, EffectiveSecretSource>();
  for (const [name, source] of Object.entries(shared ?? {})) {
    effective.set(name, { source, origin: 'shared' });
  }
  for (const [name, source] of Object.entries(local ?? {})) {
    if (source.kind === 'none') {
      effective.delete(name);
    } else {
      effective.set(name, { source, origin: 'local' });
    }
  }
  return effective;
}

/** The YAML form: keys sorted, an invalid entry as its raw value, so a save never rewrites what it could not read. */
export function serializeSecretSources(sources: Readonly<Record<string, LocalSecretSource>>): Record<string, unknown> {
  // A null-prototype object and `defineProperty`: a raw `__proto__` entry must stay an own key, not set the prototype.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of Object.keys(sources).sort()) {
    const source = sources[name];
    if (source !== undefined) {
      Object.defineProperty(out, name, {
        value: source.kind === 'invalid' ? source.raw : { ...source },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return out;
}
