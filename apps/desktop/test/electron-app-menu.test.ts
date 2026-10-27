// @vitest-environment node
/** The Electron end of `app.registerMenu`: where a menu click goes when several windows are open. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asCaller } from '../../../packages/host/test/helpers/ipc-table.js';

let focusedWindow: { isDestroyed: () => boolean; webContents: unknown } | null = null;

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => focusedWindow },
  Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => undefined },
}));

const { createElectronAppMenu } = await import('../src/main/electron/app-menu.js');

let nextId = 100;
/** A stand-in `WebContents` that records what was sent to it. */
function webContents() {
  return { id: nextId++, isDestroyed: () => false, send: vi.fn(), once: vi.fn(), on: vi.fn() };
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

/** Registers `ITEMS` as `registrar` and clicks the item, returning nothing; sends land on the fakes. */
function registerAndClick(registrar: ReturnType<typeof webContents>): void {
  let template: unknown;
  const register = createElectronAppMenu(
    { packaged: () => true },
    {
      install: (built) => {
        template = built;
      },
    },
  );
  register(ITEMS, asCaller(registrar));
  clickFirstCommandItem(template);
}

describe('the Electron application menu', () => {
  beforeEach(() => {
    focusedWindow = null;
  });

  it('dispatches a menu click to the focused window, not the one that registered the menu', () => {
    const registrar = webContents();
    const focused = webContents();
    focusedWindow = { isDestroyed: () => false, webContents: focused };

    registerAndClick(registrar);

    expect(focused.send).toHaveBeenCalledWith('command.invoke', { id: 'request.send' });
    expect(registrar.send).not.toHaveBeenCalled();
  });

  it('falls back to the registering window when nothing is focused', () => {
    const registrar = webContents();
    registerAndClick(registrar);
    expect(registrar.send).toHaveBeenCalledWith('command.invoke', { id: 'request.send' });
  });

  it('falls back to the registering window when the focused one is being destroyed', () => {
    const registrar = webContents();
    const focused = webContents();
    focusedWindow = { isDestroyed: () => true, webContents: focused };

    registerAndClick(registrar);

    expect(registrar.send).toHaveBeenCalledWith('command.invoke', { id: 'request.send' });
    expect(focused.send).not.toHaveBeenCalled();
  });

  it('adds the developer items to the View menu only when unpackaged', () => {
    const templates: unknown[] = [];
    const install = (template: unknown): void => {
      templates.push(template);
    };
    createElectronAppMenu({ packaged: () => false }, { install })(ITEMS, asCaller(webContents()));
    createElectronAppMenu({ packaged: () => true }, { install })(ITEMS, asCaller(webContents()));
    const roles = (template: unknown): string[] =>
      JSON.stringify(template).match(/"role":"(reload|toggleDevTools)"/g) ?? [];
    expect(roles(templates[0])).toHaveLength(2);
    expect(roles(templates[1])).toHaveLength(0);
  });
});
