// @vitest-environment node
/** The Electron implementation of `HostPlatform`: thin delegation plus the per-contents `Caller`. */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CAPABILITIES } from '../../../../packages/host/src/host/platform.js';

const electron = vi.hoisted(() => ({
  app: { getPath: vi.fn(), getVersion: vi.fn(), isPackaged: true, quit: vi.fn() },
  safeStorage: { isEncryptionAvailable: vi.fn(), encryptString: vi.fn(), decryptString: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), off: vi.fn() },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('electron', () => electron);

const { createElectronPlatform, callerForWebContents } = await import('../../src/main/electron/electron-platform.js');

class FakeContents extends EventEmitter {
  destroyed = false;
  readonly send = vi.fn();
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createElectronPlatform', () => {
  it('reads userData from app.getPath', () => {
    electron.app.getPath.mockImplementation((name: string) => `/p/${name}`);
    const platform = createElectronPlatform();
    expect(platform.paths.userData()).toBe('/p/userData');
    expect(platform.paths.temp()).toBe('/p/temp');
    expect(platform.paths.logs()).toBe('/p/logs');
  });

  it('delegates encryption to safeStorage', () => {
    electron.safeStorage.encryptString.mockReturnValue(Buffer.from('sealed'));
    electron.safeStorage.decryptString.mockReturnValue('plain');
    electron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    const platform = createElectronPlatform();
    expect(platform.secrets.available()).toBe(true);
    expect(platform.secrets.encrypt('plain')).toEqual(Buffer.from('sealed'));
    expect(electron.safeStorage.encryptString).toHaveBeenCalledWith('plain');
    expect(platform.secrets.decrypt(Buffer.from('sealed'))).toBe('plain');
  });

  it('resolves the proxy through the default session', async () => {
    electron.session.defaultSession.resolveProxy.mockResolvedValue('PROXY p:8080');
    const platform = createElectronPlatform();
    await expect(platform.proxy.resolve('https://x.test')).resolves.toBe('PROXY p:8080');
    expect(electron.session.defaultSession.resolveProxy).toHaveBeenCalledWith('https://x.test');
  });

  it('declares every capability', () => {
    expect([...createElectronPlatform().capabilities].sort()).toEqual([...ALL_CAPABILITIES].sort());
  });

  it('reports the Electron runtime version as the runtime version', () => {
    const had = Object.getOwnPropertyDescriptor(process.versions, 'electron');
    Object.defineProperty(process.versions, 'electron', { value: '99.1.2', configurable: true });
    try {
      expect(createElectronPlatform().app.runtimeVersion()).toBe(process.versions.electron);
      expect(createElectronPlatform().app.runtimeVersion()).toBe('99.1.2');
    } finally {
      if (had !== undefined) Object.defineProperty(process.versions, 'electron', had);
      else Reflect.deleteProperty(process.versions, 'electron');
    }
  });

  it('reports the app facts and the OS theme', () => {
    electron.app.getVersion.mockReturnValue('9.9.9');
    electron.nativeTheme.shouldUseDarkColors = true;
    const platform = createElectronPlatform();
    expect(platform.app.version()).toBe('9.9.9');
    expect(platform.app.packaged()).toBe(true);
    expect(platform.app.osTheme()).toBe('dark');
    const off = platform.app.onOsThemeChanged(() => undefined);
    expect(electron.nativeTheme.on).toHaveBeenCalledWith('updated', expect.any(Function));
    off();
    expect(electron.nativeTheme.off).toHaveBeenCalledWith('updated', expect.any(Function));
  });

  it('parents a dialog with the owner window when it is live, and opens it unparented otherwise', async () => {
    const window = { id: 'w' };
    electron.BrowserWindow.fromWebContents.mockReturnValueOnce(window).mockReturnValueOnce(null);
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/a'] });
    const platform = createElectronPlatform();
    const owner = callerForWebContents(new FakeContents(5) as never);
    const opts = { title: 'Pick', properties: ['openFile' as const] };
    await expect(platform.dialogs?.openFile(owner, opts)).resolves.toEqual({ canceled: false, filePaths: ['/a'] });
    expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith(window, opts);
    await platform.dialogs?.openFile(owner, opts);
    expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith(opts);
  });
});

describe('callerForWebContents', () => {
  it('returns the same caller for the same contents', () => {
    const contents = new FakeContents(7);
    const a = callerForWebContents(contents as never);
    expect(a.id).toBe(7);
    expect(callerForWebContents(contents as never)).toBe(a);
  });

  it('sends through the contents while it is alive', () => {
    const contents = new FakeContents(8);
    callerForWebContents(contents as never).send('ch', { a: 1 });
    expect(contents.send).toHaveBeenCalledWith('ch', { a: 1 });
  });

  it('makes send a no-op once the contents is destroyed, and tells listeners once', () => {
    const contents = new FakeContents(9);
    const caller = callerForWebContents(contents as never);
    const closed = vi.fn();
    caller.onClosed(closed);
    const removed = vi.fn();
    caller.onClosed(removed)();
    contents.destroy();
    caller.send('ch', 1);
    expect(contents.send).not.toHaveBeenCalled();
    expect(caller.isClosed()).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });

  it('runs a listener added after close once, in a microtask, and lets it be cancelled first', async () => {
    const contents = new FakeContents(10);
    const caller = callerForWebContents(contents as never);
    contents.destroy();
    const late = vi.fn();
    caller.onClosed(late);
    const cancelled = vi.fn();
    caller.onClosed(cancelled)();
    expect(late).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(late).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('keeps telling the other listeners when one throws', () => {
    const contents = new FakeContents(11);
    const caller = callerForWebContents(contents as never);
    const after = vi.fn();
    caller.onClosed(() => {
      throw new Error('boom');
    });
    caller.onClosed(after);
    expect(() => {
      contents.destroy();
    }).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('tells reset listeners about a crash or a main-frame navigation, but not a same-document one', () => {
    const contents = new FakeContents(12);
    const caller = callerForWebContents(contents as never);
    const reset = vi.fn();
    const off = caller.onReset(reset);
    contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(reset).not.toHaveBeenCalled();
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    contents.emit('render-process-gone', {}, {});
    expect(reset).toHaveBeenCalledTimes(2);
    expect(caller.isClosed()).toBe(false);
    off();
    contents.emit('render-process-gone', {}, {});
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('tells commit-only reset listeners about a committed navigation or a crash, not one that only starts', () => {
    const contents = new FakeContents(13);
    const caller = callerForWebContents(contents as never);
    const start = vi.fn();
    const commit = vi.fn();
    caller.onReset(start);
    caller.onReset(commit, { on: 'commit' });
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(start).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    contents.emit('did-navigate', {}, 'https://x.test');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    contents.emit('render-process-gone', {}, {});
    expect(start).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(2);
  });
});
