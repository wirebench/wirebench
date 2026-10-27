/**
 * The Electron entry: what belongs to the process (the app's name, the `app:` scheme, the profile
 * folder, device keys, the updater, the menu, windows and the app's lifecycle) around one host,
 * `createHost(platform)`, whose channels it serves over `ipcMain`.
 */
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { createHost, type Host } from '@wirebench/host';
import {
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  appVersion,
  DeviceHelper,
  DeviceKeys,
  deviceHelperDir,
  setUpKerberos,
} from '@wirebench/host/desktop';
import { setDeviceKeySigner } from '@wirebench/ssh';
import { app, BrowserWindow, protocol } from 'electron';
import { registerAppProtocol } from './electron/app-protocol-handler.js';
import { createElectronAppMenu } from './electron/app-menu.js';
import { callerForWebContents, createElectronPlatform } from './electron/electron-platform.js';
import { bindIpc } from './electron/ipc-binding.js';
import { createUpdateController } from './electron/update-service.js';
import { createMainWindow } from './electron/windows.js';
import { portableDataDir } from './portable.js';

// Must run before `app.ready` — Electron only honours scheme privileges registered this
// early. This is what lets the packaged renderer be served from a real (non-`file://`)
// origin, which Monaco's web workers need.
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }]);

/** The Electron end of the host seam: the host reaches the machine through this, not `electron`. */
const platform = createElectronPlatform();

// e2e (see `e2e/helpers/launch-app.ts`) launches every test against a fresh, isolated
// profile instead of the developer's real one, set via this env var rather than a CLI flag
// Electron doesn't parse on its own. This MUST run before anything below reads
// `app.getPath('userData')` (the host's secret store included), or it would keep writing to the
// developer's real profile regardless of the override.
const e2eUserDataDir = process.env['WIREBENCH_USER_DATA_DIR'];
// The portable Windows build keeps its profile in the `data` folder beside `Wirebench.exe`
// (see `portable.ts`); same constraint, it has to be set before anything reads `userData`.
const portableDir = portableDataDir({
  platform: process.platform,
  isPackaged: platform.app.packaged(),
  exePath: process.execPath,
});
if (e2eUserDataDir !== undefined) {
  app.setPath('userData', e2eUserDataDir);
} else if (portableDir !== undefined) {
  app.setPath('userData', portableDir);
}

/**
 * Device keys (#428): SSH keys held by this machine's secure hardware, reached through the device helper. Set
 * as the process's signer, so every connect (terminal, files, forwards, key install) can sign with one.
 */
const deviceHelper = new DeviceHelper({
  platform: process.platform,
  dir: deviceHelperDir({
    isPackaged: platform.app.packaged(),
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  }),
});
const deviceKeys = new DeviceKeys(deviceHelper, process.platform);
setDeviceKeySigner(deviceKeys);

// The product name, set before `ready` so the macOS application menu (`role: 'appMenu'`) and
// the About panel read "Wirebench" in development too. A packaged bundle already carries it as
// `productName` (CFBundleName); without this, a `pnpm dev` run shows Electron's own name.
app.setName('Wirebench');
app.setAboutPanelOptions({ applicationName: 'Wirebench', applicationVersion: appVersion(platform.app) });

/** The one host, built once the app is ready; the quit path asks it to shut down. */
let host: Host | undefined;
/** Every open window by its caller's id, for what the host asks of a window (title, focus). */
const windows = new Map<number, BrowserWindow>();

void app.whenReady().then(async () => {
  electronApp.setAppUserModelId('io.wirebench.desktop');
  registerAppProtocol();

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  setUpKerberos({ isPackaged: platform.app.packaged(), resourcesPath: process.resourcesPath });
  const started = await createHost(platform, {
    windows: {
      open: () => {
        openWindow(started, { reopenLast: false });
      },
      setTitle: (caller, title) => {
        const window = windows.get(caller.id);
        if (window !== undefined && !window.isDestroyed()) {
          window.setTitle(title);
        }
      },
      bringForward: (caller) => {
        const window = windows.get(caller.id);
        if (window !== undefined && !window.isDestroyed()) {
          if (window.isMinimized()) {
            window.restore();
          }
          window.focus();
        }
      },
      focused: () => {
        const window = BrowserWindow.getFocusedWindow();
        return window === null ? undefined : callerForWebContents(window.webContents);
      },
    },
    menu: createElectronAppMenu(platform.app),
    updates: ({ report, channel }) =>
      createUpdateController(platform, report, {
        portable: e2eUserDataDir === undefined && portableDir !== undefined,
        channel,
      }),
    deviceKeys: { keys: deviceKeys, appLockSupported: deviceHelper.file !== undefined },
  });
  host = started;
  // Every channel's handler is in the host's table; served over `ipcMain` once all are in.
  bindIpc(started.handlers);
  openWindow(started, { reopenLast: true });

  // The first window after every one closed (macOS) picks up where the last left off, as at launch.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openWindow(started, { reopenLast: true });
    }
  });
});

/** Set once the app's quit path ran: the windows then close without each running its own again. */
let quitting = false;

/**
 * Opens a window and attaches it to the host, which gives it its own services (design D1, D6). Closing
 * the window runs the quit path for it alone (`detach`) before it goes.
 */
function openWindow(target: Host, options: { readonly reopenLast: boolean }): void {
  const window = createMainWindow(platform);
  // Captured at creation: a destroyed window's `webContents` can no longer be asked for its id.
  const caller = callerForWebContents(window.webContents);
  windows.set(caller.id, window);
  target.attach(caller, options);
  window.on('close', (event) => {
    if (quitting) {
      return;
    }
    // The window stays until its workspace has kept what is unsaved; a second close waits too.
    event.preventDefault();
    void target.detach(caller.id).finally(() => {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    });
  });
  window.on('closed', () => {
    windows.delete(caller.id);
  });
}

// Quitting writes nothing to a project. Unsaved changes are kept with the workspace instead
// and come back, still unsaved, the next time it opens (`unsaved-store.ts`): the host runs every
// window's quit path at once (`shutdown`), then the app goes.
let quitStashDone = false;
app.on('before-quit', (event) => {
  if (quitStashDone) {
    return;
  }
  event.preventDefault();
  quitting = true;
  void (host?.shutdown() ?? Promise.resolve()).finally(() => {
    quitStashDone = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
