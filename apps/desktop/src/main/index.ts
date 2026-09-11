import { electronApp, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow, dialog, protocol, safeStorage, session } from 'electron';
import { registerAppProtocol } from './app-protocol-handler.js';
import { APP_SCHEME, APP_SCHEME_PRIVILEGES } from './security.js';
import { DialogPicks } from './dialog-picks.js';
import { EngineService } from './engine-service.js';
import { GlobalProperties } from './global-properties.js';
import { HistoryService } from './history-service.js';
import { PreferencesService, toPreferencesWire } from './preferences.js';
import { ProjectService } from './project-service.js';
import { RecentProjects } from './recent-projects.js';
import { safeStorageBackend, SecretStore, ShowSecretsFlag } from './secrets.js';
import { events } from '../shared/ipc.js';
import { emitEvent } from './ipc/events.js';
import { registerAppChannels } from './ipc/app.js';
import { clearAttachmentsTmp, registerAttachmentChannels } from './ipc/attachments.js';
import { registerKeystoreChannels } from './ipc/keystores.js';
import { registerWsaChannels } from './ipc/wsa.js';
import { registerWssChannels } from './ipc/wss.js';
import { registerDefinitionChannels } from './ipc/definition.js';
import { registerDialogsChannels } from './ipc/dialogs.js';
import { registerExchangeChannels } from './ipc/exchanges.js';
import { registerFsChannels } from './ipc/fs.js';
import { registerXmlChannels } from './ipc/xml.js';
import { registerXpathChannels } from './ipc/xpath.js';
import { registerValidateChannels } from './ipc/validate.js';
import { registerWsiChannels } from './ipc/wsi.js';
import { registerGlobalsChannels } from './ipc/globals.js';
import { registerHistoryChannels } from './ipc/history.js';
import { registerPreferencesChannels } from './ipc/preferences.js';
import { registerProjectChannels } from './ipc/project.js';
import { registerRequestChannels } from './ipc/request.js';
import { registerSearchChannels } from './ipc/search.js';
import { registerSecretsChannels } from './ipc/secrets.js';
import { registerThemeChannels } from './ipc/theme.js';
import { createMainWindow } from './windows.js';
import type { IpcEvent } from '../shared/ipc.js';
import type { z } from 'zod';
import type { ProjectWire } from '../shared/wire-types.js';

// Must run before `app.ready` — Electron only honours scheme privileges registered this
// early. This is what lets the packaged renderer be served from a real (non-`file://`)
// origin, which Monaco's web workers need.
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }]);

// e2e (see `e2e/helpers/launch-app.ts`) launches every test against a fresh, isolated
// profile instead of the developer's real one, set via this env var rather than a CLI flag
// Electron doesn't parse on its own. This MUST run before anything below reads
// `app.getPath('userData')` (the secret store included), or it would keep writing to the
// developer's real profile regardless of the override.
const e2eUserDataDir = process.env['WIREBENCH_USER_DATA_DIR'];
if (e2eUserDataDir !== undefined) {
  app.setPath('userData', e2eUserDataDir);
}

/** The keychain-backed secret store; never exposes values to the renderer (no `secrets.get`). */
const secretStore = new SecretStore(app.getPath('userData'), safeStorageBackend(safeStorage));
/** Session-only "show secrets" toggle, consulted by `redact.ts` via `request.send`. */
const showSecretsFlag = new ShowSecretsFlag();

/** The single in-process engine instance backing every `definition.*`/`request.*` channel. */
const engineService = new EngineService((ref) => secretStore.get(ref));

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

/** The user's `${#Global#name}` scope, shared by every project and every window. */
const globalProperties = new GlobalProperties(app.getPath('userData'));

/** The user's application preferences, shared by every project and every window. */
const preferencesService = new PreferencesService(app.getPath('userData'));

/** Absolute paths the user picked through a native dialog this session; see `dialog-picks.ts`. */
const dialogPicks = new DialogPicks();

/** The open project's persistent history — a jsonl file under `userData`, opened/closed as projects change. */
const historyService = new HistoryService(app.getPath('userData'), () => preferencesService.get().ui.historyCap);

const projectService = new ProjectService(
  engineService,
  new RecentProjects(app.getPath('userData')),
  {
    onChanged: (project) => {
      // History has to be open (or closed) *before* `project.changed` reaches the renderer —
      // `subscribeToHistory` reloads on that event, and a reload racing the file open would
      // just see the stale (or wrong-project) history.
      const announce = (): void => {
        broadcast(events.project.changed, { project });
        applyWindowTitle(project);
      };
      if (project === null) {
        historyService.close();
        announce();
      } else if (historyService.projectId !== project.id) {
        void historyService.open(project.id).then(announce);
      } else {
        announce();
      }
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
  },
  undefined,
  globalProperties,
  secretStore,
  preferencesService,
  dialogPicks,
  // "System proxy" means whatever Chromium's own network stack means by it — including any PAC
  // file or OS setting — rather than a second, subtly different guess of our own.
  async (url) => await session.defaultSession.resolveProxy(url).catch(() => undefined),
);

// A CA bundle the user picked in an earlier session is remembered as a read pick at startup.
// The path comes from main's own `userData/preferences.yaml` — written only after a native
// dialog — so it is the same evidence a fresh pick would be, and without this every restart
// would silently stop trusting a bundle that lives outside the project folder. See
// `ProjectService.trustAnchors`, which still runs the full `allowsReadPath` check.
const storedCaBundle = preferencesService.get().ssl.caBundlePath;
if (storedCaBundle !== undefined && storedCaBundle.length > 0) {
  dialogPicks.rememberRead(storedCaBundle);
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.wirebench.desktop');
  registerAppProtocol();

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerAppChannels();
  registerDefinitionChannels(engineService, { project: projectService, picks: dialogPicks });
  registerRequestChannels(engineService, {
    project: projectService,
    showSecrets: showSecretsFlag,
    history: historyService,
    onHistoryAppended: (entry) => broadcast(events.history.appended, { entry }),
    preferences: preferencesService,
    dialogPicks,
  });
  registerHistoryChannels(engineService, historyService, {
    project: projectService,
    showSecrets: showSecretsFlag,
    onHistoryAppended: (entry) => broadcast(events.history.appended, { entry }),
  });
  registerProjectChannels(projectService);
  registerGlobalsChannels(globalProperties, (properties) => {
    broadcast(events.globals.changed, { properties });
  });
  registerPreferencesChannels(preferencesService, (preferences) => {
    broadcast(events.preferences.changed, { preferences });
  });
  registerThemeChannels((payload) => {
    broadcast(events.theme.changed, payload);
  });
  registerDialogsChannels(dialogPicks);
  registerFsChannels();
  registerXmlChannels(engineService);
  registerXpathChannels();
  registerValidateChannels(engineService, projectService);
  registerWsiChannels(engineService, {
    project: projectService,
    picks: dialogPicks,
    dialog: {
      // Mirrors `dialogs.saveFile`, including its e2e override: a Playwright run cannot drive a
      // native Save-as panel, so the same env var short-circuits both.
      showSave: async (options) => {
        const override = process.env['WIREBENCH_E2E_DIALOG_SAVE'];
        if (override !== undefined) {
          return override;
        }
        const result = await dialog.showSaveDialog({
          title: options.title,
          defaultPath: options.defaultPath,
          filters: [{ name: 'HTML', extensions: ['html'] }],
        });
        return result.canceled ? undefined : result.filePath;
      },
    },
  });
  registerSearchChannels(engineService, projectService);
  registerSecretsChannels(secretStore, showSecretsFlag);
  registerExchangeChannels(engineService.exchanges, showSecretsFlag);
  registerAttachmentChannels({
    exchanges: engineService.exchanges,
    project: projectService,
    picks: dialogPicks,
    userDataDir: app.getPath('userData'),
  });
  registerKeystoreChannels({ project: projectService, picks: dialogPicks });
  registerWsaChannels({ project: projectService });
  registerWssChannels({ project: projectService });
  // Last session's decrypted attachment copies are disposable; sweep them off the disk without
  // making the first window wait on it.
  void clearAttachmentsTmp(app.getPath('userData'));
  // Warms the in-memory map so the first send does not have to wait on a disk read, and corrects
  // any early `globals.get` subscriber that raced ahead of the load with the on-disk properties.
  void globalProperties.load().then((properties) => {
    broadcast(events.globals.changed, { properties });
  });
  // Same warm-up for preferences: the send path reads them synchronously, and any renderer that
  // asked before the load finished is corrected by the broadcast.
  void preferencesService.load().then((preferences) => {
    broadcast(events.preferences.changed, { preferences: toPreferencesWire(preferences) });
  });
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
