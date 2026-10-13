/**
 * The app's trusted host keys, as the CLI sees them (forwarding spec R11): read once, never written. A key
 * the file does not hold is refused unless `--host-key` names its fingerprint for this run.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkKnownHost, parseKnownHosts } from '#ssh';
import type { DialOptions, KnownHostEntry } from '#ssh';

/** Where the app keeps them: `<userData>/ssh-known-hosts.json`, beside History. */
export function defaultKnownHostsFile(userDataDir: string): string {
  return join(userDataDir, 'ssh-known-hosts.json');
}

/** The file could not be read (other than not existing). */
export class KnownHostsUnreadable extends Error {
  constructor(
    readonly file: string,
    readonly errno: string | undefined,
  ) {
    super(`the trusted host keys file could not be read (${errno ?? 'unknown error'}): ${file}`);
  }
}

/** The trusted keys; a missing file is none. */
export async function readKnownHostsFile(file: string): Promise<readonly KnownHostEntry[]> {
  try {
    return parseKnownHosts(await readFile(file, 'utf8'));
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') return [];
    throw new KnownHostsUnreadable(file, errno);
  }
}

/** A key the verifier turned away, and the trusted one it differs from when the host's key changed. */
export interface HostKeyRefusal {
  readonly key: KnownHostEntry;
  readonly previous?: string;
}

/**
 * Accepts a key the file trusts or one whose fingerprint `accepted` names (on any hop); records any other in
 * `refusals`, keyed by `address:port`, so the refusal can be explained.
 */
export function cliHostKeyVerifier(
  known: readonly KnownHostEntry[],
  accepted: readonly string[],
  refusals: Map<string, HostKeyRefusal>,
): DialOptions['verifyHostKey'] {
  // A fingerprint is compared without base64 padding, which `fingerprintOf` never writes.
  const acceptedKeys = new Set(accepted.map((fingerprint) => fingerprint.replace(/=+$/, '')));
  return (_hop, key) => {
    if (checkKnownHost(known, key) === 'known' || acceptedKeys.has(key.fingerprint)) {
      return Promise.resolve('accept');
    }
    const previous = known.find((entry) => entry.host === key.host && entry.keyType === key.keyType);
    refusals.set(key.host, { key, ...(previous ? { previous: previous.fingerprint } : {}) });
    return Promise.resolve('reject');
  };
}
