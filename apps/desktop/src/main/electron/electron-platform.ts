/** `HostPlatform` over Electron: the only place the host seam touches `electron`. */
import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  powerMonitor,
  safeStorage,
  session,
  shell,
  type WebContents,
} from 'electron';
import type { Caller, Capability, HostPlatform } from '../host/platform.js';

const CAPABILITIES: readonly Capability[] = [
  'files',
  'keychain',
  'ssh',
  'pty',
  'kerberos',
  'dialogs',
  'send:private',
  'send:public',
  'secret-sources',
  'team-secrets',
  'updates',
  'app-lock',
];

interface Entry {
  readonly caller: Caller;
  readonly contents: WebContents;
}

// One caller per renderer, so identity comparisons and `onClosed` subscriptions are stable.
const callers = new Map<number, Entry>();

/** The `Caller` for a renderer; the same object for the same `contents.id` until it is destroyed. */
export function callerForWebContents(contents: WebContents): Caller {
  const known = callers.get(contents.id);
  if (known !== undefined && known.contents === contents) return known.caller;
  const listeners = new Set<() => void>();
  let closed = contents.isDestroyed();
  const close = (): void => {
    if (closed && listeners.size === 0) return;
    closed = true;
    callers.delete(contents.id);
    const pending = [...listeners];
    listeners.clear();
    for (const listener of pending) listener();
  };
  const caller: Caller = {
    id: contents.id,
    send(channel, payload) {
      if (closed || contents.isDestroyed()) return;
      contents.send(channel, payload);
    },
    isClosed: () => closed || contents.isDestroyed(),
    onClosed(listener) {
      if (caller.isClosed()) {
        queueMicrotask(listener);
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  contents.once('destroyed', close);
  callers.set(contents.id, { caller, contents });
  return caller;
}

/** The live window a caller's contents belongs to, if any. */
function windowOf(owner: Caller | undefined): BrowserWindow | undefined {
  if (owner === undefined || owner.isClosed()) return undefined;
  const contents = callers.get(owner.id)?.contents;
  if (contents === undefined) return undefined;
  return BrowserWindow.fromWebContents(contents) ?? undefined;
}

export function createElectronPlatform(): HostPlatform {
  return {
    paths: {
      userData: () => app.getPath('userData'),
      temp: () => app.getPath('temp'),
      logs: () => app.getPath('logs'),
    },
    secrets: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (sealed) => safeStorage.decryptString(sealed),
    },
    dialogs: {
      async openFile(owner, opts) {
        const options = toMutable(opts);
        const window = windowOf(owner);
        const result =
          window === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
        return { canceled: result.canceled, filePaths: result.filePaths };
      },
      async saveFile(owner, opts) {
        const options = toMutable(opts);
        const window = windowOf(owner);
        const result =
          window === undefined ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(window, options);
        return result.filePath === undefined
          ? { canceled: result.canceled }
          : { canceled: result.canceled, filePath: result.filePath };
      },
      async message(owner, opts) {
        const options = toMutable(opts);
        const window = windowOf(owner);
        const result =
          window === undefined ? await dialog.showMessageBox(options) : await dialog.showMessageBox(window, options);
        return { response: result.response, checkboxChecked: result.checkboxChecked };
      },
    },
    shell: {
      openExternal: (url) => shell.openExternal(url),
      openPath: (path) => shell.openPath(path),
      reveal: (path) => {
        shell.showItemInFolder(path);
      },
      trash: (path) => shell.trashItem(path),
    },
    app: {
      version: () => app.getVersion(),
      packaged: () => app.isPackaged,
      quit: () => {
        app.quit();
      },
      osTheme: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
      onOsThemeChanged(listener) {
        nativeTheme.on('updated', listener);
        return () => {
          nativeTheme.off('updated', listener);
        };
      },
    },
    proxy: { resolve: (target) => session.defaultSession.resolveProxy(target) },
    power: {
      onResume(listener) {
        powerMonitor.on('resume', listener);
        return () => {
          powerMonitor.off('resume', listener);
        };
      },
    },
    capabilities: new Set(CAPABILITIES),
  };
}

/** Electron's option types want mutable arrays; ours are readonly. The shapes are otherwise identical. */
function toMutable<T extends object>(opts: T): never {
  return opts as never;
}
