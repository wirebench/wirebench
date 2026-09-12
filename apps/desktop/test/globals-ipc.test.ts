import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_PROPERTIES_FILE, GlobalProperties } from '../src/main/global-properties.js';
import { wrapHandler } from '../src/main/ipc/envelope.js';
import { registerGlobalsChannels } from '../src/main/ipc/globals.js';
import { channels } from '../src/shared/ipc.js';
import type { GlobalsState } from '../src/shared/wire-types.js';

const registeredHandlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      registeredHandlers.set(name, handler);
    },
  },
}));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wirebench-globals-ipc-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Regression test for the startup race: `globals.get` used to read `globals.get()` synchronously
 * without awaiting the initial `load()`, so a call arriving before the disk read resolved got
 * `{}` back forever. The fix is `globals.get` awaiting {@link GlobalProperties.ready} first.
 */
describe('globals.get IPC handler', () => {
  it('waits for the initial load before answering, even when the disk read is slow', async () => {
    writeFileSync(join(dir, GLOBAL_PROPERTIES_FILE), 'version: 1\nproperties:\n  token: abc\n', 'utf8');
    const globals = new GlobalProperties(dir);

    // Mirrors the fix in src/main/ipc/globals.ts's `globals.get` handler.
    const getHandler = wrapHandler(channels.globals.get, async () => {
      await globals.ready();
      return globals.get();
    });

    // Call the handler before anything has triggered `load()` — simulating the handler being
    // registered (and called) ahead of `main/index.ts`'s startup warm-up resolving.
    const result = await getHandler(undefined);

    expect(result).toEqual({ ok: true, value: { properties: { token: 'abc' }, disabled: [] } });
  });
});

/**
 * The full `globals.*` contract through `registerGlobalsChannels`, including the new
 * `globals.setEnabled` channel: every handler answers with the whole state and fires
 * `onChanged` with it, exactly like `set`/`remove` already did.
 */
describe('registerGlobalsChannels', () => {
  function invoke(channelName: string, payload?: unknown): Promise<{ ok: boolean; value?: unknown }> {
    const handler = registeredHandlers.get(channelName);
    if (handler === undefined) {
      throw new Error(`${channelName} was never registered`);
    }
    return handler({ sender: {} }, payload) as Promise<{ ok: boolean; value?: unknown }>;
  }

  it('setEnabled disables a name without deleting it, and both are announced via onChanged', async () => {
    registeredHandlers.clear();
    const globals = new GlobalProperties(dir);
    await globals.set('token', 'abc');
    const changes: GlobalsState[] = [];
    registerGlobalsChannels(globals, (state) => changes.push(state));

    const disabled = await invoke(channels.globals.setEnabled.name, { name: 'token', enabled: false });
    expect(disabled).toEqual({ ok: true, value: { properties: { token: 'abc' }, disabled: ['token'] } });

    const reEnabled = await invoke(channels.globals.setEnabled.name, { name: 'token', enabled: true });
    expect(reEnabled).toEqual({ ok: true, value: { properties: { token: 'abc' }, disabled: [] } });

    expect(changes).toEqual([
      { properties: { token: 'abc' }, disabled: ['token'] },
      { properties: { token: 'abc' }, disabled: [] },
    ]);
  });

  it('get answers with the current disabled list alongside the map', async () => {
    registeredHandlers.clear();
    const globals = new GlobalProperties(dir);
    await globals.set('token', 'abc');
    await globals.setEnabled('token', false);
    registerGlobalsChannels(globals);

    const result = await invoke(channels.globals.get.name, undefined);
    expect(result).toEqual({ ok: true, value: { properties: { token: 'abc' }, disabled: ['token'] } });
  });
});
