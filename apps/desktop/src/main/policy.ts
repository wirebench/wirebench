/**
 * Managed preferences: a policy file an administrator places at a system location to lock
 * settings on a managed machine.
 *
 * The file has the same shape as `preferences.yaml`, and every key it sets is *locked*: the value
 * is laid over the user's own preferences and `PreferencesService.update` refuses to change it.
 * Only the settings IT actually needs to control can be locked — the proxy, the TLS minimum and
 * CA bundle, and update checks ({@link LOCKABLE_KEYS}). Anything else in the file is reported as
 * ignored rather than silently honoured, so an administrator learns at once that a key does
 * nothing.
 *
 * The file is read once at startup. It is not watched: a policy that changed mid-session would
 * have to re-lock controls the user is editing, and a restart is what managed machines expect.
 *
 * No `electron` import, for the same reason as `preferences.ts`: the caller passes the platform
 * and environment in, which keeps this unit-testable.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, posix, win32 } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { mergePreferences, preferencesSchema } from '@wirebench/engine';
import type { Preferences, PreferencesPatch } from '@wirebench/engine';

/** File name of the policy inside its per-OS directory. */
export const POLICY_FILE = 'policy.yaml';

/**
 * The keys a policy may lock, per section. The proxy password is deliberately absent: it is a
 * reference into the user's own keychain, never a value a file could carry.
 */
export const LOCKABLE_KEYS = {
  proxy: ['mode', 'host', 'port', 'username', 'excludes'],
  ssl: ['minVersion', 'caBundlePath'],
  updates: ['checkOnLaunch'],
} as const;

type LockableSection = keyof typeof LOCKABLE_KEYS;

/** The policy as loaded: what it sets, which keys that locks, and what it could not apply. */
export interface Policy {
  /** Where the policy was looked for, whether or not a file was there. */
  readonly path: string;
  /** The locked values, as a preferences patch. Empty when there is no policy. */
  readonly patch: PreferencesPatch;
  /** Dotted keys (`proxy.mode`) the policy locks. */
  readonly locked: readonly string[];
  /** Dotted keys the file sets that cannot be locked, or whose value is not valid. */
  readonly ignored: readonly string[];
  /** Why the file could not be read or parsed; no key is locked when this is set. */
  readonly error?: string;
}

/** The policy of a machine with no policy file. */
export function noPolicy(path: string): Policy {
  return { path, patch: {}, locked: [], ignored: [] };
}

/**
 * Where the policy file lives on this OS — a directory only an administrator can write:
 * `%ProgramData%\Wirebench` on Windows, `/Library/Application Support/Wirebench` on macOS and
 * `/etc/wirebench` elsewhere.
 *
 * `WIREBENCH_POLICY_FILE` replaces the path, but only in an unpackaged build (development and
 * e2e): in a shipped app an environment variable is something the user controls, and a policy
 * the user can point elsewhere locks nothing.
 */
export function policyFilePath(input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
}): string {
  const override = input.isPackaged ? undefined : input.env['WIREBENCH_POLICY_FILE'];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  switch (input.platform) {
    case 'win32':
      return win32.join(input.env['ProgramData'] ?? 'C:\\ProgramData', 'Wirebench', POLICY_FILE);
    case 'darwin':
      return posix.join('/Library/Application Support/Wirebench', POLICY_FILE);
    default:
      return posix.join('/etc/wirebench', POLICY_FILE);
  }
}

function isLockable(section: string): section is LockableSection {
  return Object.hasOwn(LOCKABLE_KEYS, section);
}

/** Validates one key's value against the preferences schema; `undefined` when it does not parse. */
function validValue(section: LockableSection, key: string, value: unknown): unknown {
  const parsed = preferencesSchema.shape[section].safeParse({ [key]: value });
  const accepted = parsed.success ? (parsed.data as Record<string, unknown> | undefined)?.[key] : undefined;
  // A CA bundle is read on every send: a relative path would resolve against wherever the app
  // happened to start, so only an absolute one (or '' for "no bundle") is accepted.
  if (section === 'ssl' && key === 'caBundlePath' && typeof accepted === 'string' && accepted.length > 0) {
    return isAbsolute(accepted) || win32.isAbsolute(accepted) ? accepted : undefined;
  }
  return accepted;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turns a parsed policy document into a {@link Policy}. Tolerant per key, like
 * `mergePreferences`: one bad value loses that key, not the whole policy.
 */
export function parsePolicy(path: string, document: unknown): Policy {
  if (document === undefined || document === null) {
    return noPolicy(path);
  }
  if (!isMapping(document)) {
    return { ...noPolicy(path), error: 'The policy file is not a YAML mapping' };
  }
  const patch: Record<string, Record<string, unknown>> = {};
  const locked: string[] = [];
  const ignored: string[] = [];
  for (const [section, values] of Object.entries(document)) {
    if (section === 'version') {
      continue;
    }
    if (!isLockable(section) || !isMapping(values)) {
      ignored.push(section);
      continue;
    }
    const allowed: readonly string[] = LOCKABLE_KEYS[section];
    for (const [key, value] of Object.entries(values)) {
      const accepted = allowed.includes(key) ? validValue(section, key, value) : undefined;
      if (accepted === undefined) {
        ignored.push(`${section}.${key}`);
        continue;
      }
      (patch[section] ??= {})[key] = accepted;
      locked.push(`${section}.${key}`);
    }
  }
  return { path, patch, locked, ignored };
}

/**
 * Reads the policy file at `path`. A missing file is the ordinary case (an unmanaged machine)
 * and yields no policy; a file that exists but cannot be read or parsed yields no locks *and* an
 * error, which Preferences shows so the administrator is not left guessing.
 */
export async function loadPolicy(path: string): Promise<Policy> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return noPolicy(path);
    }
    return { ...noPolicy(path), error: `The policy file could not be read: ${(error as Error).message}` };
  }
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    return { ...noPolicy(path), error: `The policy file is not valid YAML: ${(error as Error).message}` };
  }
  return parsePolicy(path, document);
}

/**
 * The preferences in force: the user's document with the policy's values laid over it.
 *
 * A CA bundle the policy names counts as picked by main: the file it comes from sits where only
 * an administrator can write, which is at least the evidence a native-dialog pick is, so it is
 * trusted (see `rememberPickedCaBundle`) without the user picking it.
 */
export function applyPolicy(user: Preferences, policy: Policy): Preferences {
  if (policy.locked.length === 0) {
    return user;
  }
  const effective = mergePreferences(policy.patch, user);
  const caBundlePath = policy.patch.ssl?.caBundlePath;
  if (caBundlePath === undefined) {
    return effective;
  }
  return { ...effective, ssl: { ...effective.ssl, caBundlePickedByMain: caBundlePath.length > 0 } };
}

/** The dotted keys of `patch` that `policy` locks. */
export function lockedKeysIn(patch: PreferencesPatch, policy: Policy): string[] {
  const touched: string[] = [];
  for (const [section, values] of Object.entries(patch)) {
    if (!isMapping(values)) {
      continue;
    }
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && policy.locked.includes(`${section}.${key}`)) {
        touched.push(`${section}.${key}`);
      }
    }
  }
  return touched;
}
