import { electronApp, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow, protocol } from 'electron';
import { registerAppProtocol } from './app-protocol-handler.js';
import { APP_SCHEME, APP_SCHEME_PRIVILEGES } from './security.js';
import { EngineService } from './engine-service.js';
import { ProjectService } from './project-service.js';
import { RecentProjects } from './recent-projects.js';
import { events } from '../shared/ipc.js';
import { emitEvent } from './ipc/events.js';
import { registerAppChannels } from './ipc/app.js';
import { registerDefinitionChannels } from './ipc/definition.js';
import { registerDialogsChannels } from './ipc/dialogs.js';
import { registerProjectChannels } from './ipc/project.js';
import { registerRequestChannels } from './ipc/request.js';
import { createMainWindow } from './windows.js';
import type { IpcEvent } from '../shared/ipc.js';
import type { z } from 'zod';
import type { ProjectWire } from '../shared/wire-types.js';

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

/** Sends one event to every open window: project state is global, not per-invocation. */
function broadcast<Payload extends z.ZodType>(event: IpcEvent<Payload>, payload: z.infer<Payload>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    emitEvent(window.webContents, event, payload);
  }
}

/** Keeps the OS window title in step with the open project, as `name — Wirebench`. */
function applyWindowTitle(project: ProjectWire | null): void {
  const title = project === null ? 'Wirebench' : `${project.name} — Wirebench`;
  for (const window of BrowserWindow.getAllWindows()) {
    window.setTitle(title);
  }
}

const projectService = new ProjectService(engineService, new RecentProjects(app.getPath('userData')), {
  onChanged: (project) => {
    broadcast(events.project.changed, { project });
    applyWindowTitle(project);
  },
  onChangedOnDisk: (paths) => {
    broadcast(events.project.changedOnDisk, { paths: [...paths] });
  },
  onHydration: (event) => {
    broadcast(events.project.hydration, event);
  },
  onProgress: (progress) => {
    broadcast(events.engine.progress, progress);
  },
});

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.wirebench.desktop');
  registerAppProtocol();

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerAppChannels();
  registerDefinitionChannels(engineService);
  registerRequestChannels(engineService);
  registerProjectChannels(projectService);
  registerDialogsChannels();
  createMainWindow();
  applyWindowTitle(projectService.snapshot());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

// Unsaved work is never lost to a quit: the final save runs before the app exits, without a
// prompt (an autosaving app that asks "save before quitting?" is just an autosave that failed).
let quitSaveDone = false;
app.on('before-quit', (event) => {
  if (quitSaveDone) {
    return;
  }
  event.preventDefault();
  void projectService
    .save({ reason: 'quit' })
    .catch(() => undefined)
    .finally(() => {
      quitSaveDone = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
