// @vitest-environment node
/** How the Electron platform parents a native dialog: the owner's window, the focused one, or none. */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  app: { getPath: vi.fn(), getVersion: vi.fn(), isPackaged: true, quit: vi.fn() },
  safeStorage: { isEncryptionAvailable: vi.fn(), encryptString: vi.fn(), decryptString: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
  BrowserWindow: { fromWebContents: vi.fn(), getFocusedWindow: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), off: vi.fn() },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('electron', () => electron);

const { createElectronPlatform, callerForWebContents } = await import('../../src/main/electron/electron-platform.js');

class FakeContents extends EventEmitter {
  readonly send = vi.fn();
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return false;
  }
}

const opts = { title: 'Pick', properties: ['openFile' as const] };

beforeEach(() => {
  vi.clearAllMocks();
  electron.BrowserWindow.getFocusedWindow.mockReturnValue(null);
  electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/a'] });
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/s' });
  electron.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
});

describe('platform.dialogs parenting', () => {
  it('passes the owner window when the owner is live', async () => {
    const window = { id: 'owner' };
    electron.BrowserWindow.fromWebContents.mockReturnValue(window);
    const owner = callerForWebContents(new FakeContents(21) as never);
    await expect(createElectronPlatform().dialogs?.openFile(owner, opts)).resolves.toEqual({
      canceled: false,
      filePaths: ['/a'],
    });
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(window, opts);
  });

  it('opens unparented, and resolves, when the owner is given but its window is gone', async () => {
    electron.BrowserWindow.fromWebContents.mockReturnValue(null);
    electron.BrowserWindow.getFocusedWindow.mockReturnValue({ id: 'focused' });
    const owner = callerForWebContents(new FakeContents(22) as never);
    await expect(createElectronPlatform().dialogs?.openFile(owner, opts)).resolves.toEqual({
      canceled: false,
      filePaths: ['/a'],
    });
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(opts);
  });

  it('opens unparented when the owner has been closed', async () => {
    const contents = new FakeContents(23);
    const owner = callerForWebContents(contents as never);
    contents.isDestroyed = () => true;
    await createElectronPlatform().dialogs?.saveFile(owner, { title: 'Save' });
    expect(electron.dialog.showSaveDialog).toHaveBeenCalledWith({ title: 'Save' });
  });

  it('parents to the focused window when there is no owner', async () => {
    const focused = { id: 'focused' };
    electron.BrowserWindow.getFocusedWindow.mockReturnValue(focused);
    const platform = createElectronPlatform();
    await platform.dialogs?.openFile(undefined, opts);
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(focused, opts);
    await platform.dialogs?.saveFile(undefined, { title: 'Save' });
    expect(electron.dialog.showSaveDialog).toHaveBeenCalledWith(focused, { title: 'Save' });
    await expect(platform.dialogs?.message(undefined, { message: 'Sure?' })).resolves.toEqual({
      response: 1,
      checkboxChecked: false,
    });
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(focused, { message: 'Sure?' });
  });

  it('opens unparented when there is no owner and no focused window', async () => {
    await createElectronPlatform().dialogs?.message(undefined, { message: 'Sure?' });
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith({ message: 'Sure?' });
  });
});
