import { electronApp, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow } from 'electron';
import { registerAppChannels } from './ipc/app.js';
import { createMainWindow } from './windows.js';

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.wirebench.desktop');

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerAppChannels();
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
