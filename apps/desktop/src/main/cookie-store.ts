/**
 * The workspace cookie jars (cookie jar spec §2): one engine `CookieJar` per workspace id, the open
 * workspace's backing every desktop send.
 *
 * Only cookies with an expiry are saved, encrypted as one blob through the OS keychain
 * (`safeStorage`, the backend `secrets.ts` uses), to `<userData>/cookies/<workspaceId>.json`.
 * Session cookies never reach disk. With no secure storage nothing does: cookies are never written
 * in plain text. Writes are atomic and debounced, and are flushed on a workspace switch and on quit.
 * A file from a newer build is left alone, and an unreadable one is set aside as `.corrupt`.
 */
import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CookieJar, nodeFs, writeFileAtomic } from '@wirebench/engine';
import type { CookieJarHost, CookieKey, StoredCookie } from '@wirebench/engine';
import type { CryptoBackend } from './secrets.js';

/** The folder under `userData` the cookie files live in. */
export const COOKIES_DIR = 'cookies';
/** The cookie file format this build writes and reads. */
export const COOKIE_FILE_VERSION = 1;
const DEFAULT_DEBOUNCE_MS = 1000;
/** The jar sends use while no workspace is open: session only, never saved. */
const NO_WORKSPACE = '';
/** A workspace id becomes a file name here; anything else stays session only. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** What `cookies.*` answers and `cookies.changed` carries (spec §2.2). */
export interface CookieJarState {
  readonly cookies: StoredCookie[];
  /** False when nothing is saved: no secure storage, no workspace, or a file this build may not read. */
  readonly persisted: boolean;
}

export interface CookieStoreOptions {
  /** Electron's `userData`: the files go under `cookies/`. */
  readonly userDataDir: string;
  readonly crypto: CryptoBackend;
  /** Called with the open workspace's jar after every change to it. */
  readonly onChanged?: (state: CookieJarState) => void;
  /** Test-only; 1 s by default. */
  readonly debounceMs?: number;
  /** Test-only clock, in epoch ms. */
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

interface Entry {
  readonly jar: CookieJar;
  /** False for the no-workspace jar and for a file this build may not read: nothing is written. */
  readonly persistable: boolean;
  /** The JSON of the persistent cookies as last written or read, so a session-only change writes nothing. */
  saved: string;
  timer?: ReturnType<typeof setTimeout>;
  /** The write in flight or last queued, so writes for one workspace run in order. */
  writing: Promise<void>;
}

function sessionOnly(): Entry {
  return { jar: new CookieJar(), persistable: false, saved: '[]', writing: Promise.resolve() };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function isStoredCookie(value: unknown): value is StoredCookie {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const cookie = value as Record<string, unknown>;
  const sameSite = cookie['sameSite'];
  const expiresAt = cookie['expiresAt'];
  return (
    typeof cookie['name'] === 'string' &&
    typeof cookie['value'] === 'string' &&
    typeof cookie['domain'] === 'string' &&
    typeof cookie['hostOnly'] === 'boolean' &&
    typeof cookie['path'] === 'string' &&
    typeof cookie['secure'] === 'boolean' &&
    typeof cookie['httpOnly'] === 'boolean' &&
    typeof cookie['createdAt'] === 'number' &&
    (expiresAt === undefined || typeof expiresAt === 'number') &&
    (sameSite === undefined || sameSite === 'Strict' || sameSite === 'Lax' || sameSite === 'None')
  );
}

/** The decrypted list, or a throw when it is not one. */
function parseCookies(text: string): StoredCookie[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) {
    throw new Error('not a cookie list');
  }
  const list: unknown[] = value;
  if (!list.every(isStoredCookie)) {
    throw new Error('not a cookie list');
  }
  return list;
}

export class CookieStore {
  private readonly entries = new Map<string, Entry>();
  private currentId = NO_WORKSPACE;
  /** Switches run one after another, so a load never races the flush before it. */
  private switching: Promise<void> = Promise.resolve();

  constructor(private readonly options: CookieStoreOptions) {
    this.entries.set(NO_WORKSPACE, sessionOnly());
  }

  /**
   * Makes `workspaceId`'s jar the one sends use (`null`: no workspace), reading its file the first
   * time and flushing the jar it leaves. A workspace's jar stays in memory across switches.
   */
  switchTo(workspaceId: string | null): Promise<void> {
    const next = this.switching.then(async () => {
      const id = workspaceId ?? NO_WORKSPACE;
      if (id === this.currentId) {
        return;
      }
      await this.flushEntry(this.currentId).catch((error: unknown) => {
        this.warn(this.failure(error));
      });
      if (!this.entries.has(id)) {
        this.entries.set(id, await this.load(id));
      }
      this.currentId = id;
      this.announce();
    });
    this.switching = next.catch(() => undefined);
    return next;
  }

  /** What `SendHost.cookies` is: the jar of whichever workspace is open when a send reads or stores. */
  host(): CookieJarHost {
    return {
      cookiesFor: (url) => this.current().jar.cookiesFor(url, this.now()),
      remember: (url, cookies) => {
        const id = this.currentId;
        const verdicts = this.current().jar.store(url, cookies, this.now());
        if (cookies.length > 0) {
          this.changed(id);
        }
        return verdicts;
      },
    };
  }

  state(): CookieJarState {
    const entry = this.current();
    return {
      cookies: entry.jar.list(this.now()),
      persisted: entry.persistable && this.options.crypto.available,
    };
  }

  /** Stores `cookie`, first removing `replaces` when its identity changed (spec §3). */
  set(cookie: StoredCookie, replaces?: CookieKey): CookieJarState {
    const { jar } = this.current();
    if (replaces !== undefined) {
      jar.remove(replaces);
    }
    jar.set(cookie, this.now());
    return this.changed(this.currentId);
  }

  remove(key: CookieKey): CookieJarState {
    this.current().jar.remove(key);
    return this.changed(this.currentId);
  }

  removeDomain(domain: string): CookieJarState {
    this.current().jar.removeDomain(domain);
    return this.changed(this.currentId);
  }

  clear(): CookieJarState {
    this.current().jar.clear();
    return this.changed(this.currentId);
  }

  /** Writes every pending change now. Called on quit. */
  async flush(): Promise<void> {
    await this.switching;
    for (const id of [...this.entries.keys()]) {
      await this.flushEntry(id).catch((error: unknown) => {
        this.warn(this.failure(error));
      });
    }
  }

  /** Cancels every pending debounced write. Call after the quit-time flush. */
  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
        delete entry.timer;
      }
    }
  }

  /** Forgets a deleted workspace's jar and deletes its file. */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.switching;
    const entry = this.entries.get(workspaceId);
    if (entry?.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    this.entries.delete(workspaceId);
    await entry?.writing.catch(() => undefined);
    if (workspaceId === this.currentId) {
      this.currentId = NO_WORKSPACE;
      this.announce();
    }
    if (SAFE_ID.test(workspaceId)) {
      await rm(this.fileOf(workspaceId), { force: true });
    }
  }

  private current(): Entry {
    const entry = this.entries.get(this.currentId);
    if (entry !== undefined) {
      return entry;
    }
    const fresh = sessionOnly();
    this.entries.set(this.currentId, fresh);
    return fresh;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get dir(): string {
    return join(this.options.userDataDir, COOKIES_DIR);
  }

  private fileOf(workspaceId: string): string {
    return join(this.dir, `${workspaceId}.json`);
  }

  private warn(message: string): void {
    this.options.warn?.(message);
  }

  private failure(error: unknown): string {
    return `Saving the cookies failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  private announce(): CookieJarState {
    const state = this.state();
    this.options.onChanged?.(state);
    return state;
  }

  /** After any change to `id`'s jar: announce it if open, and schedule a write when what is saved changed. */
  private changed(id: string): CookieJarState {
    const entry = this.entries.get(id);
    if (entry !== undefined && entry.persistable && this.options.crypto.available) {
      if (JSON.stringify(entry.jar.persistent(this.now())) !== entry.saved) {
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
        }
        entry.timer = setTimeout(() => {
          this.flushEntry(id).catch((error: unknown) => {
            this.warn(this.failure(error));
          });
        }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
      }
    }
    return id === this.currentId ? this.announce() : this.state();
  }

  private flushEntry(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return Promise.resolve();
    }
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      delete entry.timer;
    }
    const run = entry.writing
      .catch(() => undefined)
      .then(async () => {
        if (!entry.persistable || !this.options.crypto.available || this.entries.get(id) !== entry) {
          return;
        }
        const json = JSON.stringify(entry.jar.persistent(this.now()));
        if (json === entry.saved) {
          return;
        }
        const data = this.options.crypto.encrypt(json).toString('base64');
        await writeFileAtomic(nodeFs, this.fileOf(id), JSON.stringify({ version: COOKIE_FILE_VERSION, data }));
        entry.saved = json;
      });
    entry.writing = run;
    return run;
  }

  private async load(id: string): Promise<Entry> {
    if (!SAFE_ID.test(id)) {
      return sessionOnly();
    }
    if (!this.options.crypto.available) {
      // The file may be perfectly good; without the keychain it can only be left alone, unread.
      return sessionOnly();
    }
    let text: string;
    try {
      text = await readFile(this.fileOf(id), 'utf8');
    } catch (error) {
      return isMissing(error)
        ? { jar: new CookieJar(), persistable: true, saved: '[]', writing: Promise.resolve() }
        : await this.setAside(id);
    }
    let file: unknown;
    try {
      file = JSON.parse(text);
    } catch {
      return await this.setAside(id);
    }
    const { version, data } = (typeof file === 'object' && file !== null ? file : {}) as Record<string, unknown>;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || typeof data !== 'string') {
      return await this.setAside(id);
    }
    if (version > COOKIE_FILE_VERSION) {
      this.warn(`The cookies of workspace ${id} were saved by a newer Wirebench; they are kept for this session only.`);
      return sessionOnly();
    }
    let cookies: StoredCookie[];
    try {
      cookies = parseCookies(this.options.crypto.decrypt(Buffer.from(data, 'base64')));
    } catch {
      return await this.setAside(id);
    }
    const jar = new CookieJar(cookies);
    return { jar, persistable: true, saved: JSON.stringify(jar.persistent(this.now())), writing: Promise.resolve() };
  }

  /** Renames an unreadable file to `<id>.json.corrupt` and starts that workspace empty. */
  private async setAside(id: string): Promise<Entry> {
    const file = this.fileOf(id);
    try {
      await rename(file, `${file}.corrupt`);
      this.warn(`The cookies of workspace ${id} could not be read; the file was set aside as ${id}.json.corrupt.`);
    } catch {
      this.warn(`The cookies of workspace ${id} could not be read, and the file could not be set aside.`);
    }
    return { jar: new CookieJar(), persistable: true, saved: '[]', writing: Promise.resolve() };
  }
}
