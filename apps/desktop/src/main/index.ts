import { electronApp, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow, protocol } from 'electron';
import { registerAppProtocol } from './app-protocol-handler.js';
import { APP_SCHEME, APP_SCHEME_PRIVILEGES } from './security.js';
import { EngineService } from './engine-service.js';
import { registerAppChannels } from './ipc/app.js';
import { registerDefinitionChannels } from './ipc/definition.js';
import { registerDialogsChannels } from './ipc/dialogs.js';
import { registerRequestChannels } from './ipc/request.js';
import { createMainWindow } from './windows.js';

/** The single in-process engine instance backing every `definition.*`/`request.*` channel. */
const engineService = new EngineService();

// Must run before `app.ready` — Electron only honours scheme privileges registered this
// early. This is what lets the packaged renderer be served from a real (non-`file://`)
// origin, which Monaco's web workers need.
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }]);

// e2e (see `e2e/helpers/launch-app.ts`) launches every test against a fresh, isolated
// profile instead of the developer's real one, set via this env var rather than a CLI flag
// Electron doesn't parse on its own.
const e2eUserDataDir = process.env['WIREBENCH_USER_DATA_DIR'];
if (e2eUserDataDir !== undefined) {
  app.setPath('userData', e2eUserDataDir);
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.wirebench.desktop');
  registerAppProtocol();

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerAppChannels();
  registerDefinitionChannels(engineService);
  registerRequestChannels(engineService);
  registerDialogsChannels();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
