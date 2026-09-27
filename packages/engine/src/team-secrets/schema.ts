/**
 * The three kinds of file under `team-secrets/` (§4): key requests, access-log entries and vault entries,
 * one YAML document each, written by the engine's serializer. Binary fields are base64url without padding.
 * Parsing never throws: a malformed or misnamed file is listed in `invalid` and otherwise ignored.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseYaml, stringifyYaml } from '../project/yaml.js';
import { SECRET_NAME_PATTERN } from '../secrets/secret-token.js';
import { TEAM_SECRETS_DIR } from '../workspace/paths.js';
import { base32, KEY_ID_PATTERN } from './keys.js';

export const TEAM_SECRETS_FORMAT_VERSION = 1;

/**
 * A Crockford-base32 ULID, as `ulidx` writes it. The first character is restricted to `0`-`7`: a ULID's
 * 48-bit timestamp fills at most that much of the first base32 group, so a wider first character (a
 * corrupted or adversarial id) would decode to a timestamp `ulidx`'s `decodeTime` rejects outright — this
 * pattern keeps that failure at parse time instead of wherever `decodeTime` is next called.
 */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const base64urlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
/** 32 bytes as base64url without padding. */
const publicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** An Ed25519 signature: 64 bytes as base64url without padding, always exactly 86 characters. */
const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const isoSchema = z.iso.datetime({ offset: true });

export const keyIdSchema = z.string().regex(KEY_ID_PATTERN);

export const keyRequestFileSchema = z.strictObject({
  version: z.literal(TEAM_SECRETS_FORMAT_VERSION),
  keyId: keyIdSchema,
  encryptionKey: publicKeySchema,
  signingKey: publicKeySchema,
  name: z.string().min(1).max(200),
  email: z.string().max(320),
  machine: z.string().min(1).max(200),
  requestedAt: isoSchema,
  signature: signatureSchema,
});
export type KeyRequestFile = z.infer<typeof keyRequestFileSchema>;

export const ACCESS_ACTIONS = ['genesis', 'approve', 'remove', 'grant-admin', 'revoke-admin'] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

/** `authority` is the genesis entry's own field: present exactly when `action === 'genesis'`. */
export const accessEntryFileSchema = z
  .strictObject({
    version: z.literal(TEAM_SECRETS_FORMAT_VERSION),
    id: z.string().regex(ULID_PATTERN),
    action: z.enum(ACCESS_ACTIONS),
    authority: z.enum(['signed', 'server']).optional(),
    key: keyIdSchema,
    by: keyIdSchema,
    at: isoSchema,
    signature: signatureSchema,
  })
  .refine((entry) => (entry.action === 'genesis') === (entry.authority !== undefined), {
    message: 'authority is required on a genesis entry and forbidden on any other action',
  });
export type AccessEntryFile = z.infer<typeof accessEntryFileSchema>;

/** Which secret an entry holds: a keychain ref as the tree names it, or a `${secret:name}` token of one project. */
export const secretKeySchema = z.union([
  z.strictObject({ ref: z.string().min(1).max(200) }),
  z.strictObject({
    token: z.strictObject({ projectId: z.string().min(1).max(200), name: z.string().regex(SECRET_NAME_PATTERN) }),
  }),
]);
export type SecretKey = z.infer<typeof secretKeySchema>;

export const vaultEntryFileSchema = z.strictObject({
  version: z.literal(TEAM_SECRETS_FORMAT_VERSION),
  secret: secretKeySchema,
  /** The display label, never the value. */
  label: z.string().max(200),
  cipher: base64urlSchema,
  wraps: z.record(keyIdSchema, base64urlSchema),
  /** When the value was last set; rewraps keep it (plan decision 5). */
  updatedAt: isoSchema,
  /** The key that signed this version. */
  updatedBy: keyIdSchema,
  signature: signatureSchema,
});
export type VaultEntryFile = z.infer<typeof vaultEntryFileSchema>;

export const TEAM_SECRETS_KEYS_DIR = `${TEAM_SECRETS_DIR}/keys`;
export const TEAM_SECRETS_ACCESS_DIR = `${TEAM_SECRETS_DIR}/access`;
export const TEAM_SECRETS_VALUES_DIR = `${TEAM_SECRETS_DIR}/values`;

export function keyRequestPath(keyId: string): string {
  return `${TEAM_SECRETS_KEYS_DIR}/${keyId}.yaml`;
}

export function accessEntryPath(id: string): string {
  return `${TEAM_SECRETS_ACCESS_DIR}/${id}.yaml`;
}

export function vaultEntryPath(id: string): string {
  return `${TEAM_SECRETS_VALUES_DIR}/${id}.yaml`;
}

const TEAM_SECRETS_FILE = new RegExp(`^${TEAM_SECRETS_DIR}/(keys|access|values)/([0-9A-Z]{26})\\.yaml$`);

export function isTeamSecretsPath(path: string): boolean {
  return TEAM_SECRETS_FILE.test(path);
}

export function isVaultEntryPath(path: string): boolean {
  return TEAM_SECRETS_FILE.exec(path)?.[1] === 'values';
}

export function vaultEntryIdOfPath(path: string): string | undefined {
  const match = TEAM_SECRETS_FILE.exec(path);
  return match?.[1] === 'values' ? match[2] : undefined;
}

/** Plan decision 3: base32 of SHA-256 over `ref:<ref>` or `token:<projectId>\n<name>`, first 26 characters. */
export function vaultEntryId(secret: SecretKey): string {
  const text = 'ref' in secret ? `ref:${secret.ref}` : `token:${secret.token.projectId}\n${secret.token.name}`;
  return base32(createHash('sha256').update(text, 'utf8').digest()).slice(0, 26);
}

export function sameSecret(a: SecretKey, b: SecretKey): boolean {
  return vaultEntryId(a) === vaultEntryId(b);
}

export function teamSecretsFileText(doc: object): string {
  return stringifyYaml(doc);
}

export function parseTeamSecretsFile<S extends z.ZodType>(schema: S, text: string): z.infer<S> | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(text, 'team-secrets');
  } catch {
    return undefined;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** Everything under `team-secrets/`, parsed. `values` is keyed by the file's id. */
export interface TeamSecretsFiles {
  readonly keys: KeyRequestFile[];
  readonly access: AccessEntryFile[];
  readonly values: Map<string, VaultEntryFile>;
  /** Tree paths that are malformed, or whose name is not their id. */
  readonly invalid: string[];
}

/** Parses the tree's team-secrets files, given as tree path → text. Other paths are ignored. */
export function readTeamSecretsFiles(files: ReadonlyMap<string, string>): TeamSecretsFiles {
  const out: TeamSecretsFiles = { keys: [], access: [], values: new Map(), invalid: [] };
  for (const [path, text] of files) {
    const match = TEAM_SECRETS_FILE.exec(path);
    if (match === null) {
      continue;
    }
    const [, kind, name] = match;
    if (kind === 'keys') {
      const doc = parseTeamSecretsFile(keyRequestFileSchema, text);
      if (doc !== undefined && doc.keyId === name) {
        out.keys.push(doc);
      } else {
        out.invalid.push(path);
      }
    } else if (kind === 'access') {
      const doc = parseTeamSecretsFile(accessEntryFileSchema, text);
      if (doc !== undefined && doc.id === name) {
        out.access.push(doc);
      } else {
        out.invalid.push(path);
      }
    } else {
      const doc = parseTeamSecretsFile(vaultEntryFileSchema, text);
      if (doc !== undefined && name !== undefined && vaultEntryId(doc.secret) === name) {
        out.values.set(name, doc);
      } else {
        out.invalid.push(path);
      }
    }
  }
  return out;
}
