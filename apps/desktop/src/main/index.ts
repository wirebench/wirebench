import { electronApp, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow } from 'electron';
import { EngineService } from './engine-service.js';
import { registerAppChannels } from './ipc/app.js';
import { registerDefinitionChannels } from './ipc/definition.js';
import { registerRequestChannels } from './ipc/request.js';
import { createMainWindow } from './windows.js';

/** The single in-process engine instance backing every `definition.*`/`request.*` channel. */
const engineService = new EngineService();

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.wirebench.desktop');

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerAppChannels();
  registerDefinitionChannels(engineService);
  registerRequestChannels(engineService);
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
