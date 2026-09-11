import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import { BrowserWindow, nativeTheme, session, shell } from 'electron';
import { events } from '../shared/ipc.js';
import { OS_THEME_ARGUMENT } from '../shared/os-theme-argument.js';
import { emitEvent } from './ipc/events.js';
import {
  APP_SCHEME,
  APP_SCHEME_HOST,
  CONTENT_SECURITY_POLICY,
  MAIN_WINDOW_WEB_PREFERENCES,
  isExternalUrlAllowed,
} from './security.js';

// Electron's sandboxed preload loader only supports CommonJS (see electron.vite.config.ts),
// so the preload bundle is forced to `.cjs` even though this package is `"type": "module"`.
const PRELOAD_PATH = join(import.meta.dirname, '../preload/index.cjs');

/** The production renderer's URL, served by `app-protocol-handler.ts` instead of `file://`. */
const PRODUCTION_RENDERER_URL = `${APP_SCHEME}://${APP_SCHEME_HOST}/index.html`;

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
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#151413',
    // macOS gets the custom title bar the shell draws (see renderer/shell/title-bar.tsx); the
    // traffic lights are inset into it. Windows and Linux keep their native frame for now.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 12 } }
      : {}),
    webPreferences: {
      ...MAIN_WINDOW_WEB_PREFERENCES,
      preload: PRELOAD_PATH,
      // The OS colour scheme, baked into the preload's argv so the renderer can resolve a
      // `system` theme preference before its first paint instead of after a `theme.get` round
      // trip. `theme.changed` keeps it current from here on.
      additionalArguments: [`${OS_THEME_ARGUMENT}${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`],
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
    emitEvent(win.webContents, events.app.ready, { at: new Date().toISOString() });
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl !== undefined) {
    void win.loadURL(devServerUrl);
  } else {
    // Not `loadFile`: a `file://` origin is opaque, which blocks Monaco's web workers.
    // `app-protocol-handler.ts` serves this from the same `out/renderer` directory instead.
    void win.loadURL(PRODUCTION_RENDERER_URL);
  }

  return win;
}
