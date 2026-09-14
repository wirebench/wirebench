import { mkdirSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { WirebenchError, enabledProperties } from '@wirebench/engine';
import { app, BrowserWindow, dialog, protocol, safeStorage, session, shell } from 'electron';
import { registerAppProtocol } from './app-protocol-handler.js';
import { APP_SCHEME, APP_SCHEME_PRIVILEGES, isExternalUrlAllowed } from './security.js';
import { saveOverride } from './native-dialogs.js';
import { DialogPicks } from './dialog-picks.js';
import { EngineService } from './engine-service.js';
import { GlobalProperties } from './global-properties.js';
import { HistoryService } from './history-service.js';
import {
  gitLocatorOptions,
  PreferencesService,
  rememberPickedCaBundle,
  rememberPickedGit,
  toPreferencesWire,
} from './preferences.js';
import { findGit, GitCli } from './sync/git-cli.js';
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
import { registerApiChannels } from './ipc/api.js';
import { registerProjectChannels } from './ipc/project.js';
import { registerWorkspaceChannels } from './ipc/workspace.js';
import { registerRequestChannels } from './ipc/request.js';
import { registerOAuth2Channels } from './ipc/oauth2.js';
import { OAuth2Service } from './oauth2.js';
import { OpenApiImportService } from './openapi-import.js';
import { registerSearchChannels } from './ipc/search.js';
import { registerSecretsChannels } from './ipc/secrets.js';
import { registerSslChannels } from './ipc/ssl.js';
import { registerGitChannels } from './ipc/git.js';
import { registerSyncChannels } from './ipc/sync.js';
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
/**
 * OAuth2 tokens for the session, and the one loopback listener a browser sign-in answers to.
 *
 * The callback port comes from preferences because some providers insist on an exact redirect URI;
 * with none set the listener takes a random free port, which is what RFC 8252 prefers.
 */
const oauth2Service = new OAuth2Service({
  openExternal: async (url) => {
    if (!isExternalUrlAllowed(url)) {
      throw new WirebenchError('external-url-refused', 'That authorization URL is not an http(s) address');
    }
    await shell.openExternal(url);
  },
  callbackPort: () => preferencesService.get().rest.oauth2CallbackPort,
});

/** The session's in-flight OpenAPI imports: one fetcher, one cancel per token. */
const openApiImports = new OpenApiImportService();

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
 *
 * The override is honoured only in an unpackaged run (every e2e run is one). In a shipped build
 * it would let an environment variable redirect a deletion to a folder of someone else's
 * choosing, so a packaged app always uses the real trash.
 */
async function trashFolder(target: string): Promise<void> {
  const e2eTrashDir = app.isPackaged ? undefined : process.env['WIREBENCH_E2E_TRASH_DIR'];
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
// `core.hooksPath` for every `GitCli.run` call points here: an empty, writable directory, so
// a cloned or joined tree's own `.git/hooks` (or any hook a remote's push tries to install)
// never runs. Created once in `whenReady`, before any workspace (and so any sync) can open.
const hooksDir = join(app.getPath('userData'), 'git-hooks-empty');

// e2e cannot install a real git on every runner, so this simulates "git missing"/"git found
// at this exact path" instead. Honoured only in an unpackaged run, for the same reason every
// other `WIREBENCH_E2E_*` override is: a packaged build must not let an environment variable
// redirect which executable main runs. Precedence (see `gitLocatorOptions`): the e2e override,
// restricted to that path alone (so it can simulate "no git installed" even on a machine or CI
// runner that has a real one), then a git.path preference main itself picked (`configuredGitPath`
// — an unmarked or cleared value never counts), then plain discovery.
const gitLocator = (): ReturnType<typeof findGit> =>
  findGit(gitLocatorOptions({ env: process.env, isPackaged: app.isPackaged, preferences: preferencesService.get() }));

const workspaceService = new WorkspaceService({
  userDataDir: app.getPath('userData'),
  // Located afresh for each shared workspace that opens, so a git installed (or picked in
  // Settings) since the last open is found without a restart.
  git: async () => {
    const location = await gitLocator();
    return location === undefined ? undefined : new GitCli(location, { hooksDir });
  },
  hooksDir,
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
    onWorkspaceChangedOnDisk: (workspaceId, paths, message) => {
      broadcast(events.workspace.changedOnDisk, { workspaceId, paths: [...paths], message });
    },
    onSyncStatus: (workspaceId, status) => {
      broadcast(events.sync.statusChanged, { workspaceId, status });
    },
    onSyncPulled: (event) => {
      broadcast(events.sync.pulled, event);
    },
    onSyncConflict: (workspaceId, conflicts) => {
      broadcast(events.sync.conflict, { workspaceId, conflicts: [...conflicts] });
    },
    onGitIdentityNeeded: (workspaceId) => {
      broadcast(events.git.identityNeeded, { workspaceId });
    },
  },
});

// The product name, set before `ready` so the macOS application menu (`role: 'appMenu'`) and
// the About panel read "Wirebench" in development too. A packaged bundle already carries it as
// `productName` (CFBundleName); without this, a `pnpm dev` run shows Electron's own name.
app.setName('Wirebench');
app.setAboutPanelOptions({ applicationName: 'Wirebench', applicationVersion: app.getVersion() });

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.wirebench.desktop');
  registerAppProtocol();

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Created once, up front, so it exists before any sync operation can start (see `hooksDir`).
  mkdirSync(hooksDir, { recursive: true });

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
    adHocScopes: () => {
      const state = globalProperties.get();
      return { project: {}, global: enabledProperties(state.properties, state.disabled), system: process.env };
    },
    showSecrets: showSecretsFlag,
    history: historyService,
    onHistoryAppended: (entry) => broadcast(events.history.appended, { entry }),
    preferences: preferencesService,
    dialogPicks,
    oauth2: oauth2Service,
    getSecret: (ref) => secretStore.get(ref),
  });
  registerOAuth2Channels({
    oauth2: oauth2Service,
    project: workspaceService,
    getSecret: (ref) => secretStore.get(ref),
    // A refresh token replaces the value the configuration's own reference already names; a new
    // reference is never minted here, because the project file would then have to change to match.
    setSecret: async (ref, value) => {
      await secretStore.replace(ref, value);
    },
    showSecrets: showSecretsFlag,
  });
  registerHistoryChannels(engineService, historyService, {
    project: workspaceService,
    adHocScopes: () => {
      const state = globalProperties.get();
      return { project: {}, global: enabledProperties(state.properties, state.disabled), system: process.env };
    },
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
  registerApiChannels({
    router: workspaceService,
    imports: openApiImports,
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
  registerGlobalsChannels(globalProperties, (state) => {
    broadcast(events.globals.changed, state);
  });
  registerPreferencesChannels(preferencesService, (preferences) => {
    broadcast(events.preferences.changed, { preferences });
    // Turning autosave on mid-session must pick up whatever is already outstanding, rather than
    // waiting for one more edit to arm the timer.
    if (preferences.editor.autosave) {
      for (const host of workspaceService.hosts()) {
        host.onAutosaveEnabled();
      }
    }
  });
  registerSslChannels({
    preferences: preferencesService,
    picks: dialogPicks,
    onChanged: (preferences) => {
      broadcast(events.preferences.changed, { preferences });
    },
  });
  registerGitChannels({
    preferences: preferencesService,
    picks: dialogPicks,
    // `git.detect` uses exactly `gitLocator`'s precedence (e2e override, then a marked
    // `git.path`, then discovery) — no configured-path logic of its own, so a marked preference
    // can never bypass the e2e "no git" override. `git.locate` keeps probing the picked file
    // directly (its own explicit candidate) via the default `findGit`.
    locate: gitLocator,
    onChanged: (preferences) => {
      broadcast(events.preferences.changed, { preferences });
    },
  });
  registerSyncChannels({
    service: workspaceService,
    reveal: (path) => {
      shell.showItemInFolder(path);
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
        const override = saveOverride();
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
  void globalProperties.load().then(
    (state) => {
      broadcast(events.globals.changed, state);
    },
    (error: unknown) => {
      // A globals file this build refuses (one stamped with a newer format version) must not
      // take the app down with it: the store keeps rejecting every read and write, so the file
      // stays untouched, and there is simply no global scope this session.
      console.error('Global properties could not be loaded', error);
    },
  );
  // Same warm-up for preferences: the send path reads them synchronously, and any renderer that
  // asked before the load finished is corrected by the broadcast.
  void preferencesService.load().then((preferences) => {
    // A CA bundle *main itself picked* in an earlier session becomes a read pick again here —
    // and only one carrying the `caBundlePickedByMain` marker, so a hand-edited preferences
    // file cannot smuggle a path into the read-pick set. It has to happen after the load
    // resolves: before it, the in-memory document is still the defaults.
    rememberPickedCaBundle(preferences, dialogPicks);
    // Same evidence, same reason, for a git executable main itself picked (`git.pathPickedByMain`).
    rememberPickedGit(preferences, dialogPicks);
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

// Quitting writes nothing to a project. Unsaved changes are kept with the workspace instead
// and come back, still unsaved, the next time it opens (`unsaved-store.ts`): the window is asked
// to hand over its staged request edits first (briefly — a hung window cannot hold the quit),
// then the workspace closes, recording every open project's unsaved state.
const QUIT_DRAFTS_TIMEOUT_MS = 2_000;
let quitStashDone = false;
app.on('before-quit', (event) => {
  if (quitStashDone) {
    return;
  }
  event.preventDefault();
  const windowOpen = BrowserWindow.getAllWindows().some((window) => !window.isDestroyed());
  const stashed = windowOpen ? workspaceService.nextDraftsStash(QUIT_DRAFTS_TIMEOUT_MS) : Promise.resolve();
  if (windowOpen) {
    broadcast(events.workspace.flushDrafts, {});
  }
  void stashed
    .then(async () => {
      await workspaceService.close();
    })
    .catch(() => undefined)
    .finally(() => {
      quitStashDone = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
