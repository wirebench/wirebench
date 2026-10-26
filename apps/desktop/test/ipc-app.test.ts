// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tableInto } from './helpers/ipc-table.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const table = tableInto(handlers);

let focusedWindow: { isDestroyed: () => boolean; webContents: unknown } | null = null;

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0', isPackaged: true },
  BrowserWindow: { getFocusedWindow: () => focusedWindow },
  Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => undefined },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerAppChannels } = await import('../src/main/ipc/app.js');

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

/** Runs the menu item the fake `Menu` captured, whatever menu it landed in. */
function clickFirstCommandItem(template: unknown): void {
  const walk = (items: readonly { label?: string; submenu?: unknown; click?: () => void }[]): boolean => {
    for (const item of items) {
      if (item.label === 'Send Request' && typeof item.click === 'function') {
        item.click();
        return true;
      }
      if (Array.isArray(item.submenu) && walk(item.submenu as never)) {
        return true;
      }
    }
    return false;
  };
  expect(walk(template as never)).toBe(true);
}

describe('app.* IPC', () => {
  beforeEach(() => {
    handlers.clear();
    focusedWindow = null;
  });

  it('dispatches a menu click to the focused window, not the one that registered the menu', async () => {
    let template: unknown;
    registerAppChannels(table, {
      install: (built) => {
        template = built;
      },
    });
    const registrar = webContents();
    const focused = webContents();
    focusedWindow = { isDestroyed: () => false, webContents: focused };

    await invoke('app.registerMenu', { items: ITEMS }, registrar);
    clickFirstCommandItem(template);

    expect(focused.send).toHaveBeenCalledWith('command.invoke', { id: 'request.send' });
    expect(registrar.send).not.toHaveBeenCalled();
  });

  it('app.areas answers the enabled area ids, and the local terminal off with the SSH area', async () => {
    registerAppChannels(table, undefined, undefined, undefined, ['explorer', 'history']);
    expect(await invoke('app.areas', undefined, webContents())).toEqual({
      ok: true,
      value: { enabled: ['explorer', 'history'], localTerminal: false, telnet: false, serial: false },
    });
  });

  it('app.areas says whether the local terminal is on', async () => {
    registerAppChannels(table, undefined, undefined, undefined, ['explorer', 'ssh'], undefined, false);
    expect(await invoke('app.areas', undefined, webContents())).toEqual({
      ok: true,
      value: { enabled: ['explorer', 'ssh'], localTerminal: false, telnet: true, serial: true },
    });
  });

  it('app.areas says whether Telnet hosts connect (#425)', async () => {
    registerAppChannels(table, undefined, undefined, undefined, ['explorer', 'ssh'], undefined, true, false);
    expect(await invoke('app.areas', undefined, webContents())).toEqual({
      ok: true,
      value: { enabled: ['explorer', 'ssh'], localTerminal: true, telnet: false, serial: true },
    });
  });

  it('app.areas says whether serial consoles connect (#426)', async () => {
    registerAppChannels(table, undefined, undefined, undefined, ['explorer', 'ssh'], undefined, true, true, false);
    expect(await invoke('app.areas', undefined, webContents())).toEqual({
      ok: true,
      value: { enabled: ['explorer', 'ssh'], localTerminal: true, telnet: true, serial: false },
    });
  });

  it('app.features carries the area rows beside the feature rows (#360)', async () => {
    registerAppChannels(table, undefined, undefined, undefined, ['explorer'], undefined, false, false, false, () => [
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
    registerAppChannels(table, undefined, undefined, undefined, undefined, {
      kinds: () => ['soap', 'rest'],
      states: () => ({ states: [] }),
    });
    expect(await invoke('app.kinds', undefined, webContents())).toEqual({
      ok: true,
      value: { enabled: ['soap', 'rest'] },
    });
  });

  it('falls back to the registering window when nothing is focused', async () => {
    let template: unknown;
    registerAppChannels(table, {
      install: (built) => {
        template = built;
      },
    });
    const registrar = webContents();

    await invoke('app.registerMenu', { items: ITEMS }, registrar);
    clickFirstCommandItem(template);

    expect(registrar.send).toHaveBeenCalledWith('command.invoke', { id: 'request.send' });
  });

  it('falls back to the registering window when the focused one is being destroyed', async () => {
    let template: unknown;
    registerAppChannels(table, {
      install: (built) => {
        template = built;
      },
    });
    const registrar = webContents();
    const focused = webContents();
    focusedWindow = { isDestroyed: () => true, webContents: focused };

    await invoke('app.registerMenu', { items: ITEMS }, registrar);
    clickFirstCommandItem(template);

    expect(registrar.send).toHaveBeenCalledWith('command.invoke', { id: 'request.send' });
    expect(focused.send).not.toHaveBeenCalled();
  });
});
