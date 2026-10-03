// @vitest-environment node
/**
 * The workspace cookie jars (cookie jar spec §2.1). What matters most is what reaches disk: only
 * cookies with an expiry, only encrypted, never without secure storage, and never over a file a
 * newer build wrote.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cookie } from '@wirebench/engine';
import { COOKIES_DIR, CookieStore, type CookieJarState, type CookieStoreOptions } from '../src/main/cookie-store.js';
import type { CryptoBackend } from '../src/main/secrets.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const VALUE = 'cookie-value-that-must-not-leak';
const LOGIN: Cookie[] = [
  { name: 'sid', value: VALUE, path: '/', maxAge: 3600 },
  { name: 'tmp', value: 'session-only', path: '/' },
];

/** Encrypts by prefixing, so a test can read what was "encrypted" and spot a file it did not write. */
function fakeCrypto(available = true): CryptoBackend {
  return {
    available,
    encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decrypt: (buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc:')) {
        throw new Error('not ours');
      }
      return text.slice('enc:'.length);
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-cookie-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function store(extra: Partial<CookieStoreOptions> = {}): CookieStore {
  return new CookieStore({ userDataDir: dir, crypto: fakeCrypto(), now: () => NOW, debounceMs: 60_000, ...extra });
}

function fileOf(id: string): string {
  return join(dir, COOKIES_DIR, `${id}.json`);
}

function names(state: CookieJarState): string[] {
  return state.cookies.map((cookie) => cookie.name);
}

describe('CookieStore — what reaches disk', () => {
  it('saves only cookies with an expiry, encrypted, and reads them back', async () => {
    const first = store();
    await first.switchTo('w1');
    first.host().remember('https://api.test/login', LOGIN);
    await first.flush();

    const raw = readFileSync(fileOf('w1'), 'utf8');
    expect(raw).not.toContain(VALUE);
    const file = JSON.parse(raw) as { version: number; data: string };
    expect(file.version).toBe(1);
    const saved = JSON.parse(Buffer.from(file.data, 'base64').toString('utf8').slice('enc:'.length)) as Cookie[];
    expect(saved.map((cookie) => cookie.name)).toEqual(['sid']);

    const second = store();
    await second.switchTo('w1');
    expect(second.state()).toEqual({
      cookies: [expect.objectContaining({ name: 'sid', value: VALUE, expiresAt: NOW + 3_600_000 })],
      persisted: true,
    });
  });

  it('writes nothing for a change to session cookies alone', async () => {
    const s = store();
    await s.switchTo('w1');
    s.host().remember('https://api.test/', [{ name: 'tmp', value: '1', path: '/' }]);
    await s.flush();
    expect(existsSync(fileOf('w1'))).toBe(false);
  });

  it('writes nothing without secure storage, and says so', async () => {
    const s = store({ crypto: fakeCrypto(false) });
    await s.switchTo('w1');
    s.host().remember('https://api.test/login', LOGIN);
    await s.flush();
    expect(existsSync(fileOf('w1'))).toBe(false);
    expect(s.state().persisted).toBe(false);
    expect(names(s.state())).toEqual(['sid', 'tmp']);
  });

  it('refuses a file a newer build wrote: session only, a warning, and the file left alone', async () => {
    mkdirSync(join(dir, COOKIES_DIR), { recursive: true });
    const newer = JSON.stringify({ version: 2, data: 'opaque' });
    writeFileSync(fileOf('w1'), newer);
    const warn = vi.fn();
    const s = store({ warn });
    await s.switchTo('w1');
    expect(s.state()).toEqual({ cookies: [], persisted: false });
    expect(warn).toHaveBeenCalledOnce();
    s.host().remember('https://api.test/login', LOGIN);
    await s.flush();
    expect(readFileSync(fileOf('w1'), 'utf8')).toBe(newer);
  });

  it.each([
    ['not JSON', 'not json'],
    ['not decryptable', JSON.stringify({ version: 1, data: Buffer.from('garbage').toString('base64') })],
    ['not a cookie list', JSON.stringify({ version: 1, data: Buffer.from('enc:{"a":1}').toString('base64') })],
  ])('sets a file that is %s aside as .corrupt and starts empty', async (_label, text) => {
    mkdirSync(join(dir, COOKIES_DIR), { recursive: true });
    writeFileSync(fileOf('w1'), text);
    const s = store({ warn: vi.fn() });
    await s.switchTo('w1');
    expect(s.state()).toEqual({ cookies: [], persisted: true });
    expect(existsSync(fileOf('w1'))).toBe(false);
    expect(readFileSync(`${fileOf('w1')}.corrupt`, 'utf8')).toBe(text);
  });

  it('drops cookies that expired while the file sat on disk', async () => {
    const first = store();
    await first.switchTo('w1');
    first.host().remember('https://api.test/', [{ name: 'short', value: '1', path: '/', maxAge: 60 }]);
    await first.flush();
    const later = store({ now: () => NOW + 61_000 });
    await later.switchTo('w1');
    expect(later.state().cookies).toEqual([]);
  });
});

describe('CookieStore — when it writes', () => {
  it('debounces a write, and a flush (as on quit) writes at once', async () => {
    const s = store();
    await s.switchTo('w1');
    s.host().remember('https://api.test/login', LOGIN);
    expect(existsSync(fileOf('w1'))).toBe(false);
    await s.flush();
    expect(existsSync(fileOf('w1'))).toBe(true);
  });

  it('writes on its own once the debounce ends', async () => {
    const s = store({ debounceMs: 10 });
    await s.switchTo('w1');
    s.host().remember('https://api.test/login', LOGIN);
    await vi.waitFor(() => {
      expect(existsSync(fileOf('w1'))).toBe(true);
    });
  });

  it('keeps one jar per workspace, and flushes the one it leaves', async () => {
    const s = store();
    await s.switchTo('w1');
    s.host().remember('https://api.test/login', LOGIN);
    await s.switchTo('w2');
    expect(existsSync(fileOf('w1'))).toBe(true);
    expect(s.state().cookies).toEqual([]);
    await s.switchTo('w1');
    // The session cookie stayed in memory: switching back restores the whole jar.
    expect(names(s.state())).toEqual(['sid', 'tmp']);
  });

  it('keeps the jar of no workspace in memory only', async () => {
    const s = store();
    await s.switchTo(null);
    s.host().remember('https://api.test/login', LOGIN);
    await s.flush();
    expect(existsSync(join(dir, COOKIES_DIR))).toBe(false);
    expect(s.state().persisted).toBe(false);
  });

  it('deletes a workspace file and jar with the workspace', async () => {
    const s = store();
    await s.switchTo('w1');
    s.host().remember('https://api.test/login', LOGIN);
    await s.flush();
    await s.deleteWorkspace('w1');
    expect(existsSync(fileOf('w1'))).toBe(false);
    expect(s.state()).toEqual({ cookies: [], persisted: false });
  });
});

describe('CookieStore — edits', () => {
  it('answers every edit with the whole jar, and announces each change', async () => {
    const changes: CookieJarState[] = [];
    const s = store({ onChanged: (state) => changes.push(state) });
    await s.switchTo('w1');
    s.host().remember('https://api.test/login', LOGIN);
    const sid = s.state().cookies[0]!;

    const moved = s.set({ ...sid, path: '/v2' }, { name: 'sid', domain: 'api.test', path: '/' });
    expect(moved.cookies.map((cookie) => `${cookie.name}@${cookie.path}`)).toEqual(['sid@/v2', 'tmp@/']);
    expect(names(s.remove({ name: 'tmp', domain: 'api.test', path: '/' }))).toEqual(['sid']);
    s.host().remember('https://other.test/', [{ name: 'o', value: '1', path: '/' }]);
    expect(s.removeDomain('other.test').cookies.map((cookie) => cookie.domain)).toEqual(['api.test']);
    expect(s.clear()).toEqual({ cookies: [], persisted: true });

    expect(changes.length).toBeGreaterThanOrEqual(6);
    expect(changes.at(-1)).toEqual({ cookies: [], persisted: true });
  });
});

describe('CookieStore — no secure storage at load', () => {
  it('leaves an existing file untouched and keeps a session-only jar', async () => {
    const first = store();
    await first.switchTo('w1');
    first.host().remember('https://api.test/login', LOGIN);
    await first.flush();
    const before = readFileSync(fileOf('w1'), 'utf8');

    const s = store({ crypto: fakeCrypto(false) });
    await s.switchTo('w1');
    expect(s.state()).toEqual({ cookies: [], persisted: false });
    s.host().remember('https://api.test/other', [{ name: 'x', value: '1', path: '/', maxAge: 60 }]);
    await s.flush();
    expect(readFileSync(fileOf('w1'), 'utf8')).toBe(before);
    expect(existsSync(`${fileOf('w1')}.corrupt`)).toBe(false);
  });
});
