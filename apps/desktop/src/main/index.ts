import { mkdirSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { appVersion } from './app-version.js';
import {
  connectWebSocket,
  findGit,
  GitCli,
  WirebenchError,
  WorkspaceError,
  enabledProperties,
  overlayCurrent,
  type ConnectOptions,
  type GetSecret,
} from '@wirebench/engine';
import { app, BrowserWindow, dialog, protocol, safeStorage, session, shell } from 'electron';
import { registerAppProtocol } from './app-protocol-handler.js';
import { APP_SCHEME, APP_SCHEME_PRIVILEGES, isExternalUrlAllowed } from './security.js';
import { saveOverride } from './native-dialogs.js';
import { DialogPicks } from './dialog-picks.js';
import { EngineService } from './engine-service.js';
import { GlobalProperties } from './global-properties.js';
import { HistoryService, watchHistoryFile } from './history-service.js';
import {
  gitLocatorOptions,
  PreferencesService,
  rememberPickedCaBundle,
  rememberPickedGit,
  toPreferencesWire,
} from './preferences.js';
import { policyFilePath } from './policy.js';
import { portableDataDir } from './portable.js';
import { readLeftoverProjectFolders, WorkspaceService } from './workspace-service.js';
import { WorkspaceState } from './workspace-state.js';
import { routeWorkspaces, scoped, WindowScopes } from './window-scope.js';
import { safeStorageBackend, SecretStore, ShowSecretsFlag } from './secrets.js';
import { recordSecretValue, redactSecretText } from './redact.js';
import { SecretSourcesService } from './secret-sources-service.js';
import { projectSecretGetter, workspaceSecretGetter } from './secret-resolver.js';
import { SshSecretsService } from './ssh-secrets.js';
import { SecretScanSessions } from './secret-scan-session.js';
import { TeamSecretsService } from './team-secrets-service.js';
import { TeamSecretStore, teamSecretGetter } from './team-secret-store.js';
import { events } from '../shared/ipc.js';
import { emitEvent } from './ipc/events.js';
import { registerAppChannels } from './ipc/app.js';
import { enabledAreasFromEnv, hostsOnWorkspaceChange, registerEnabledAreaChannels } from './areas.js';
import { HostsService } from './hosts-service.js';
import { SshService, sshSessionsEndOnSwitch } from './ssh-service.js';
import { registerKerberosChannels, setUpKerberos } from './kerberos.js';
import { clearAttachmentsTmp, registerAttachmentChannels } from './ipc/attachments.js';
import { registerKeystoreChannels } from './ipc/keystores.js';
import { registerCertificateChannels } from './ipc/certificates.js';
import { registerWsaChannels } from './ipc/wsa.js';
import { registerWssChannels } from './ipc/wss.js';
import { registerDefinitionChannels } from './ipc/definition.js';
import { registerDialogsChannels } from './ipc/dialogs.js';
import { registerExchangeChannels } from './ipc/exchanges.js';
import { registerLogChannels } from './ipc/log.js';
import { registerFsChannels } from './ipc/fs.js';
import { registerXmlChannels } from './ipc/xml.js';
import { registerXpathChannels } from './ipc/xpath.js';
import { registerValidateChannels } from './ipc/validate.js';
import { registerWsiChannels } from './ipc/wsi.js';
import { registerGlobalsChannels } from './ipc/globals.js';
import { CookieStore } from './cookie-store.js';
import { CurrentValuesStore } from './current-values.js';
import { registerCookiesChannels } from './ipc/cookies.js';
import { registerCurrentValuesChannels } from './ipc/current-values.js';
import { registerHistoryChannels } from './ipc/history.js';
import { registerPreferencesChannels } from './ipc/preferences.js';
import { registerApiChannels } from './ipc/api.js';
import { registerProjectChannels } from './ipc/project.js';
import { registerWorkspaceChannels } from './ipc/workspace.js';
import { registerMockChannels } from './ipc/mock.js';
import { registerSequenceChannels } from './ipc/sequence.js';
import { MOCK_ALL_INTERFACES_HOST, MOCK_LOOPBACK_HOST, MockRunner } from './mock-runner.js';
import { SequenceRunner } from './sequence-runner.js';
import { ScriptHost } from './script-host.js';
import { registerScriptChannels } from './ipc/script.js';
import {
  registerRequestChannels,
  toSendDeps,
  whenRestSendsRecorded,
  whenWsSessionsRecorded,
  type RequestChannelDeps,
} from './ipc/request.js';
import { registerOAuth2Channels } from './ipc/oauth2.js';
import { registerIssuedTokenChannels } from './ipc/issued-tokens.js';
import { IssuedTokensService, type ResolvedIssuedToken } from './issued-tokens.js';
import { desktopSecrets, stsLogEntry } from './send/host.js';
import { ExchangeRegistry } from './send/exchange.js';
import { OAuth2Service } from './oauth2.js';
import { registerAccountChannels, toAccountWire } from './ipc/account.js';
import { registerTeamChannels } from './ipc/team.js';
import { HooksService } from './hooks/hooks-service.js';
import { desktopCaptureSource, linkedServerOf } from './hooks/capture-source.js';
import { registerCiTokenChannels } from './ipc/ci-tokens.js';
import { registerLicenseChannels } from './ipc/license.js';
import { registerAuditChannels } from './ipc/audit.js';
import { registerHooksChannels } from './ipc/hooks.js';
import { AccountService } from './account-service.js';
import { AuditReporter } from './audit/reporter.js';
import { normalizeServerUrl, ServerClient } from './server-client.js';
import { LiveClients } from './live/live-clients.js';
import { mainHttpOptions, type MainHttpDeps } from './network-options.js';
import { OpenApiImportService } from './openapi-import.js';
import { ProtoImportService } from './proto-import.js';
import { registerSearchChannels } from './ipc/search.js';
import { registerSecretsChannels } from './ipc/secrets.js';
import { registerSecretSourcesChannels } from './ipc/secret-sources.js';
import { registerTeamSecretsChannels } from './ipc/team-secrets.js';
import { registerSecretScanChannels } from './ipc/secret-scan.js';
import { registerSnapshotChannels } from './ipc/snapshot.js';
import { SnapshotStore } from './snapshot-store.js';
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
// The portable Windows build keeps its profile in the `data` folder beside `Wirebench.exe`
// (see `portable.ts`); same constraint, it has to be set before anything reads `userData`.
const portableDir = portableDataDir({
  platform: process.platform,
  isPackaged: app.isPackaged,
  exePath: process.execPath,
});
if (e2eUserDataDir !== undefined) {
  app.setPath('userData', e2eUserDataDir);
} else if (portableDir !== undefined) {
  app.setPath('userData', portableDir);
}

/** The keychain-backed secret store; never exposes values to the renderer (no `secrets.get`). */
const secretStore = new SecretStore(app.getPath('userData'), safeStorageBackend(safeStorage));
/** Session-only "show secrets" toggle, consulted by `redact.ts` via `request.send`. */
const showSecretsFlag = new ShowSecretsFlag();

/**
 * Every open window's own services (multi-window design D1): its workspace, picks, cookie jar,
 * current values, secret sources, team secrets, secret scans and audit reporter. See `createWindowScope`.
 */
interface WindowScope {
  readonly window: BrowserWindow;
  /** Captured at creation: a destroyed window's `webContents` can no longer be asked for its id. */
  readonly id: number;
  readonly picks: DialogPicks;
  readonly cookies: CookieStore;
  readonly currentValues: CurrentValuesStore;
  readonly secretSources: SecretSourcesService;
  /**
   * Team secrets for the window's open shared workspace. It writes this machine's keys and the team's
   * values into `secretStore` directly; everything the renderer saves goes through `teamSecretStore`,
   * which stores locally and then hands the value to the vault. Sign-in tokens, OAuth refresh tokens
   * and a cURL import stay on `secretStore`: they are this machine's, not the team's.
   */
  readonly teamSecrets: TeamSecretsService;
  readonly teamSecretStore: TeamSecretStore;
  readonly secretScans: SecretScanSessions;
  /** Reports the window's workspace's sends and test runs to its server's audit log (desktop audit events §2.4). */
  readonly audit: AuditReporter;
  readonly workspace: WorkspaceService;
  /** The reopen of the last workspace this window started with; resolved at once for one opened at the picker. */
  ready: Promise<void>;
  /** Whether the window's audit server was signed in at the last account change. */
  auditSignedIn: boolean;
  /** The window's own quit path, once started (`closeWindowScope`). */
  closing: Promise<void> | undefined;
}

const scopes = new WindowScopes<WindowScope>();

/** The user's application preferences, shared by every project and every window. */
const preferencesService = new PreferencesService(app.getPath('userData'), {
  // Managed machines: an administrator's policy file locks the settings it names (see `policy.ts`).
  policyFile: policyFilePath({ platform: process.platform, env: process.env, isPackaged: app.isPackaged }),
});

/**
 * The secret getter every send resolves through, for one project's `${secret:name}` tokens (or,
 * with no project, for plain refs only). Each value it hands out is recorded in `redact.ts`, so it
 * is masked in the HTTP log and History like any `Authorization` header. Team secrets gets a look
 * first: a value the vault holds that this machine cannot open refuses the send with why (waiting,
 * removed or declined) instead of the plain "not on this machine". Secret sources (spec D6) sit in
 * front of both.
 *
 * Team secrets and secret sources are the workspace's, so each ref is resolved through the window
 * whose workspace holds `projectId` (the caller's, for no project). With no such window, only the
 * plain store answers.
 */
const secretsFor = (projectId: string | undefined): GetSecret => {
  const plain = projectSecretGetter(secretStore, projectId, recordSecretValue);
  return async (ref) => {
    const scope =
      projectId === undefined
        ? scopes.callerOrOnly()
        : scopes.find((candidate) => candidate.workspace.projectId(projectId) !== undefined);
    if (scope === undefined) {
      return await plain(ref);
    }
    return await scope.secretSources.wrap(teamSecretGetter(plain, scope.teamSecrets, projectId))(ref);
  };
};

/**
 * The getter for the SSH area, composed as {@link secretsFor} is but reading the open workspace's scoped
 * entries (`wirebench-secret:workspace:<id>:<name>`) instead of a project's. Bound to the workspace open at call time.
 */
const sshSecretsFor = () =>
  secretSources.wrap(
    teamSecretGetter(
      workspaceSecretGetter(secretStore, scopes.callerOrOnly()?.workspace.openWorkspaceId(), recordSecretValue),
      teamSecrets,
      undefined,
    ),
  );

const sshSecrets = new SshSecretsService({
  store: secretStore,
  workspaceId: () => scopes.callerOrOnly()?.workspace.openWorkspaceId(),
  mappedNames: () => secretSources.mappedNames(),
});

/** The single in-process engine instance backing every `definition.*`/`request.*` channel. */
const engineService = new EngineService(secretsFor(undefined));
/** The sends in flight through the engine's `openExchange`, which `request.cancel` and a close reach. */
const exchanges = new ExchangeRegistry();
/** The request scripts' host (#63), created with the request channels once the app is ready. */
let scriptHost: ScriptHost | undefined;

/**
 * The picks preferences carry — the CA bundle and git executable chosen in Settings — which apply to
 * every window. Each window's own picks are built over it (`dialog-picks.ts`, design D4).
 */
const appPicks = new DialogPicks();
/** The calling window's native-dialog picks; see `dialog-picks.ts`. */
const dialogPicks = scoped(scopes, (scope) => scope.picks);
/** The calling window's workspace for workspace-level calls; for entity-addressed ones, the holder's (design D2). */
const workspaceService = routeWorkspaces(scopes, (scope) => scope.workspace);
/** Every mock this app is serving, across windows; each one's events go to the window that started it. */
const mockRunner = new MockRunner();

/** Opens an external URL, gated the same way for every flow that hands off to a browser. */
const openExternalChecked = async (url: string): Promise<void> => {
  if (!isExternalUrlAllowed(url)) {
    throw new WirebenchError('external-url-refused', 'That sign-in URL is not an http(s) address');
  }
  await shell.openExternal(url);
};

/**
 * OAuth2 tokens for the session, and the one loopback listener a browser sign-in answers to.
 *
 * The callback port comes from preferences because some providers insist on an exact redirect URI;
 * with none set the listener takes a random free port, which is what RFC 8252 prefers.
 */
const oauth2Service = new OAuth2Service({
  openExternal: openExternalChecked,
  callbackPort: () => preferencesService.get().rest.oauth2CallbackPort,
});

/**
 * Issued SAML tokens (WS-Trust) for the session: one cache every send borrows, never persisted.
 * The panel's lookup reads the entry and the request it is fetched for from the open project, and a
 * Fetch now logs its exchange with the token service as a send's does, with no send to link it to.
 */
const issuedTokensService: IssuedTokensService = new IssuedTokensService(
  async (locator): Promise<ResolvedIssuedToken> => {
    const resolved = await workspaceService.issuedTokenTarget(
      locator.projectId,
      locator.configId,
      locator.entryIndex,
      locator.requestId,
      // The getter a send of the project reads through: team secrets and `${secret:…}` refs resolve too.
      desktopSecrets({ secretsFor }, locator.projectId),
    );
    return {
      ...resolved,
      deps: {
        ...resolved.deps,
        onExchange: (http) => {
          try {
            const entry = stsLogEntry(http, {
              show: showSecretsFlag.get(),
              ...(locator.requestId !== undefined ? { requestId: locator.requestId } : {}),
            });
            emitToCaller(events.exchange.logged, { entry });
          } catch {
            // A broadcast that fails never becomes the token's lastError, as a send's STS row.
          }
        },
      },
    };
  },
);

/**
 * The CA bundle and proxy the server client last resolved, per server origin (live-updates R5).
 * `mainHttpOptions` is async, since it reads the bundle and may ask for a PAC answer, while a live
 * socket's `connect` is not. The socket therefore reuses what the HTTP calls resolved.
 * `LiveClient` asks `serverClient.meta` before it connects (§3.4), and every sync fetch refreshes the
 * entry. A server reachable over HTTP is then reachable over the socket, with the same trust and the
 * same proxy.
 */
const serverConnectOptions = new Map<string, ConnectOptions>();

/**
 * What a project-free send from main resolves its CA bundle and proxy from: the preferences, the
 * paths picked this session, the keychain and the system's PAC answer. The server client and the
 * definition fetcher share it, so the two never drift apart.
 */
const mainHttpDeps: MainHttpDeps = {
  preferences: () => preferencesService.get(),
  // Preferences are the app's, so the paths they name are app picks.
  picks: appPicks,
  getSecret: secretsFor(undefined),
  resolveSystemProxy: async (target) => await session.defaultSession.resolveProxy(target).catch(() => undefined),
};

/** The Wirebench Server HTTP client, shared by every account and every server it signs into. */
const serverClient = new ServerClient({
  options: async (origin) => {
    const options = await mainHttpOptions(origin, mainHttpDeps);
    serverConnectOptions.set(origin, options);
    return options;
  },
});

/** Who this installation is signed in as, per Wirebench Server (identity spec §3.8, §4.3). */
const accountService = new AccountService({
  userDataDir: app.getPath('userData'),
  client: serverClient,
  secrets: secretStore,
  openExternal: openExternalChecked,
  defaultDeviceName: hostname,
});

/** A server URL by origin, the way accounts are kept; `undefined` for text that is no server URL. */
function sameOrigin(url: string): string | undefined {
  try {
    return normalizeServerUrl(url);
  } catch {
    return undefined;
  }
}

/**
 * One live socket per signed-in server with an open workspace on it (live-updates §3.4), closed on
 * quit. It opens with the TLS and proxy `serverClient` last used for that server (R5): the key is the
 * socket URL's `http(s):` origin, which is the stored server origin the HTTP calls went to.
 */
const liveClients = new LiveClients({
  accounts: accountService,
  client: serverClient,
  connect: (wsUrl) => {
    const options: ConnectOptions = serverConnectOptions.get(new URL(wsUrl.replace(/^ws/, 'http')).origin) ?? {};
    return connectWebSocket(wsUrl, options);
  },
});

/**
 * Catch URLs and captures (webhook-capture §4.1): the server calls share `serverClient`'s CA bundle and
 * proxy, and the live nudges ride the same sockets as sync. Captures stay in memory, per open tab.
 */
const hooksService = new HooksService({
  client: serverClient,
  accounts: accountService,
  live: liveClients,
  emit: {
    changed: (event) => broadcast(events.hooks.changed, event),
    captured: (event) => broadcast(events.hooks.captured, event),
    captures: (event) => broadcast(events.hooks.captures, event),
  },
});

/** The session's in-flight OpenAPI and AsyncAPI reads: one cancel per token, one fetcher per read. */
const openApiImports = new OpenApiImportService({
  getSecret: secretsFor(undefined),
  // The preference-level CA bundle and proxy a project-free send uses: an import may target a project
  // that does not exist yet, and a definition has no client identity of its own.
  network: (url) => mainHttpOptions(url, mainHttpDeps),
});
const protoImports = new ProtoImportService({
  // A discovery from the Import dialog trusts what a send would: the configured CA bundle, plus the
  // user's own "trust this certificate anyway" for a development server.
  grpcTls: ({ trustInvalid }) => workspaceService.grpcDiscoveryTls(trustInvalid),
});

/** Sends one event to every open window: preferences, globals, accounts and the like are the app's. */
function broadcast<Payload extends z.ZodType>(event: IpcEvent<Payload>, payload: z.infer<Payload>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    emitEvent(window.webContents, event, payload);
  }
}

/**
 * Sends one event about a send to the window that started it, or to every window when it was not
 * started from one (design D3): one window's HTTP log is not another's.
 */
function emitToCaller<Payload extends z.ZodType>(event: IpcEvent<Payload>, payload: z.infer<Payload>): void {
  const scope = scopes.callerOrOnly();
  if (scope === undefined) {
    broadcast(event, payload);
  } else {
    emitEvent(scope.window.webContents, event, payload);
  }
}

/** Keeps one window's OS title in step with its workspace, as `name — Wirebench`. */
function applyWindowTitle(window: BrowserWindow, workspace: WorkspaceWire | null): void {
  if (!window.isDestroyed()) {
    window.setTitle(workspace === null ? 'Wirebench' : `${workspace.name} — Wirebench`);
  }
}

/** The user's `${#Global#name}` scope, shared by every project and every window. */
const globalProperties = new GlobalProperties(app.getPath('userData'));

/** The calling window's cookie jar (cookie jar spec §2); each window's follows its own workspace. */
const cookieStore = scoped(scopes, (scope) => scope.cookies);
/** The calling window's current values (cookie jar spec §5). */
const currentValues = scoped(scopes, (scope) => scope.currentValues);

/** Persistent request history — one jsonl file per open project under `userData`, watched for other writers. */
const historyService = new HistoryService(app.getPath('userData'), () => preferencesService.get().ui.historyCap, {
  watch: watchHistoryFile,
  onChanged: (projectId) => broadcast(events.history.changed, { projectId }),
});

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

/**
 * How long closing WebSocket sessions may hold up a project close or the quit while their History
 * entries are written. A socket that will not finish closing must not be the reason the app cannot
 * quit; past this the entry is the one thing lost, rather than the whole shutdown.
 */
const WS_SESSION_RECORD_TIMEOUT_MS = 2_000;

/** The calling window's team secrets, the store over them, and its secret sources and scans. */
const teamSecrets = scoped(scopes, (scope) => scope.teamSecrets);
const teamSecretStore = scoped(scopes, (scope) => scope.teamSecretStore);
const secretSources = scoped(scopes, (scope) => scope.secretSources);
const secretScans = scoped(scopes, (scope) => scope.secretScans);

/** The areas `WIREBENCH_AREAS` leaves switched on (see `areas.ts`). */
const enabledAreas = enabledAreasFromEnv();

// `hosts.yaml` in the open workspace's tree; dropped whenever the workspace changes (see the hooks below).
const hostsService = new HostsService({
  treeDir: () => {
    try {
      return workspaceService.treeDir();
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'workspace-not-found') return undefined; // none open
      throw error;
    }
  },
  onChanged: () => {
    broadcast(events.ssh.hostsChanged, {});
  },
});

/** The SSH sessions, each owned by the window that opened it; secrets resolve at connect, for the open workspace. */
const sshService = new SshService({
  hosts: hostsService,
  secretsFor: () => sshSecretsFor(),
  knownHostsFile: join(app.getPath('userData'), 'ssh-known-hosts.json'),
  agentSocket: () => (process.platform === 'win32' ? 'pageant' : process.env['SSH_AUTH_SOCK']),
  emit: emitEvent,
});

/** `workspace-state.json`, one queue for every window's workspace service. */
const workspaceState = new WorkspaceState(app.getPath('userData'));

/**
 * Builds one window's own services (design D1), every callback aimed at that window alone: its
 * workspace's events, cookies, current values, team secrets and title (design D3). `sweepJoining`:
 * only the launch's first window empties `.joining/`.
 */
function createWindowScope(window: BrowserWindow, sweepJoining: boolean): WindowScope {
  const target = window.webContents;
  const send = <Payload extends z.ZodType>(event: IpcEvent<Payload>, payload: z.infer<Payload>): void => {
    emitEvent(target, event, payload);
  };
  const picks = new DialogPicks(appPicks);
  // Only a switch of this window's workspace (or a close) ends this window's SSH sessions; a rename or
  // reload does not, and another window's sessions are its own workspace's.
  const endSshOnSwitch = sshSessionsEndOnSwitch(sshService, target);
  const teamSecrets = new TeamSecretsService({
    store: secretStore,
    onChanged: (workspaceId, status) => {
      send(events.teamSecrets.changed, { workspaceId, status });
    },
    log: (message) => {
      console.warn(message);
    },
  });
  const teamSecretStore = new TeamSecretStore(secretStore, teamSecrets);
  // Saved encrypted with the keychain, or not at all; every change reaches the window as `cookies.changed`.
  const cookies = new CookieStore({
    userDataDir: app.getPath('userData'),
    crypto: safeStorageBackend(safeStorage),
    onChanged: (state) => {
      send(events.cookies.changed, state);
    },
    warn: (message) => {
      console.warn(`[cookies] ${message}`);
    },
  });
  // In memory per workspace, never written anywhere.
  const currentValues = new CurrentValuesStore((state) => {
    send(events.currentValues.changed, state);
  });
  currentValues.syncGlobals(globalProperties.get());
  const audit = new AuditReporter({
    client: serverClient,
    accounts: accountService,
    now: () => new Date(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });
  // Both read the workspace service built below, only once something is asked of them.
  const secretSources = new SecretSourcesService({
    snapshot: () => workspace.secretSourcesSnapshot(),
    cacheSeconds: () => preferencesService.get().secrets.sourceCacheSeconds,
    onValue: recordSecretValue,
    mask: redactSecretText,
  });
  const secretScans: SecretScanSessions = new SecretScanSessions({
    host: (projectId) => workspace.hostFor(projectId),
    store: teamSecretStore,
    holdAutosave: (projectId) => workspace.hostFor(projectId).holdAutosave(),
  });
  const workspace: WorkspaceService = new WorkspaceService({
    userDataDir: app.getPath('userData'),
    state: workspaceState,
    sweepJoining,
    // One workspace, one window (design D5): the window holding it is brought forward instead.
    heldElsewhere: (workspaceId) => {
      const holder = scopes
        .all()
        .find((other) => other.window !== window && other.workspace.snapshot()?.id === workspaceId);
      if (holder === undefined) {
        return false;
      }
      if (!holder.window.isDestroyed()) {
        if (holder.window.isMinimized()) {
          holder.window.restore();
        }
        holder.window.focus();
      }
      return true;
    },
    // Located afresh for each shared workspace that opens, so a git installed (or picked in
    // Settings) since the last open is found without a restart.
    git: async () => {
      const location = await gitLocator();
      return location === undefined ? undefined : new GitCli(location, { hooksDir });
    },
    hooksDir,
    // A server share syncs through the same client and accounts as sign-in and the Team dialog; the
    // accounts' `ready` and `onChange` gate and resume its polling (server-sync §3.4, §5.3), and the
    // live clients turn a teammate's push or an access change into a fetch at once (live-updates §3.4).
    server: { client: serverClient, accounts: accountService, live: liveClients },
    engine: engineService,
    globals: globalProperties,
    secrets: secretStore,
    teamSecrets,
    preferences: preferencesService,
    picks,
    issuedTokens: issuedTokensService.source,
    history: historyService,
    currentValues,
    // A session's History entry is written by its own pending `request.openWs`, so a project (or a
    // whole workspace) closing has to ask the sockets to close *and* wait for the entries before
    // the history files go with it.
    // Only this window's: another window's sockets and sends are none of this workspace's business.
    closeWsSessions: async (projectId) => {
      const matches =
        projectId === undefined
          ? (id: string) => workspace.projectId(id) !== undefined
          : (id: string) => workspace.projectId(id) === projectId;
      exchanges.endWhere(matches, 'websocket');
      // The whole workspace is going and no other window has one open: the REST checker worker goes
      // with it (the next check starts one).
      if (
        projectId === undefined &&
        !scopes.all().some((other) => other.window !== window && other.workspace.snapshot() !== null)
      ) {
        void engineService.disposeRestContractChecker().catch((error: unknown) => {
          console.warn(
            '[rest] ending the contract checker failed',
            error instanceof Error ? error.message : String(error),
          );
        });
      }
      // An event stream open on a REST request is the same kind of thing: stopped here (with any other
      // REST send of the project still in flight), and its History entry — written by its own pending
      // `request.sendRest` — waited for alongside.
      exchanges.endWhere(matches, 'rest');
      // A mock goes with its project; a whole workspace closing takes every mock this window started.
      const owner = window.webContents.id;
      const stoppingMocks = mockRunner.stopWhere((entry) =>
        projectId === undefined ? entry.owner === owner : entry.projectId === projectId,
      );
      // Always awaited, never guarded by "did we just close anything": a session already asked to
      // close is not closed again, yet its pending `request.openWs` may not have written the History
      // entry. A session that closed a moment ago is therefore invisible here while its write is
      // still in flight, and skipping the wait would race it against `history.close`.
      // `whenWsSessionsRecorded` returns immediately when nothing matches, so this costs nothing.
      // Every other send through the engine — a resend, a sequence step, a multi-environment child —
      // is waited for the same way.
      await Promise.all([
        whenWsSessionsRecorded(WS_SESSION_RECORD_TIMEOUT_MS, matches),
        whenRestSendsRecorded(WS_SESSION_RECORD_TIMEOUT_MS, matches),
        exchanges.whenRecorded(WS_SESSION_RECORD_TIMEOUT_MS, matches),
        stoppingMocks,
      ]);
    },
    trash: trashFolder,
    // "System proxy" means whatever Chromium's own network stack means by it — including any PAC
    // file or OS setting — rather than a second, subtly different guess of our own.
    resolveSystemProxy: async (url) => await session.defaultSession.resolveProxy(url).catch(() => undefined),
    // Read lazily: the scan sessions are built against this very service.
    secretScans: {
      findings: (projectId): number => secretScans.findings(projectId),
      onChange: (listener): (() => void) => secretScans.onChange(listener),
    },
    hooks: {
      onChanged: (snapshot) => {
        send(events.workspace.changed, { workspace: snapshot });
        applyWindowTitle(window, snapshot);
        void cookies.switchTo(snapshot?.id ?? null).catch((error: unknown) => {
          console.warn('[cookies] switching jars failed', error instanceof Error ? error.message : String(error));
        });
        currentValues.syncWorkspace(snapshot);
        secretSources.noteChange();
        hostsOnWorkspaceChange(enabledAreas, hostsService, () => {
          broadcast(events.ssh.hostsChanged, {});
        });
        // A session belongs to the workspace it was opened in; its credentials were that workspace's.
        endSshOnSwitch(snapshot?.id);
      },
      onDeleted: (workspaceId) => {
        void cookies.deleteWorkspace(workspaceId).catch(() => undefined);
        currentValues.forgetWorkspace(workspaceId);
      },
      onProjectChanged: (projectId, project) => {
        secretScans.projectChanged(projectId, project);
        // A running mock follows its edits: restarted with the new definition, or stopped when removed.
        let model;
        try {
          model = project === null ? undefined : workspace.hostFor(projectId).model();
        } catch {
          model = undefined;
        }
        void mockRunner.projectChanged(projectId, model);
        currentValues.syncProject(projectId, project);
        send(events.project.changed, { projectId, project });
      },
      onProjectChangedOnDisk: (projectId, paths) => {
        send(events.project.changedOnDisk, { projectId, paths: [...paths] });
      },
      onHydration: (projectId, event) => {
        send(events.project.hydration, { projectId, ...event });
      },
      onProgress: (progress) => {
        send(events.engine.progress, progress);
      },
      onHostsFileChanged: () => {
        hostsService.invalidate();
        broadcast(events.ssh.hostsChanged, {});
      },
      onWorkspaceChangedOnDisk: (workspaceId, paths, message) => {
        send(events.workspace.changedOnDisk, { workspaceId, paths: [...paths], message });
      },
      onSyncStatus: (workspaceId, status) => {
        send(events.sync.statusChanged, { workspaceId, status });
      },
      onSyncPulled: (event) => {
        send(events.sync.pulled, event);
      },
      onSyncConflict: (workspaceId, conflicts) => {
        send(events.sync.conflict, { workspaceId, conflicts: [...conflicts] });
      },
      onGitIdentityNeeded: (workspaceId) => {
        send(events.git.identityNeeded, { workspaceId });
      },
      onAuditTarget: (auditTarget, fetched) => {
        audit.setTarget(auditTarget);
        // A fetch went through with this account's token: it is signed in, and the queue goes out now,
        // at the pace of any back-off already under way.
        if (auditTarget !== undefined && fetched) {
          void audit.afterFetch();
        }
      },
    },
  });
  return {
    window,
    id: target.id,
    picks,
    cookies,
    currentValues,
    secretSources,
    teamSecrets,
    teamSecretStore,
    secretScans,
    audit,
    workspace,
    ready: Promise.resolve(),
    auditSignedIn: false,
    closing: undefined,
  };
}

/** The window's account is signed in to the server its workspace reports audit events to. */
function auditSignedInFor(
  scope: WindowScope,
  servers: readonly { readonly url: string; readonly signedOut?: boolean | undefined }[],
): boolean {
  const target = scope.workspace.auditTarget();
  const origin = target === undefined ? undefined : sameOrigin(target.url);
  return (
    origin !== undefined && servers.some((account) => sameOrigin(account.url) === origin && account.signedOut !== true)
  );
}

// The product name, set before `ready` so the macOS application menu (`role: 'appMenu'`) and
// the About panel read "Wirebench" in development too. A packaged bundle already carries it as
// `productName` (CFBundleName); without this, a `pnpm dev` run shows Electron's own name.
app.setName('Wirebench');
app.setAboutPanelOptions({ applicationName: 'Wirebench', applicationVersion: appVersion() });

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.wirebench.desktop');
  registerAppProtocol();

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Created once, up front, so it exists before any sync operation can start (see `hooksDir`).
  mkdirSync(hooksDir, { recursive: true });

  const updates = createUpdateController(
    (status) => {
      broadcast(events.app.updateStatus, { status });
    },
    { portable: e2eUserDataDir === undefined && portableDir !== undefined },
  );
  setUpKerberos({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  registerKerberosChannels();
  registerAppChannels(
    undefined,
    async () => await updates.check({ trigger: 'user' }),
    // New Window (design D7) opens at the picker.
    () => {
      openWindow({ reopenLast: false });
    },
    enabledAreas,
  );
  // The calling window's open projects' folders: the containment roots a renderer-named import path may sit in.
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
  // Request scripts (#63): one sandbox and one checker for the app, started on first use.
  const scripts = new ScriptHost({
    modelOf: (entityId) =>
      workspaceService.projectId(entityId) === undefined ? undefined : workspaceService.hostOfEntity(entityId).model(),
    openApiDocumentFor: async (apiId) => await workspaceService.hostOfEntity(apiId).openApiDocumentFor(apiId),
    grpcProtoSetFor: async (apiId) => await workspaceService.grpcProtoSetFor(apiId),
    soapDefinitionFor: (interfaceId) => engineService.resultFor(interfaceId),
    onValuesChanged: (projectId) => {
      emitToCaller(events.script.valuesChanged, { projectId });
    },
  });
  scriptHost = scripts;
  registerScriptChannels(scripts);
  const requestDeps: RequestChannelDeps = {
    project: workspaceService,
    secretSources: () => workspaceService.secretSourcesSnapshot(),
    adHocScopes: () => {
      const state = globalProperties.get();
      const global = overlayCurrent(
        enabledProperties(state.properties, state.disabled),
        currentValues.overlaysFor(undefined).global,
      );
      return { project: {}, global, system: process.env };
    },
    showSecrets: showSecretsFlag,
    cookies: () => cookieStore.host(),
    history: historyService,
    onHistoryAppended: (entry) => {
      emitToCaller(events.history.appended, { entry });
    },
    onSendFailed: (failure) => {
      emitToCaller(events.exchange.failed, { failure });
    },
    onExchange: (entry) => {
      emitToCaller(events.exchange.logged, { entry });
    },
    preferences: preferencesService,
    dialogPicks,
    oauth2: oauth2Service,
    issuedTokens: issuedTokensService,
    getSecret: secretsFor(undefined),
    storeSecret: (value, label) => secretStore.set(value, { label }),
    secretsFor,
    scripts,
    registry: exchanges,
    // Queued to the outbox of the window whose workspace it happened in; that reporter drops it unless
    // the workspace records. A run that ends after its workspace closed is credited to no window.
    audit: (event, workspaceId) => {
      const scope = scopes.all().find((candidate) => candidate.audit.workspaceId === workspaceId);
      void scope?.audit.enqueue(event, workspaceId);
    },
    auditWorkspace: () => scopes.callerOrOnly()?.audit.workspaceId,
  };
  registerRequestChannels(engineService, requestDeps);
  registerMockChannels(mockRunner, {
    locate: (mockId) => {
      const projectId = workspaceService.projectId(mockId);
      const saved = workspaceService.hostOfEntity(mockId).savedProject();
      if (projectId === undefined || saved === undefined) {
        throw new WirebenchError('mock-not-found', `No open project has the mock ${mockId}`, { details: { mockId } });
      }
      return { projectId, project: saved.project, dir: saved.dir };
    },
    host: () => (preferencesService.get().mocks.listenOnAllInterfaces ? MOCK_ALL_INTERFACES_HOST : MOCK_LOOPBACK_HOST),
    owns: (mockId) => workspaceService.projectId(mockId) !== undefined,
  });
  // A sequence's steps go through the engine as a single send does, with the same dependencies.
  registerSequenceChannels(new SequenceRunner(), {
    service: engineService,
    requests: requestDeps,
    modelOf: (entityId) => workspaceService.hostOfEntity(entityId).model(),
    emit: (event) => {
      emitToCaller(events.sequence.progress, event);
    },
    emitWaiting: (event) => {
      emitToCaller(events.sequence.waiting, event);
    },
    // Read per run: the workspace, its link and the account can all change between runs.
    captures: () =>
      desktopCaptureSource(
        { client: serverClient, accounts: accountService },
        linkedServerOf(workspaceService.snapshot()),
      ),
  });
  registerOAuth2Channels({
    oauth2: oauth2Service,
    project: workspaceService,
    getSecret: secretsFor(undefined),
    // A refresh token replaces the value the configuration's own reference already names; a new
    // reference is never minted here, because the project file would then have to change to match.
    setSecret: async (ref, value) => {
      await secretStore.replace(ref, value);
    },
    showSecrets: showSecretsFlag,
  });
  registerIssuedTokenChannels({ issuedTokens: issuedTokensService, showSecrets: showSecretsFlag });
  registerAccountChannels({ accounts: accountService });
  registerTeamChannels({ client: serverClient, accounts: accountService });
  registerCiTokenChannels({ client: serverClient, accounts: accountService });
  registerLicenseChannels({ client: serverClient, accounts: accountService });
  registerAuditChannels({ client: serverClient, accounts: accountService, picks: dialogPicks });
  registerHooksChannels({ hooks: hooksService });
  accountService.onChange((servers) => broadcast(events.account.changed, { servers: servers.map(toAccountWire) }));
  // Signing in to a window's workspace's server sends what its audit outbox kept while signed out.
  accountService.onChange((servers) => {
    for (const scope of scopes.all()) {
      const signedIn = auditSignedInFor(scope, servers);
      if (signedIn && !scope.auditSignedIn) {
        void scope.audit.onSignedIn();
      }
      scope.auditSignedIn = signedIn;
    }
  });
  // One `GET /me` per signed-in account at launch, so a token revoked while the app was closed
  // shows as signed out now rather than on the first action; no account, no call (§3.8).
  void accountService
    .load()
    .then(() => accountService.refreshAll())
    // A launch-time failure here (a corrupt accounts file, a keychain error) must not surface as
    // an unhandled rejection; accountService already reports per-account sign-in state via
    // onChange, so there is nothing further to log and never a token to log.
    .catch(() => {});
  // A resend is a send like any other: the request channels' dependencies, scripts and registry.
  registerHistoryChannels(historyService, {
    project: workspaceService,
    send: toSendDeps(engineService, requestDeps),
    // One window's History is its own workspace's projects (another window may have others open).
    projectIds: () =>
      scopes
        .callerOrOnly()
        ?.workspace.hosts()
        .flatMap((host) => {
          const id = host.snapshot()?.id;
          return id === undefined ? [] : [id];
        }),
  });
  registerProjectChannels({
    router: workspaceService,
    addProject: async (name) => await workspaceService.addProject(name),
    removeProject: async (projectId, options) => {
      // A closed project's session values go with it.
      scripts.clearValues(projectId);
      return await workspaceService.removeProject(projectId, options);
    },
    projectDirs: openProjectDirs,
    picks: dialogPicks,
    ensureWorkspaceEnvironments: async (names) => await workspaceService.ensureEnvironments(names),
  });
  /** A Globals change, told to every window and to every window's current-values overlay. */
  const onGlobalsChanged = (state: ReturnType<GlobalProperties['get']>): void => {
    broadcast(events.globals.changed, state);
    for (const scope of scopes.all()) {
      scope.currentValues.syncGlobals(state);
    }
  };
  registerApiChannels({
    router: workspaceService,
    imports: openApiImports,
    asyncApiImports: openApiImports,
    protoImports,
    addProject: async (name) => await workspaceService.addProject(name),
    removeProject: async (projectId, options) => {
      // A closed project's session values go with it.
      scripts.clearValues(projectId);
      return await workspaceService.removeProject(projectId, options);
    },
    projectDirs: openProjectDirs,
    picks: dialogPicks,
    history: historyService,
    onHistoryChanged: (projectId) => broadcast(events.history.changed, { projectId }),
    // Every read goes to the live workspace, so a second environment of the same name in one
    // import sees the first one and is given a free name.
    variablesPorts: (projectId) => ({
      workspace: {
        environmentNames: () =>
          (workspaceService.snapshot()?.environments ?? []).map((environment) => environment.name),
        addEnvironment: async (name, properties, disabled) => {
          const { createdEnvironmentId } = await workspaceService.mutate({ kind: 'add-workspace-environment', name });
          if (createdEnvironmentId === undefined) {
            throw new WirebenchError('import-failed', `Could not add the environment "${name}"`);
          }
          try {
            await workspaceService.mutate({
              kind: 'update-workspace-environment',
              environmentId: createdEnvironmentId,
              patch: { properties, disabled: [...disabled] },
            });
          } catch (error) {
            // Adding is two saves: do not leave the empty environment of the first behind.
            await workspaceService
              .mutate({ kind: 'remove-workspace-environment', environmentId: createdEnvironmentId })
              .catch(() => undefined);
            throw error;
          }
        },
        removeEnvironment: async (name) => {
          const environment = workspaceService.snapshot()?.environments.find((candidate) => candidate.name === name);
          if (environment === undefined) return;
          await workspaceService.mutate({ kind: 'remove-workspace-environment', environmentId: environment.id });
        },
        propertyNames: () => Object.keys(workspaceService.snapshot()?.properties ?? {}),
        mergeProperties: async (properties, disabled) => {
          for (const [name, value] of Object.entries(properties)) {
            await workspaceService.mutate({ kind: 'set-workspace-property', name, value });
          }
          for (const name of disabled) {
            await workspaceService.mutate({ kind: 'set-workspace-property-enabled', name, enabled: false });
          }
        },
      },
      globals: {
        get: () => globalProperties.get(),
        merge: async (properties, disabled) => {
          let state = await globalProperties.replaceAll({ ...globalProperties.get().properties, ...properties });
          for (const name of disabled) {
            state = await globalProperties.setEnabled(name, false);
          }
          onGlobalsChanged(state);
        },
      },
      ...(projectId !== undefined
        ? {
            project: {
              propertyNames: () => Object.keys(workspaceService.hostFor(projectId).model()?.properties ?? {}),
              merge: async (properties, disabled) => {
                await workspaceService.importProperties(projectId, properties, disabled);
              },
            },
          }
        : {}),
      secrets: teamSecretStore,
    }),
  });
  registerWorkspaceChannels({
    service: workspaceService,
    suggestions: async () => await readLeftoverProjectFolders(app.getPath('userData')),
    // The calling window's reopen of the last workspace (see `openWindow`).
    ready: () => scopes.callerOrOnly()?.ready ?? Promise.resolve(),
    reveal: (dir) => {
      shell.showItemInFolder(dir);
    },
  });
  registerGlobalsChannels(globalProperties, onGlobalsChanged);
  registerCurrentValuesChannels(currentValues);
  registerCookiesChannels(cookieStore);
  registerPreferencesChannels(preferencesService, (preferences) => {
    broadcast(events.preferences.changed, { preferences });
    // Turning autosave on mid-session must pick up whatever is already outstanding, rather than
    // waiting for one more edit to arm the timer.
    if (preferences.editor.autosave) {
      for (const scope of scopes.all()) {
        for (const host of scope.workspace.hosts()) {
          host.onAutosaveEnabled();
        }
      }
    }
  });
  // Settings picks are the app's: preferences apply to every window (design D4).
  registerSslChannels({
    preferences: preferencesService,
    picks: appPicks,
    onChanged: (preferences) => {
      broadcast(events.preferences.changed, { preferences });
    },
  });
  registerGitChannels({
    preferences: preferencesService,
    picks: appPicks,
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
  registerSecretsChannels(teamSecretStore, showSecretsFlag);
  registerSecretSourcesChannels(workspaceService, secretSources);
  registerTeamSecretsChannels(teamSecrets);
  registerSecretScanChannels(secretScans);
  registerSnapshotChannels(
    new SnapshotStore((requestId) => {
      const projectId = workspaceService.projectId(requestId);
      if (projectId === undefined) {
        return undefined;
      }
      // `projectId` never throws; a stale index entry (no host for it) reads as unsaved, not an error.
      try {
        return workspaceService.hostFor(projectId).savedProject();
      } catch {
        return undefined;
      }
    }),
  );
  registerExchangeChannels(engineService.exchanges, showSecretsFlag);
  registerLogChannels({
    showSecrets: showSecretsFlag,
    service: engineService,
    request: requestDeps,
    picks: dialogPicks,
    appVersion: appVersion(),
  });
  registerAttachmentChannels({
    exchanges: engineService.exchanges,
    project: workspaceService,
    picks: dialogPicks,
    userDataDir: app.getPath('userData'),
  });
  registerKeystoreChannels({ project: workspaceService, picks: dialogPicks });
  registerCertificateChannels({ project: workspaceService, preferences: preferencesService });
  registerWsaChannels({ project: workspaceService });
  registerWssChannels({ project: workspaceService });
  registerEnabledAreaChannels(enabledAreas, { hosts: hostsService, secrets: sshSecrets, ssh: sshService });
  // Last session's decrypted attachment copies are disposable; sweep them off the disk without
  // making the first window wait on it.
  void clearAttachmentsTmp(app.getPath('userData'));
  // Warms the in-memory map so the first send does not have to wait on a disk read, and corrects
  // any early `globals.get` subscriber that raced ahead of the load with the on-disk properties.
  void globalProperties.load().then(
    (state) => {
      broadcast(events.globals.changed, state);
      // The committed globals a global current value needs, once the file has been read.
      for (const scope of scopes.all()) {
        scope.currentValues.syncGlobals(state);
      }
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
    rememberPickedCaBundle(preferences, appPicks);
    // Same evidence, same reason, for a git executable main itself picked (`git.pathPickedByMain`).
    rememberPickedGit(preferences, appPicks);
    const policy = preferencesService.policy();
    if (policy.error !== undefined) {
      console.error(`Managed-preferences policy ${policy.path} not applied: ${policy.error}`);
    }
    if (policy.ignored.length > 0) {
      console.warn(`Managed-preferences policy ${policy.path} ignores: ${policy.ignored.join(', ')}`);
    }
    broadcast(events.preferences.changed, { preferences: toPreferencesWire(preferences) });
  });
  const first = openWindow({ reopenLast: true });

  // Opt-in, and only after the preferences are actually loaded — the default is off, so a
  // check that ran before the load would read "off" for every user who turned it on.
  void first.ready.then(async () => {
    await updates.checkOnLaunch(() => preferencesService.get().updates.checkOnLaunch);
  });

  // The first window after every one closed (macOS) picks up where the last left off, as at launch.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openWindow({ reopenLast: true });
    }
  });
});

/** Set once the app's quit path ran: the windows then close without each running its own again. */
let quitting = false;
/** Whether a window has been opened this launch; only the first sweeps `.joining/`. */
let openedOne = false;

/**
 * Opens a window with its own services (design D1, D6). `reopenLast` reopens the last workspace, as
 * the launch's first window does; New Window opens at the picker. Closing the window runs the quit
 * path for it alone before it goes.
 */
function openWindow(options: { readonly reopenLast: boolean }): WindowScope {
  const window = createMainWindow();
  const scope = createWindowScope(window, !openedOne);
  openedOne = true;
  scopes.add(scope.id, scope);
  if (options.reopenLast) {
    // It waits for preferences (every host folds them into its send defaults, and a workspace
    // opened before the load would hold the defaults), and a workspace that will not open is not
    // an error the app dies of: the picker shows `lastError()`. `workspace.snapshot`/`list` wait on
    // it, so the renderer's first answer is already the reopened workspace (or the picker with its
    // error), never a flash of both.
    scope.ready = preferencesService.ready().then(async () => {
      await scope.workspace.openLast().catch(() => null);
    });
  }
  applyWindowTitle(window, null);
  window.on('close', (event) => {
    if (quitting) {
      return;
    }
    // The window stays until its workspace has kept what is unsaved; a second close waits too.
    event.preventDefault();
    void closeWindowScope(scope).finally(() => {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    });
  });
  window.on('closed', () => {
    scopes.remove(scope.id);
  });
  return scope;
}

/**
 * The quit path for one window (design D6): it hands over its staged request edits (briefly — a hung
 * window cannot hold the close), then its workspace closes, recording every open project's unsaved
 * state, and its cookie jar and audit reporter wind down. Runs once per window.
 */
function closeWindowScope(scope: WindowScope): Promise<void> {
  scope.closing ??= (async () => {
    if (!scope.window.isDestroyed()) {
      const stashed = scope.workspace.nextDraftsStash(QUIT_DRAFTS_TIMEOUT_MS);
      emitEvent(scope.window.webContents, events.workspace.flushDrafts, {});
      await stashed.catch(() => undefined);
    }
    // Its timers must not hold up the close; what is queued stays in the outbox for the next open.
    scope.audit.dispose();
    try {
      await scope.workspace.close();
    } finally {
      // Cookies with an expiry still waiting on the debounce are written before the window goes,
      // even when closing the workspace failed.
      await scope.cookies.flush().catch(() => undefined);
      scope.cookies.dispose();
      scope.workspace.dispose();
    }
  })().catch(() => undefined);
  return scope.closing;
}

// Quitting writes nothing to a project. Unsaved changes are kept with the workspace instead
// and come back, still unsaved, the next time it opens (`unsaved-store.ts`): every window runs its
// own quit path (`closeWindowScope`) at once, then the app goes.
const QUIT_DRAFTS_TIMEOUT_MS = 2_000;
let quitStashDone = false;
app.on('before-quit', (event) => {
  if (quitStashDone) {
    return;
  }
  event.preventDefault();
  quitting = true;
  // Asked to close here so the sockets are already closing while the drafts are stashed; the
  // *waiting* — for each session's History entry, written by its own pending `request.openWs` —
  // happens inside each workspace's `close()`, which owns the history files. Guarded: a
  // failure to close a socket must never be the reason the app fails to quit.
  try {
    exchanges.endWhere(() => true, 'websocket');
  } catch (error) {
    console.warn('[ws] closeAllWs on quit failed', error instanceof Error ? error.message : String(error));
  }
  // The catch URL views and their subscriptions go first; nothing of them outlives the process.
  hooksService.dispose();
  // SSH sessions end with the app; closing never throws or waits.
  sshService.disposeAll();
  // A mock's port is released now; not awaited, so a server that will not close never holds up the quit.
  void mockRunner.stopAll().catch((error: unknown) => {
    console.warn('[mock] stopping the mocks on quit failed', error instanceof Error ? error.message : String(error));
  });
  // The live sockets close 1000, so the server drops this device from presence now rather than at
  // its next heartbeat (live-updates §3.4). Not awaited: a socket that will not close must never
  // hold up the quit.
  void liveClients.closeAll().catch((error: unknown) => {
    console.warn(
      '[live] closing the live sockets on quit failed',
      error instanceof Error ? error.message : String(error),
    );
  });
  try {
    exchanges.endWhere(() => true, 'rest');
  } catch (error) {
    console.warn('[rest] aborting streams on quit failed', error instanceof Error ? error.message : String(error));
  }
  // Nor may the script sandbox's and checker's.
  void scriptHost?.dispose().catch((error: unknown) => {
    console.warn(
      '[script] ending the script workers on quit failed',
      error instanceof Error ? error.message : String(error),
    );
  });
  // The REST contract checker's worker thread must not keep the process alive past quit.
  void engineService.disposeRestContractChecker().catch((error: unknown) => {
    console.warn(
      '[rest] ending the contract checker on quit failed',
      error instanceof Error ? error.message : String(error),
    );
  });
  void Promise.all(scopes.all().map(async (scope) => await closeWindowScope(scope)))
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
