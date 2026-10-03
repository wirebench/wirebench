// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CookieStore } from '../src/main/cookie-store.js';
import { registerCookiesChannels } from '../src/main/ipc/cookies.js';
import { channels } from '../src/shared/ipc.js';
import type { CookieJarStateWire } from '../src/shared/wire-types.js';

const registeredHandlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      registeredHandlers.set(name, handler);
    },
  },
}));

const NOW = Date.parse('2026-10-03T12:00:00Z');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-ipc-cookies-'));
  registeredHandlers.clear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Result = { ok: boolean; value?: CookieJarStateWire };

function invoke(channelName: string, payload?: unknown): Promise<Result> {
  const handler = registeredHandlers.get(channelName);
  if (handler === undefined) {
    throw new Error(`${channelName} was never registered`);
  }
  return handler({ sender: {} }, payload) as Promise<Result>;
}

function names(result: Result): string[] {
  return (result.value?.cookies ?? []).map((cookie) => cookie.name);
}

function newStore(): CookieStore {
  const crypto = { available: false, encrypt: () => Buffer.from(''), decrypt: () => '' };
  return new CookieStore({ userDataDir: dir, crypto, now: () => NOW });
}

describe('registerCookiesChannels', () => {
  it('answers every channel with the whole jar', async () => {
    const store = newStore();
    registerCookiesChannels(store);
    store.host().remember('https://api.test/', [
      { name: 'a', value: '1', path: '/' },
      { name: 'b', value: '2', path: '/' },
    ]);

    const listed = await invoke(channels.cookies.list.name, undefined);
    expect(listed.ok).toBe(true);
    expect(names(listed)).toEqual(['a', 'b']);
    expect(listed.value?.persisted).toBe(false);

    const a = listed.value!.cookies[0]!;
    const renamed = await invoke(channels.cookies.set.name, {
      cookie: { ...a, name: 'renamed' },
      replaces: { name: 'a', domain: 'api.test', path: '/' },
    });
    expect(names(renamed)).toEqual(['b', 'renamed']);
    expect(
      names(await invoke(channels.cookies.remove.name, { key: { name: 'b', domain: 'api.test', path: '/' } })),
    ).toEqual(['renamed']);
    expect(names(await invoke(channels.cookies.removeDomain.name, { domain: 'api.test' }))).toEqual([]);
    store.host().remember('https://api.test/', [{ name: 'c', value: '3', path: '/' }]);
    expect(names(await invoke(channels.cookies.clear.name, undefined))).toEqual([]);
  });

  it('refuses something that is not a cookie', async () => {
    registerCookiesChannels(newStore());
    expect((await invoke(channels.cookies.set.name, { cookie: { name: 'x' } })).ok).toBe(false);
  });
});
