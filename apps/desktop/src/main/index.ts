import { mkdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow, dialog, protocol, safeStorage, session, shell } from 'electron';
import { registerAppProtocol } from './app-protocol-handler.js';
import { APP_SCHEME, APP_SCHEME_PRIVILEGES } from './security.js';
import { DialogPicks } from './dialog-picks.js';
import { EngineService } from './engine-service.js';
import { GlobalProperties } from './global-properties.js';
import { HistoryService } from './history-service.js';
import { PreferencesService, rememberPickedCaBundle, toPreferencesWire } from './preferences.js';
import { readLeftoverProjectFolders, WorkspaceService } from './workspace-service.js';
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
import { registerWorkspaceChannels } from './ipc/workspace.js';
import { registerRequestChannels } from './ipc/request.js';
import { registerSearchChannels } from './ipc/search.js';
import { registerSecretsChannels } from './ipc/secrets.js';
import { registerSslChannels } from './ipc/ssl.js';
import { registerThemeChannels } from './ipc/theme.js';
import { createMainWindow } from './windows.js';
import { createUpdateController } from './update-service.js';
import type { IpcEvent } from '../shared/ipc.js';
import type { z } from 'zod';
import type { WorkspaceWire } from '../shared/wire-types.js';

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

/** Keeps the OS window title in step with the open workspace, as `name — Wirebench`. */
function applyWindowTitle(workspace: WorkspaceWire | null): void {
  const title = workspace === null ? 'Wirebench' : `${workspace.name} — Wirebench`;
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

/** Persistent request history — one jsonl file per open project under `userData`. */
const historyService = new HistoryService(app.getPath('userData'), () => preferencesService.get().ui.historyCap);

/**
 * Where a deleted workspace (or project folder) goes. `shell.trashItem` in a real run; under
 * e2e, a move into `WIREBENCH_E2E_TRASH_DIR`, because a Playwright run must be able to *assert*
 * on what was trashed and the OS trash is neither readable nor per-profile. Either way nothing
 * is ever removed: there is no `rm` on this path.
 */
async function trashFolder(target: string): Promise<void> {
  const e2eTrashDir = process.env['WIREBENCH_E2E_TRASH_DIR'];
  if (e2eTrashDir === undefined) {
    await shell.trashItem(target);
    return;
  }
  await mkdir(e2eTrashDir, { recursive: true });
  await rename(target, join(e2eTrashDir, `${basename(target)}-${String(Date.now())}`));
}

/**
 * The open workspace and every project host inside it. It is also the `ProjectRouter` every
 * `register*Channels` call is handed, so a channel addressed at an entity reaches that entity's
 * own project rather than a single ambient one.
 */
const workspaceService = new WorkspaceService({
  userDataDir: app.getPath('userData'),
  engine: engineService,
  globals: globalProperties,
  secrets: secretStore,
  preferences: preferencesService,
  picks: dialogPicks,
  history: historyService,
  trash: trashFolder,
  // "System proxy" means whatever Chromium's own network stack means by it — including any PAC
  // file or OS setting — rather than a second, subtly different guess of our own.
  resolveSystemProxy: async (url) => await session.defaultSession.resolveProxy(url).catch(() => undefined),
  hooks: {
    onChanged: (workspace) => {
      broadcast(events.workspace.changed, { workspace });
      applyWindowTitle(workspace);
    },
    onProjectChanged: (projectId, project) => {
      broadcast(events.project.changed, { projectId, project });
    },
    onProjectChangedOnDisk: (projectId, paths) => {
      broadcast(events.project.changedOnDisk, { projectId, paths: [...paths] });
    },
    onHydration: (projectId, event) => {
      broadcast(events.project.hydration, { projectId, ...event });
    },
    onProgress: (progress) => {
      broadcast(events.engine.progress, progress);
    },
  },
});

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.wirebench.desktop');
  registerAppProtocol();

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  const updates = createUpdateController((status) => {
    broadcast(events.app.updateStatus, { status });
  });
  registerAppChannels(undefined, async () => await updates.check({ trigger: 'user' }));
  // Every open project's folder: the containment roots a renderer-named import path may sit in.
  const openProjectDirs = (): readonly string[] =>
    workspaceService
      .hosts()
      .map((host) => host.snapshot()?.dir)
      .filter((dir): dir is string => dir !== undefined);
  registerDefinitionChannels(engineService, {
    project: workspaceService,
    picks: dialogPicks,
    projectDirs: openProjectDirs,
  });
  registerRequestChannels(engineService, {
    project: workspaceService,
    adHocScopes: () => ({ project: {}, global: globalProperties.get(), system: process.env }),
    showSecrets: showSecretsFlag,
    history: historyService,
    onHistoryAppended: (entry) => broadcast(events.history.appended, { entry }),
    preferences: preferencesService,
    dialogPicks,
  });
  registerHistoryChannels(engineService, historyService, {
    project: workspaceService,
    adHocScopes: () => ({ project: {}, global: globalProperties.get(), system: process.env }),
    showSecrets: showSecretsFlag,
    onHistoryAppended: (entry) => broadcast(events.history.appended, { entry }),
  });
  registerProjectChannels({
    router: workspaceService,
    addProject: async (name) => await workspaceService.addProject(name),
    removeProject: async (projectId, options) => await workspaceService.removeProject(projectId, options),
    projectDirs: openProjectDirs,
    picks: dialogPicks,
  });
  // The launch-time reopen of the last workspace. It waits for preferences (every host folds
  // them into its send defaults, and a workspace opened before the load would hold the
  // defaults), and a workspace that will not open is not an error the app dies of: the picker
  // shows `lastError()`. `workspace.snapshot`/`list` wait on it, so the renderer's first answer
  // is already the reopened workspace (or the picker with its error), never a flash of both.
  const startup = preferencesService.ready().then(async () => {
    await workspaceService.openLast().catch(() => null);
  });
  registerWorkspaceChannels({
    service: workspaceService,
    suggestions: async () => await readLeftoverProjectFolders(app.getPath('userData')),
    ready: () => startup,
    reveal: (dir) => {
      shell.showItemInFolder(dir);
    },
  });
  registerGlobalsChannels(globalProperties, (properties) => {
    broadcast(events.globals.changed, { properties });
  });
  registerPreferencesChannels(preferencesService, (preferences) => {
    broadcast(events.preferences.changed, { preferences });
  });
  registerSslChannels({
    preferences: preferencesService,
    picks: dialogPicks,
    onChanged: (preferences) => {
      broadcast(events.preferences.changed, { preferences });
    },
  });
  registerThemeChannels((payload) => {
    broadcast(events.theme.changed, payload);
  });
  registerDialogsChannels(dialogPicks);
  registerFsChannels();
  registerXmlChannels(engineService);
  registerXpathChannels();
  registerValidateChannels(engineService, workspaceService);
  registerWsiChannels(engineService, {
    project: workspaceService,
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
  registerSearchChannels(engineService, workspaceService);
  registerSecretsChannels(secretStore, showSecretsFlag);
  registerExchangeChannels(engineService.exchanges, showSecretsFlag);
  registerAttachmentChannels({
    exchanges: engineService.exchanges,
    project: workspaceService,
    picks: dialogPicks,
    userDataDir: app.getPath('userData'),
  });
  registerKeystoreChannels({ project: workspaceService, picks: dialogPicks });
  registerWsaChannels({ project: workspaceService });
  registerWssChannels({ project: workspaceService });
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
    // A CA bundle *main itself picked* in an earlier session becomes a read pick again here —
    // and only one carrying the `caBundlePickedByMain` marker, so a hand-edited preferences
    // file cannot smuggle a path into the read-pick set. It has to happen after the load
    // resolves: before it, the in-memory document is still the defaults.
    rememberPickedCaBundle(preferences, dialogPicks);
    broadcast(events.preferences.changed, { preferences: toPreferencesWire(preferences) });
  });
  createMainWindow();
  applyWindowTitle(workspaceService.snapshot());

  // Opt-in, and only after the preferences are actually loaded — the default is off, so a
  // check that ran before the load would read "off" for every user who turned it on.
  void startup.then(async () => {
    await updates.checkOnLaunch(() => preferencesService.get().updates.checkOnLaunch);
  });

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
  void workspaceService
    .saveAll('quit')
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
