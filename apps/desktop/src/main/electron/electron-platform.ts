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
import { ALL_CAPABILITIES, type Caller, type DialogOwner, type HostPlatform } from '../host/platform.js';

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
  const resetListeners = { start: new Set<() => void>(), commit: new Set<() => void>() };
  let closed = contents.isDestroyed();
  const close = (): void => {
    if (closed && listeners.size === 0) return;
    closed = true;
    callers.delete(contents.id);
    const pending = [...listeners];
    listeners.clear();
    for (const listener of pending) {
      try {
        listener();
      } catch {
        // One listener's failure must not keep the others from hearing the caller closed.
      }
    }
  };
  const caller: Caller = {
    id: contents.id,
    send(channel, payload) {
      if (closed || contents.isDestroyed()) return;
      contents.send(channel, payload);
    },
    isClosed: () => closed || contents.isDestroyed(),
    onReset(listener, options) {
      const set = resetListeners[options?.on ?? 'start'];
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    onClosed(listener) {
      if (caller.isClosed()) {
        let cancelled = false;
        queueMicrotask(() => {
          if (!cancelled) listener();
        });
        return () => {
          cancelled = true;
        };
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const reset = (kind: 'start' | 'commit' | 'crash'): void => {
    const heard = kind === 'crash' ? [...resetListeners.start, ...resetListeners.commit] : [...resetListeners[kind]];
    for (const listener of heard) {
      try {
        listener();
      } catch {
        // One listener's failure must not keep the others from hearing the reset.
      }
    }
  };
  contents.once('destroyed', close);
  // A reload or a crash starts a renderer that knows nothing of what the old page was given.
  contents.on('render-process-gone', () => {
    reset('crash');
  });
  contents.on('did-start-navigation', (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) reset('start');
  });
  // `did-navigate` fires for a main-frame navigation that committed, never for a cancelled one.
  contents.on('did-navigate', () => {
    reset('commit');
  });
  callers.set(contents.id, { caller, contents });
  return caller;
}

/** The live window a caller's contents belongs to, if any. */
function windowOf(owner: Caller): BrowserWindow | undefined {
  if (owner.isClosed()) return undefined;
  const contents = callers.get(owner.id)?.contents;
  if (contents === undefined) return undefined;
  return BrowserWindow.fromWebContents(contents) ?? undefined;
}

/**
 * The window a native dialog opens over. `undefined` is no parent; `'focused'` is whichever window
 * the user is in, if there is one; a `Caller` whose window is gone opens the dialog unparented, not
 * over some other window.
 */
function parentOf(owner: DialogOwner): BrowserWindow | undefined {
  if (owner === undefined) return undefined;
  if (owner === 'focused') return BrowserWindow.getFocusedWindow() ?? undefined;
  return windowOf(owner);
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
        const window = parentOf(owner);
        const result =
          window === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
        return { canceled: result.canceled, filePaths: result.filePaths };
      },
      async saveFile(owner, opts) {
        const options = toMutable(opts);
        const window = parentOf(owner);
        const result =
          window === undefined ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(window, options);
        return result.filePath === undefined
          ? { canceled: result.canceled }
          : { canceled: result.canceled, filePath: result.filePath };
      },
      async message(owner, opts) {
        const options = toMutable(opts);
        const window = parentOf(owner);
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
      runtimeVersion: () => process.versions.electron,
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
      onLock(listener) {
        powerMonitor.on('lock-screen', listener);
        powerMonitor.on('suspend', listener);
        return () => {
          powerMonitor.off('lock-screen', listener);
          powerMonitor.off('suspend', listener);
        };
      },
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
    },
    capabilities: new Set(ALL_CAPABILITIES),
  };
}

/** Electron's option types want mutable arrays; ours are readonly. The shapes are otherwise identical. */
function toMutable<T extends object>(opts: T): never {
  return opts as never;
}
