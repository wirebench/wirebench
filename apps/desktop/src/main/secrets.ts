/**
 * Keychain-backed secret store: `userData/secrets.json` holding `{ version: 2, entries }` where
 * every entry is `{ value, encrypted, label?, createdAt }` — an encrypted-then-base64 blob, never
 * plaintext. The `encrypted` flag is per entry so a file written across a keyring-availability
 * change stays fully readable (v1 files, which carried one file-global flag, are migrated on
 * load by stamping that flag onto every entry).
 *
 * Values are encrypted with Electron's `safeStorage` (OS keychain / DPAPI / libsecret). When
 * `safeStorage.isEncryptionAvailable()` is `false` (some headless Linux CI/dev setups have no
 * keyring), we fall back to storing base64 of the plaintext, flag the file `encrypted: false`,
 * and log a single warning — the same degrade-gracefully approach Electron apps like VS Code
 * take, rather than refusing to run at all. This is why the crypto backend is injected: tests
 * must never depend on the real OS keychain, so they pass a fake `CryptoBackend`.
 *
 * No `secrets.get` IPC channel exists — the renderer can set/replace/exists/delete/list, but
 * can never read a value back. Resolution happens only in main (see `secret-resolver.ts`).
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The pluggable encryption backend. Electron's `safeStorage` satisfies this shape directly. */
export interface CryptoBackend {
  /** Whether encryption is available on this platform right now. */
  readonly available: boolean;
  encrypt(text: string): Buffer;
  decrypt(buffer: Buffer): string;
}

/** File name (inside `userData`) the secret store is persisted to. */
export const SECRETS_FILE = 'secrets.json';

interface SecretEntry {
  /** Base64 of the encrypted value (or of the raw plaintext bytes, when `encrypted` is false). */
  readonly value: string;
  /**
   * Whether THIS entry's bytes are `safeStorage`-encrypted. Per entry, not per file: keyring
   * availability can change between two writes (a keyring that starts later, a profile moved
   * between machines), and a file-global flag would then claim the wrong encoding for every
   * previously written entry and corrupt them on read.
   */
  readonly encrypted: boolean;
  readonly label?: string;
  readonly createdAt: string;
}

interface SecretsFile {
  readonly version: 2;
  readonly entries: Record<string, SecretEntry>;
}

/** The v1 shape: one file-global `encrypted` flag, migrated onto every entry on load. */
interface SecretsFileV1 {
  readonly version: 1;
  readonly encrypted: boolean;
  readonly entries: Record<string, { value: string; label?: string; createdAt: string }>;
}

/** One entry as listed by {@link SecretStore.list}: never the value. */
export interface SecretListEntry {
  readonly ref: string;
  readonly label?: string;
  readonly createdAt: string;
}

function emptyFile(): SecretsFile {
  return { version: 2, entries: {} };
}

function hasEntries(document: unknown, version: number): boolean {
  if (typeof document !== 'object' || document === null) {
    return false;
  }
  const candidate = document as { version?: unknown; entries?: unknown };
  return candidate.version === version && typeof candidate.entries === 'object' && candidate.entries !== null;
}

/** Migrates a v1 file (file-global `encrypted`) by stamping that flag onto every entry. */
function migrateV1(file: SecretsFileV1): SecretsFile {
  const entries: Record<string, SecretEntry> = {};
  for (const [ref, entry] of Object.entries(file.entries)) {
    entries[ref] = {
      value: entry.value,
      encrypted: file.encrypted,
      createdAt: entry.createdAt,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
    };
  }
  return { version: 2, entries };
}

/** Parses whatever is on disk into the current shape, migrating v1 and rejecting anything else. */
function parseSecretsFile(document: unknown): SecretsFile | undefined {
  if (hasEntries(document, 2)) {
    return document as SecretsFile;
  }
  if (hasEntries(document, 1)) {
    return migrateV1(document as SecretsFileV1);
  }
  return undefined;
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, data, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Generates a `sec_` + 26 random base36-ish hex-derived id secret reference. */
function generateRef(): string {
  return `sec_${randomBytes(20).toString('hex').slice(0, 26)}`;
}

/**
 * Owns the secret store for one `userData` directory. Writes are serialised (a promise chain,
 * matching `GlobalProperties`) so overlapping `set`/`replace`/`delete` calls cannot race each
 * other into a lost update. `ready()` must resolve before any read/write in a fresh instance.
 */
export class SecretStore {
  private readonly file: string;
  private readonly crypto: CryptoBackend;
  private data: SecretsFile = emptyFile();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private warnedFallback = false;
  private readonly log: (message: string) => void;
  private queue: Promise<void> = Promise.resolve();

  constructor(userDataDir: string, crypto: CryptoBackend, log: (message: string) => void = console.warn) {
    this.file = join(userDataDir, SECRETS_FILE);
    this.crypto = crypto;
    this.log = log;
  }

  /** Reads the file into memory. Safe to call more than once — concurrent calls share one read. */
  ready(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      this.data = emptyFile();
      this.loaded = true;
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      this.data = parseSecretsFile(parsed) ?? emptyFile();
    } catch {
      this.data = emptyFile();
    }
    this.loaded = true;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.ready();
    }
  }

  private warnFallbackOnce(): void {
    if (!this.warnedFallback) {
      this.warnedFallback = true;
      this.log(
        '[wirebench] OS keychain encryption is unavailable; secrets are stored base64-encoded ' +
          'but NOT encrypted at rest. This is expected on some headless Linux setups.',
      );
    }
  }

  private encode(value: string): { blob: string; encrypted: boolean } {
    if (this.crypto.available) {
      return { blob: this.crypto.encrypt(value).toString('base64'), encrypted: true };
    }
    this.warnFallbackOnce();
    return { blob: Buffer.from(value, 'utf8').toString('base64'), encrypted: false };
  }

  private decode(blob: string, encrypted: boolean): string {
    const buffer = Buffer.from(blob, 'base64');
    return encrypted ? this.crypto.decrypt(buffer) : buffer.toString('utf8');
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeAtomic(this.file, JSON.stringify(this.data, null, 2));
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      await this.ensureLoaded();
      return op();
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Encrypts and stores `value`, returning a fresh `secretRef`. */
  set(value: string, opts?: { label?: string }): Promise<string> {
    return this.enqueue(async () => {
      const ref = generateRef();
      const { blob, encrypted } = this.encode(value);
      const entry: SecretEntry = {
        value: blob,
        encrypted,
        createdAt: new Date().toISOString(),
        ...(opts?.label !== undefined ? { label: opts.label } : {}),
      };
      this.data = { version: 2, entries: { ...this.data.entries, [ref]: entry } };
      await this.persist();
      return ref;
    });
  }

  /** Replaces the value stored under an existing `ref`, keeping the same ref and label. */
  replace(ref: string, value: string): Promise<string> {
    return this.enqueue(async () => {
      const existing = this.data.entries[ref];
      const { blob, encrypted } = this.encode(value);
      const entry: SecretEntry = {
        value: blob,
        encrypted,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        ...(existing?.label !== undefined ? { label: existing.label } : {}),
      };
      this.data = { version: 2, entries: { ...this.data.entries, [ref]: entry } };
      await this.persist();
      return ref;
    });
  }

  /** Resolves a `secretRef` to its plaintext value, or `undefined` when the ref is unknown. */
  async get(ref: string): Promise<string | undefined> {
    await this.ensureLoaded();
    const entry = this.data.entries[ref];
    if (!entry) {
      return undefined;
    }
    return this.decode(entry.value, entry.encrypted);
  }

  async exists(ref: string): Promise<boolean> {
    await this.ensureLoaded();
    return ref in this.data.entries;
  }

  delete(ref: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (!(ref in this.data.entries)) {
        return false;
      }
      const entries = { ...this.data.entries };
      delete entries[ref];
      this.data = { ...this.data, entries };
      await this.persist();
      return true;
    });
  }

  async list(): Promise<SecretListEntry[]> {
    await this.ensureLoaded();
    return Object.entries(this.data.entries).map(([ref, entry]) => ({
      ref,
      createdAt: entry.createdAt,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
    }));
  }
}

/**
 * The session-only (never persisted) "show secrets" toggle: when on, `redact.ts` callers pass
 * `{ show: true }` and the HTTP log/history shows real values instead of `<redacted>`. Reset to
 * `false` on every app launch — it is a deliberate, temporary bypass, not a setting.
 */
export class ShowSecretsFlag {
  private show = false;

  get(): boolean {
    return this.show;
  }

  set(show: boolean): void {
    this.show = show;
  }
}

/** Wraps Electron's `safeStorage` module as a {@link CryptoBackend}. */
export function safeStorageBackend(safeStorage: {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(buffer: Buffer): string;
}): CryptoBackend {
  return {
    get available() {
      return safeStorage.isEncryptionAvailable();
    },
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buffer) => safeStorage.decryptString(buffer),
  };
}
