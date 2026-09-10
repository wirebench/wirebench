import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import { BrowserWindow, session, shell } from 'electron';
import { events } from '../shared/ipc.js';
import { CONTENT_SECURITY_POLICY, MAIN_WINDOW_WEB_PREFERENCES, isExternalUrlAllowed } from './security.js';

// Electron's sandboxed preload loader only supports CommonJS (see electron.vite.config.ts),
// so the preload bundle is forced to `.cjs` even though this package is `"type": "module"`.
const PRELOAD_PATH = join(import.meta.dirname, '../preload/index.cjs');

/**
 * Applies {@link CONTENT_SECURITY_POLICY} to every response served to the app's session.
 * Skipped in dev: the packaged app is what this baseline protects, and Vite's dev server
 * relies on an inline React Fast Refresh preamble script and `eval`-based HMR that the
 * production policy intentionally forbids.
 */
function applyContentSecurityPolicy(): void {
  if (is.dev) {
    return;
  }
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    });
  });
}

/**
 * Creates the main application window with the hardened security baseline: sandboxed,
 * isolated, no Node integration, in-app navigation only, and external links handed off to
 * the OS browser instead of opened in a new Electron window.
 */
export function createMainWindow(): BrowserWindow {
  applyContentSecurityPolicy();

  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      ...MAIN_WINDOW_WEB_PREFERENCES,
      preload: PRELOAD_PATH,
    },
  });

  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrlAllowed(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.once('did-finish-load', () => {
    win.webContents.send(events.app.ready.name, { at: new Date().toISOString() });
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl !== undefined) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }

  return win;
}
