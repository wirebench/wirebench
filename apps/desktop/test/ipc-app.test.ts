// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from './helpers/fake-platform.js';
import { tableInto } from './helpers/ipc-table.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const table = tableInto(handlers);

const { registerAppChannels } = await import('../src/main/ipc/app.js');
const host = { app: createFakePlatform().app };

let nextId = 1;
/** A stand-in `WebContents` that records what was sent to it. */
function webContents() {
  return { id: nextId++, isDestroyed: () => false, send: vi.fn(), once: vi.fn(), on: vi.fn() };
}

function invoke(channel: string, payload: unknown, sender: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender }, payload);
}

const ITEMS = [{ id: 'request.send', label: 'Send Request', category: 'Request', accelerator: 'CmdOrCtrl+Return' }];

describe('app.* IPC', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("app.version reports the platform's runtime version, not the process's", async () => {
    registerAppChannels(table, host);
    expect(await invoke('app.version', undefined, webContents())).toMatchObject({
      ok: true,
      value: { electron: '0.0.0-test' },
    });
  });

  it('app.registerMenu hands the manifest and the registering window to the host menu', async () => {
    const menu = vi.fn().mockReturnValue(1);
    registerAppChannels(table, { ...host, menu });
    const registrar = webContents();
    expect(await invoke('app.registerMenu', { items: ITEMS }, registrar)).toEqual({ ok: true, value: { items: 1 } });
    expect(menu).toHaveBeenCalledWith(ITEMS, expect.objectContaining({ id: registrar.id }));
  });

  it('app.registerMenu answers no items on a host with no menu', async () => {
    registerAppChannels(table, host);
    expect(await invoke('app.registerMenu', { items: ITEMS }, webContents())).toEqual({
      ok: true,
      value: { items: 0 },
    });
  });

  it('app.areas answers the enabled area ids, and the local terminal off with the SSH area', async () => {
    registerAppChannels(table, host, undefined, undefined, ['explorer', 'history']);
    expect(await invoke('app.areas', undefined, webContents())).toEqual({
      ok: true,
      value: { enabled: ['explorer', 'history'], localTerminal: false, telnet: false, serial: false },
    });
  });

  it('app.areas says whether the local terminal is on', async () => {
    registerAppChannels(table, host, undefined, undefined, ['explorer', 'ssh'], undefined, false);
    expect(await invoke('app.areas', undefined, webContents())).toEqual({
      ok: true,
      value: { enabled: ['explorer', 'ssh'], localTerminal: false, telnet: true, serial: true },
    });
  });

  it('app.areas says whether Telnet hosts connect (#425)', async () => {
    registerAppChannels(table, host, undefined, undefined, ['explorer', 'ssh'], undefined, true, false);
    expect(await invoke('app.areas', undefined, webContents())).toEqual({
      ok: true,
      value: { enabled: ['explorer', 'ssh'], localTerminal: true, telnet: false, serial: true },
    });
  });

  it('app.areas says whether serial consoles connect (#426)', async () => {
    registerAppChannels(table, host, undefined, undefined, ['explorer', 'ssh'], undefined, true, true, false);
    expect(await invoke('app.areas', undefined, webContents())).toEqual({
      ok: true,
      value: { enabled: ['explorer', 'ssh'], localTerminal: true, telnet: true, serial: false },
    });
  });

  it('app.features carries the area rows beside the feature rows (#360)', async () => {
    registerAppChannels(table, host, undefined, undefined, ['explorer'], undefined, false, false, false, () => [
      {
        id: 'ssh',
        title: 'SSH',
        stage: 'stable',
        requires: [],
        default: true,
        policy: true,
        enabled: false,
        reason: { by: 'policy' },
      },
    ]);
    expect(await invoke('app.features', undefined, webContents())).toEqual({
      ok: true,
      value: {
        states: [],
        areas: [
          {
            id: 'ssh',
            title: 'SSH',
            stage: 'stable',
            requires: [],
            default: true,
            policy: true,
            enabled: false,
            reason: { by: 'policy' },
          },
        ],
      },
    });
  });

  it('app.kinds answers the kinds this run has switched on', async () => {
    registerAppChannels(table, host, undefined, undefined, undefined, {
      kinds: () => ['soap', 'rest'],
      states: () => ({ states: [] }),
    });
    expect(await invoke('app.kinds', undefined, webContents())).toEqual({
      ok: true,
      value: { enabled: ['soap', 'rest'] },
    });
  });
});
